/**
 * server.ts — the public read API.
 *
 * Four routes, all GET, no authentication, no writes. The Sui service also carried a
 * `PUT /competitions/:id/bind` guarded by an admin token, which is where a competition's title,
 * template and portfolio were configured; that whole concept is gone, so the token, the
 * constant-time compare and the `x-competition-admin` header went with it. What remains is a
 * process that can only read the chain, which is the strongest thing that can be said about a
 * service exposed to a browser.
 *
 * THE CACHE IS LOAD-BEARING, not an optimisation. Every list response is one log scan per
 * competition against a rate-limited public RPC, and a dashboard polling every few seconds would
 * otherwise turn one visitor into a sustained request storm. The Sui version cached for the same
 * reason and had a cheaper backend.
 */

import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { Hex } from 'viem';
import type { CompetitionDetail, CompetitionSummary } from './dto.js';
import type { CompetitionReader } from './reader.js';
import type { Registry, RegistryStats } from './registry.js';

/** How long a served read stays fresh. Long enough to absorb a polling dashboard. */
const READ_TTL_MS = 5_000;

export interface ServerDeps {
    readonly registry: Registry;
    readonly reader: CompetitionReader;
    readonly chainId: number;
    readonly sealedCompetition: string;
    readonly corsOrigin: string;
    readonly port: number;
    readonly log?: (line: string) => void;
}

export interface RunningServer {
    readonly app: Express;
    readonly server: Server;
    readonly close: (done: () => void) => void;
}

const isBytes32 = (value: string): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value);

/**
 * A tiny TTL memo with in-flight de-duplication.
 *
 * Two details that look like fussiness and are not. The entry is stamped when the build FINISHES,
 * not when it started: a build slower than the TTL would otherwise be stale the moment it lands,
 * so every request rebuilds and the cache silently stops existing. And a build in progress is
 * shared rather than started again, because the failure this cache exists to prevent is N
 * concurrent viewers each launching their own full pass over the chain.
 */
function makeCache<T>(ttlMs: number) {
    const store = new Map<string, { at: number; value: T }>();
    const inFlight = new Map<string, Promise<T>>();
    return {
        async get(key: string, build: () => Promise<T>): Promise<T> {
            const hit = store.get(key);
            if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value;

            const pending = inFlight.get(key);
            if (pending !== undefined) return pending;

            const promise = build()
                .then((value) => {
                    store.set(key, { at: Date.now(), value });
                    return value;
                })
                .finally(() => inFlight.delete(key));
            inFlight.set(key, promise);
            return promise;
        },
        /** Drop entries nobody has asked for since the last sweep, so the map cannot grow forever. */
        prune(): void {
            const cutoff = Date.now() - ttlMs * 10;
            for (const [key, hit] of store) if (hit.at < cutoff) store.delete(key);
        },
    };
}

export function makeServer(deps: ServerDeps): RunningServer {
    const app = express();
    const listCache = makeCache<CompetitionSummary[]>(READ_TTL_MS);
    const detailCache = makeCache<CompetitionDetail | undefined>(READ_TTL_MS);
    const prune = setInterval(() => {
        listCache.prune();
        detailCache.prune();
    }, 60_000);
    prune.unref();

    // Hand-rolled rather than the `cors` package: three headers, GET and OPTIONS only. The Sui
    // version also allowed POST, PUT and the admin header, none of which exist here.
    app.use((req: Request, res: Response, next) => {
        res.setHeader('Access-Control-Allow-Origin', deps.corsOrigin);
        res.setHeader('Access-Control-Allow-Headers', 'content-type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }
        next();
    });

    app.get('/health', (_req, res) => {
        const stats: RegistryStats = deps.registry.stats();
        // 200 even while a scan is failing: the process is up and serving what it has, and a health
        // check that flaps with the public RPC teaches an operator to ignore it.
        res.json({
            ok: true,
            chainId: deps.chainId,
            sealedCompetition: deps.sealedCompetition,
            competitions: stats.competitions,
            tailing: stats.tailing,
            indexedThroughBlock: stats.indexedThroughBlock,
            lastScanAt: stats.lastScanAt,
            ...(stats.lastScanError === undefined ? {} : { lastScanError: stats.lastScanError }),
        });
    });

    /** The successor of the Sui `/status`: service state, not an unbounded log of past work. */
    app.get('/status', (_req, res) => {
        res.json({
            ...deps.registry.stats(),
            uptimeSecs: Math.floor(process.uptime()),
        });
    });

    app.get('/competitions', (_req, res) => {
        void (async () => {
            try {
                const competitions = await listCache.get('all', async () => {
                    const built: CompetitionSummary[] = [];
                    // Serially, not in parallel: history comes from the index, but each entry
                    // still costs two live contract reads, and firing every competition's reads at
                    // once is how a list request returns 429s instead of competitions.
                    for (const entry of deps.registry.list()) {
                        const summary = await deps.reader.summary(entry);
                        if (summary !== undefined) built.push(summary);
                    }
                    return built;
                });
                res.json({ competitions });
            } catch (err) {
                deps.log?.(`[competition] GET /competitions: ${message(err)}`);
                res.status(502).json({ error: 'chain read failed', detail: message(err) });
            }
        })();
    });

    app.get('/competitions/:id', (req, res) => {
        void (async () => {
            const raw = req.params.id ?? '';
            if (!isBytes32(raw)) {
                res.status(400).json({ error: 'competition id must be 0x-prefixed 32-byte hex' });
                return;
            }
            // Lowercased before it touches the index or the cache. Ids in the index come from
            // decoded logs and are always lowercase, so a checksummed id from a link or a block
            // explorer would miss and 404 a competition that is right there.
            const id = raw.toLowerCase() as Hex;
            try {
                const detail = await detailCache.get(id, async () => {
                    // The index answers instantly for anything it has seen; `discover` is the
                    // fallback for a direct link to something below FROM_BLOCK or missed by a
                    // failed scan.
                    const entry = deps.registry.get(id) ?? (await deps.registry.discover(id));
                    if (entry === undefined) return undefined;
                    return deps.reader.detail(entry);
                });
                if (detail === undefined) {
                    res.status(404).json({ error: 'unknown competition' });
                    return;
                }
                res.json(detail);
            } catch (err) {
                deps.log?.(`[competition] GET /competitions/${id}: ${message(err)}`);
                res.status(502).json({ error: 'chain read failed', detail: message(err) });
            }
        })();
    });

    const server = app.listen(deps.port, () => {
        deps.log?.(`[competition] read API on :${deps.port}`);
    });

    return {
        app,
        server,
        close(done) {
            clearInterval(prune);
            server.close(() => done());
        },
    };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
