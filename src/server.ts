/**
 * Quadra Competition Engine — Express server.
 *
 * Authenticates agents over Socket.IO (Sui signatures), watches enrolment + creation events,
 * dispatches free jobs, scores them at lifetime end, records on-chain, and releases prizes. The
 * one HTTP write — `POST /competitions/:id/bind` — lets the create-competition CLI tell the
 * engine a competition's template + lifetime + portfolio (guarded by an operator token).
 */
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { loadCompetitionConfig, createDataLayer } from './config.js';
import { createEvalEngineRegistry } from 'quadra-data';
import { AuthManager } from './auth.js';
import { createNotifier } from './notify.js';
import { CompetitionEngine } from './engine.js';
import type { CompetitionBinding } from './store.js';

/** Constant-time token compare (avoids leaking the admin token via timing). */
function tokenMatches(provided: string | undefined, expected: string): boolean {
    if (!expected || !provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Validate + normalize the bind request body into a CompetitionBinding. */
function parseBinding(id: string, body: unknown): CompetitionBinding | { error: string } {
    if (body === null || typeof body !== 'object') return { error: 'body must be a JSON object' };
    const b = body as Record<string, unknown>;
    const kind = Number(b.kind);
    if (kind !== 0 && kind !== 1) return { error: 'kind must be 0 (scoring) or 1 (performance)' };
    if (typeof b.template_id !== 'string' || b.template_id.length === 0) {
        return { error: 'template_id is required' };
    }
    if (typeof b.lifetime !== 'string' || b.lifetime.length === 0) {
        return { error: 'lifetime is required' };
    }
    const endTime = Number(b.end_time_ms);
    if (!Number.isFinite(endTime) || endTime <= 0) return { error: 'end_time_ms is required' };

    const params =
        b.params !== null && typeof b.params === 'object'
            ? Object.fromEntries(
                  Object.entries(b.params as Record<string, unknown>)
                      .filter(([, v]) => typeof v === 'string')
                      .map(([k, v]) => [k, v as string]),
              )
            : undefined;
    const portfolio =
        b.portfolio !== null && typeof b.portfolio === 'object'
            ? Object.fromEntries(
                  Object.entries(b.portfolio as Record<string, unknown>)
                      .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
                      .map(([k, v]) => [k, v as number]),
              )
            : undefined;

    // Off-chain presentation + scheduling metadata (all optional).
    const startTime = b.start_time_ms !== undefined ? Number(b.start_time_ms) : undefined;
    if (startTime !== undefined && (!Number.isFinite(startTime) || startTime < 0)) {
        return { error: 'start_time_ms must be a non-negative number' };
    }
    if (startTime !== undefined && startTime >= endTime) {
        return { error: 'start_time_ms must be before end_time_ms' };
    }
    const str = (v: unknown): string | undefined =>
        typeof v === 'string' && v.length > 0 ? v : undefined;
    const finiteNum = (v: unknown): number | undefined =>
        v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined;
    const split =
        Array.isArray(b.split) && b.split.every((n) => Number.isFinite(Number(n)))
            ? (b.split as unknown[]).map((n) => Number(n))
            : undefined;
    const prize = finiteNum(b.prize);
    const threshold = finiteNum(b.threshold);

    return {
        competition_id: id,
        kind,
        template_id: b.template_id,
        lifetime: b.lifetime,
        end_time_ms: endTime,
        ...(params && Object.keys(params).length > 0 ? { params } : {}),
        ...(portfolio && Object.keys(portfolio).length > 0 ? { portfolio } : {}),
        ...(b.prediction === true ? { prediction: true } : {}),
        ...(startTime !== undefined ? { start_time_ms: startTime } : {}),
        ...(str(b.title) ? { title: str(b.title) } : {}),
        ...(str(b.description) ? { description: str(b.description) } : {}),
        ...(str(b.tag) ? { tag: str(b.tag) } : {}),
        ...(prize !== undefined ? { prize } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(split && split.length > 0 ? { split } : {}),
    };
}

async function main(): Promise<void> {
    const config = loadCompetitionConfig();
    const dl = createDataLayer();
    const evalEngines = createEvalEngineRegistry(dl);
    await evalEngines.start();
    const auth = new AuthManager(dl, config.authWindowMs);

    const app = express();
    app.use(express.json());

    // Allow the web app to read the competition endpoints from the browser. Reads are public, so
    // a permissive default origin is fine; tighten it with COMPETITION_CORS_ORIGIN in production.
    const corsOrigin = process.env.COMPETITION_CORS_ORIGIN ?? '*';
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', corsOrigin);
        res.header('Access-Control-Allow-Headers', 'content-type, x-competition-admin');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    });

    const httpServer = createServer(app);
    const notifier = createNotifier(httpServer, auth);
    const engine = new CompetitionEngine(dl, config, notifier, evalEngines);
    engine.start();

    // The create-competition CLI registers a competition's off-chain binding here.
    app.put('/competitions/:id/bind', (req, res) => bindHandler(req, res));
    app.post('/competitions/:id/bind', (req, res) => bindHandler(req, res));

    function bindHandler(req: express.Request, res: express.Response): void {
        if (!tokenMatches(req.header('x-competition-admin'), config.adminToken)) {
            res.status(401).json({ error: 'unauthorized' });
            return;
        }
        const id = req.params.id;
        if (!id) {
            res.status(400).json({ error: 'competition id is required' });
            return;
        }
        const parsed = parseBinding(id, req.body);
        if ('error' in parsed) {
            res.status(400).json({ error: parsed.error });
            return;
        }
        dl.jobTemplates
            .get(parsed.template_id)
            .then((template) => {
                if (!template) {
                    res.status(400).json({ error: `unknown template ${parsed.template_id}` });
                    return;
                }
                return engine.bind(parsed).then(() => res.json({ ok: true }));
            })
            .catch((err) =>
                res.status(500).json({ error: err instanceof Error ? err.message : 'bind failed' }),
            );
    }

    app.get('/health', (_req, res) => res.json({ ok: true, network: dl.config.network }));
    app.get('/status', (_req, res) => res.json(engine.status()));

    // Public read API for the web competitions pages (list + detail).
    app.get('/competitions', (_req, res) => {
        engine
            .listCompetitions()
            .then((competitions) => res.json({ competitions }))
            .catch((err) =>
                res.status(500).json({ error: err instanceof Error ? err.message : 'list failed' }),
            );
    });
    app.get('/competitions/:id', (req, res) => {
        const id = req.params.id;
        if (!id) {
            res.status(400).json({ error: 'competition id is required' });
            return;
        }
        engine
            .getCompetition(id)
            .then((competition) => {
                if (!competition) {
                    res.status(404).json({ error: 'unknown competition' });
                    return;
                }
                res.json(competition);
            })
            .catch((err) =>
                res.status(500).json({ error: err instanceof Error ? err.message : 'detail failed' }),
            );
    });

    httpServer.listen(config.port, () => {
        console.log(
            `[competition] listening on http://localhost:${config.port} (HTTP + Socket.IO)`,
        );
    });
}

main().catch((error) => {
    console.error('[competition] failed to start:', error);
    process.exit(1);
});
