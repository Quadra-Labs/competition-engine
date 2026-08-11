/**
 * registry.ts — a small in-memory index of the competition contract's history.
 *
 * The Sui service kept this in Redis: bindings, participants, cursors, job records, all of it
 * surviving restarts and all of it capable of disagreeing with the chain. Nothing here is
 * persisted. The index is rebuilt from logs at every boot, which is what makes it safe to treat as
 * a cache rather than a source of truth — the chain is always the authority, and a wrong index is
 * cured by a restart.
 *
 * WHY AN INDEX AT ALL, IN A SERVICE THAT COULD READ LIVE. Because the cost of reading logs on
 * Coston2 is measured in WINDOWS, not in events: the public RPC caps `eth_getLogs` at 30 blocks, so
 * one pass over a day of chain is ~1,500 requests. Reading per request — one scan for a
 * competition's submissions, another for its prizes, once per competition, per API call — turned a
 * single `GET /competitions` into thousands of requests and a 429 that aborted the walk. One pass
 * at boot plus a short tail costs the same as ONE of those scans and serves every read for free.
 *
 * DISCOVERY HAS TWO LEGS, matching `scheduler/src/relayer.ts`: the boot pass for everything that
 * already exists, and a periodic tail for everything after it. The tail replaces
 * `watchContractEvent` deliberately — six events would mean six polling filters, and viem's watcher
 * quietly drops logs across reorgs and rate limits, which is the failure the scheduler's header
 * calls out. A tail that re-reads the last few blocks each tick has neither problem.
 *
 * A FAILED SCAN DEGRADES rather than kills the process. A read API that answers "nothing yet" while
 * the RPC is unwell is a bad afternoon; one that refuses to start is a bad afternoon plus a page.
 */

import { withRetry } from 'quadra-core';
import type { Address, Hex } from 'viem';
import type { CompetitionChain, CompetitionEvent, PrizeLog, SubmissionLog } from './chain.js';

export interface IndexedCompetition {
    readonly competitionId: Hex;
    readonly evaluatorId: string;
    readonly kind: number;
    /** Unix seconds. */
    readonly resolveAt: bigint;
    readonly createdBlock: bigint;
    /**
     * Agents that JOINED — staked in — whether or not they went on to submit.
     *
     * Tracked separately from `submissions` because the two genuinely differ and the difference is
     * the interesting part: an agent who joins and never submits forfeits its stake, is excluded
     * from settlement (`NoSubmission`), and appears in no receipt. On Sui such an agent was
     * pre-seeded at zero and stayed visible; here nothing else in the system records them at all.
     */
    readonly joined: readonly Address[];
    /** Latest commitment per agent — the contract keeps only the newest. */
    readonly submissions: readonly SubmissionLog[];
    readonly prizes: readonly PrizeLog[];
    readonly settled: boolean;
    readonly cancelled: boolean;
    readonly receiptHash: Hex | undefined;
    /** The published audit body. Present only once settled. */
    readonly receipt: Hex | undefined;
}

export interface RegistryStats {
    readonly competitions: number;
    readonly active: number;
    readonly ended: number;
    readonly settled: number;
    readonly cancelled: number;
    readonly fromBlock: string;
    /** How far the index has read. Everything at or below this block is accounted for. */
    readonly indexedThroughBlock: string | undefined;
    readonly lastScanAt: number | undefined;
    readonly lastScanError: string | undefined;
    readonly tailing: boolean;
}

export interface Registry {
    readonly start: () => Promise<void>;
    readonly stop: () => void;
    /** Newest first, which is the order a list page wants. */
    readonly list: () => readonly IndexedCompetition[];
    readonly get: (competitionId: Hex) => IndexedCompetition | undefined;
    /**
     * Fill in a competition the index is missing or knows only partially, with one extra pass.
     *
     * The escape hatch for a direct link to something the boot pass missed — because it was
     * failing, or because the request arrived before it finished. It cannot rescue a competition
     * created BELOW `FROM_BLOCK`: that floor bounds every scan here, and lowering it is the
     * operator's decision, not a thing a request should be able to trigger.
     */
    readonly discover: (competitionId: Hex) => Promise<IndexedCompetition | undefined>;
    readonly stats: () => RegistryStats;
}

export interface RegistryDeps {
    readonly chain: CompetitionChain;
    /** The deploy block. Never above it: a floor that is too high hides competitions silently. */
    readonly fromBlock: bigint;
    /** How often the tail looks for new blocks. */
    readonly pollMs: number;
    readonly log?: (line: string) => void;
}

const nowSecs = (): number => Math.floor(Date.now() / 1000);

/** Retries for a scan, on top of the per-window retries `getLogsChunked` already does. */
const SCAN_ATTEMPTS = 3;

/**
 * Blocks the tail re-reads on every tick.
 *
 * A short reorg rewrites recent blocks, and re-reading them is how the index heals: applying the
 * same event twice is idempotent here (submissions key on agent, prizes on agent+rank), so
 * overlapping is free while missing a block is not.
 */
const TAIL_OVERLAP_BLOCKS = 16n;

/** Log every N windows during a long historical scan, so it does not look hung. */
const PROGRESS_EVERY = 200;

interface MutableCompetition {
    competitionId: Hex;
    evaluatorId: string;
    kind: number;
    resolveAt: bigint;
    createdBlock: bigint;
    /** True once this competition's OWN creation log was read, rather than inferred from a later event. */
    fromCreation: boolean;
    joined: Map<string, Address>;
    submissions: Map<string, SubmissionLog>;
    prizes: Map<string, PrizeLog>;
    settled: boolean;
    cancelled: boolean;
    receiptHash: Hex | undefined;
    receipt: Hex | undefined;
}

export function makeRegistry(deps: RegistryDeps): Registry {
    const index = new Map<Hex, MutableCompetition>();
    /**
     * Ids that exist on chain but cannot be completed by a scan from `FROM_BLOCK`.
     *
     * Almost always one thing: a competition created below the floor. Remembering the answer is
     * what stops a client polling that competition's URL from re-walking the entire range on every
     * request, which is a full historical scan per HTTP call on an unauthenticated route.
     */
    const unplaceable = new Set<Hex>();
    let indexedThrough: bigint | undefined;
    let lastScanAt: number | undefined;
    let lastScanError: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let tailing = false;
    let sweeping = false;

    const log = (line: string): void => deps.log?.(line);

    /** An event about a competition we have never seen creates a placeholder rather than vanishing. */
    function slotFor(competitionId: Hex, blockNumber: bigint): MutableCompetition {
        const existing = index.get(competitionId);
        if (existing !== undefined) return existing;
        const created: MutableCompetition = {
            competitionId,
            evaluatorId: '',
            kind: 0,
            resolveAt: 0n,
            createdBlock: blockNumber,
            fromCreation: false,
            joined: new Map(),
            submissions: new Map(),
            prizes: new Map(),
            settled: false,
            cancelled: false,
            receiptHash: undefined,
            receipt: undefined,
        };
        index.set(competitionId, created);
        return created;
    }

    /**
     * Whether this entry was built from its own creation log.
     *
     * A placeholder — assembled from a later event because the creation was below the scan floor —
     * knows the competition exists but has none of its history, so it would be served as a
     * competition with zero entrants next to a full leaderboard.
     */
    const isComplete = (slot: MutableCompetition): boolean => slot.fromCreation;

    /** Idempotent by construction, so the tail's overlap and a reorg replay are both harmless. */
    function apply(event: CompetitionEvent): void {
        switch (event.type) {
            case 'created': {
                const c = event.competition;
                const slot = slotFor(c.competitionId, c.blockNumber);
                slot.evaluatorId = c.evaluatorId;
                slot.kind = c.kind;
                slot.resolveAt = c.resolveAt;
                slot.createdBlock = c.blockNumber;
                slot.fromCreation = true;
                break;
            }
            case 'joined': {
                const slot = slotFor(event.competitionId, 0n);
                slot.joined.set(event.agent.toLowerCase(), event.agent);
                break;
            }
            case 'submitted': {
                const slot = slotFor(event.competitionId, event.submission.blockNumber);
                const key = event.submission.agent.toLowerCase();
                const previous = slot.submissions.get(key);
                // LAST write wins. An agent may resubmit until `resolveAt` and the contract keeps
                // only the newest commitment, so an older one would name a ciphertext the
                // settlement will never open.
                if (
                    previous === undefined ||
                    event.submission.blockNumber >= previous.blockNumber
                ) {
                    slot.submissions.set(key, event.submission);
                }
                break;
            }
            case 'prize': {
                const slot = slotFor(event.competitionId, 0n);
                slot.prizes.set(
                    `${event.prize.agent.toLowerCase()}:${event.prize.rank}`,
                    event.prize,
                );
                break;
            }
            case 'settled': {
                const slot = slotFor(event.competitionId, 0n);
                slot.settled = true;
                slot.receiptHash = event.receiptHash;
                break;
            }
            case 'cancelled': {
                slotFor(event.competitionId, 0n).cancelled = true;
                break;
            }
            case 'receipt': {
                slotFor(event.competitionId, 0n).receipt = event.receipt;
                break;
            }
        }
    }

    function snapshot(slot: MutableCompetition): IndexedCompetition {
        return {
            competitionId: slot.competitionId,
            evaluatorId: slot.evaluatorId,
            kind: slot.kind,
            resolveAt: slot.resolveAt,
            createdBlock: slot.createdBlock,
            joined: [...slot.joined.values()],
            submissions: [...slot.submissions.values()],
            prizes: [...slot.prizes.values()].sort((a, b) => a.rank - b.rank),
            settled: slot.settled,
            cancelled: slot.cancelled,
            receiptHash: slot.receiptHash,
            receipt: slot.receipt,
        };
    }

    /** Read a range into the index. Returns the block it read through. */
    async function ingest(fromBlock: bigint, onProgress?: boolean): Promise<bigint> {
        const head = await deps.chain.blockNumber();
        if (fromBlock > head) return head;
        const events = await deps.chain.events({
            fromBlock,
            toBlock: head,
            ...(onProgress === true
                ? {
                      onProgress: (windows, block) => {
                          if (windows % PROGRESS_EVERY === 0) {
                              log(`[competition] scanning… ${windows} windows, at block ${block}`);
                          }
                      },
                  }
                : {}),
        });
        for (const event of events) apply(event);
        return head;
    }

    async function sweep(): Promise<void> {
        // One tick at a time. A slow tail must not stack up behind itself and multiply the
        // request rate exactly when the endpoint is already struggling.
        if (sweeping) return;
        sweeping = true;
        try {
            // Never below `fromBlock`: on a chain younger than the overlap the subtraction would
            // otherwise send every tick back to genesis.
            const rewound =
                indexedThrough === undefined
                    ? deps.fromBlock
                    : indexedThrough - TAIL_OVERLAP_BLOCKS;
            const floor = rewound > deps.fromBlock ? rewound : deps.fromBlock;
            indexedThrough = await withRetry(() => ingest(floor), SCAN_ATTEMPTS);
            lastScanAt = Date.now();
            lastScanError = undefined;
        } catch (err) {
            lastScanError = err instanceof Error ? err.message : String(err);
        } finally {
            sweeping = false;
        }
    }

    return {
        async start() {
            const started = Date.now();
            try {
                indexedThrough = await withRetry(() => ingest(deps.fromBlock, true), SCAN_ATTEMPTS);
                lastScanAt = Date.now();
                lastScanError = undefined;
                log(
                    `[competition] indexed ${index.size} competitions from block ${deps.fromBlock} ` +
                        `through ${indexedThrough} in ${Math.round((Date.now() - started) / 1000)}s`,
                );
            } catch (err) {
                lastScanError = err instanceof Error ? err.message : String(err);
                log(
                    `[competition] boot scan failed (${lastScanError}); continuing without history, ` +
                        'the tail will still pick up new competitions',
                );
            }

            timer = setInterval(() => void sweep(), deps.pollMs);
            timer.unref();
            tailing = true;
        },

        stop() {
            if (timer !== undefined) clearInterval(timer);
            timer = undefined;
            tailing = false;
        },

        list() {
            return [...index.values()]
                .sort((a, b) => Number(b.createdBlock - a.createdBlock))
                .map(snapshot);
        },

        get(competitionId) {
            const slot = index.get(competitionId);
            return slot === undefined ? undefined : snapshot(slot);
        },

        async discover(competitionId) {
            const known = index.get(competitionId);
            // A complete entry is one whose own creation log we read. A PLACEHOLDER — built from a
            // later event such as `Settled` — has no creation block and no submissions, and would
            // otherwise be served as a competition with zero entrants beside a full leaderboard.
            if (known !== undefined && isComplete(known)) return snapshot(known);

            // Cheap existence check first: a made-up id costs one call rather than a scan, which
            // matters because this path is reachable from an unauthenticated route.
            const state = await deps.chain.getCompetition(competitionId);
            if (!state.exists) return undefined;

            // Once, then never again for this id. A competition that exists on chain but whose
            // creation is below FROM_BLOCK can never be completed by a scan floored at FROM_BLOCK,
            // and without this a client polling its URL would re-walk the whole range every time.
            if (unplaceable.has(competitionId))
                return known === undefined ? undefined : snapshot(known);

            // ONE pass from the floor, not a creation-block hunt followed by a second walk from
            // there: both cost the same number of windows, so the hunt doubles the price of the
            // answer. The floor stays FROM_BLOCK rather than anything the caller supplies — the
            // same anti-manipulation rule the evaluation engine follows, where a requester-chosen
            // floor can hide submissions.
            await ingest(deps.fromBlock);

            const slot = index.get(competitionId);
            if (slot === undefined || !isComplete(slot)) unplaceable.add(competitionId);
            return slot === undefined ? undefined : snapshot(slot);
        },

        stats() {
            const all = [...index.values()];
            const at = nowSecs();
            const ended = all.filter(
                (e) => e.settled || e.cancelled || at >= Number(e.resolveAt),
            ).length;
            return {
                competitions: all.length,
                active: all.length - ended,
                ended,
                settled: all.filter((e) => e.settled).length,
                cancelled: all.filter((e) => e.cancelled).length,
                fromBlock: deps.fromBlock.toString(),
                indexedThroughBlock: indexedThrough?.toString(),
                lastScanAt,
                lastScanError,
                tailing,
            };
        },
    };
}

/** The agents that submitted, for a caller that only needs the list. */
export const entrantsOf = (competition: IndexedCompetition): readonly Address[] =>
    competition.submissions.map((s) => s.agent);
