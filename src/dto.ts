/**
 * dto.ts — what the read API serves, and how each field is derived from the chain.
 *
 * The Sui service merged an off-chain "binding" (title, description, tag, template, portfolio)
 * with the on-chain object. None of that exists on Flare: the contract is the only source, so every
 * field below is either read from `competitions()`, counted from a log, or dropped. What is dropped
 * is listed explicitly at the bottom, because a field quietly disappearing from an API is worse
 * than one that is documented as gone.
 *
 * TWO DELIBERATE BREAKS FROM THE SUI SHAPE:
 *
 *   1. **Token amounts are decimal STRINGS.** QUADRA has 18 decimals, so one whole token is 1e18 —
 *      already past the point where a JSON number stays exact, and `JSON.stringify(1e18)` in a
 *      prize field is a wrong number rendered confidently. The Sui DTO used `number` because SUI
 *      amounts were small enough to get away with it.
 *   2. **A running competition has no leaderboard.** Scores do not exist on chain until settlement
 *      — that is the sealed-submission guarantee, not a gap — so `leaderboard.sealed` says so
 *      rather than serving zeros that look like a ranking.
 */

import { jobAsset } from 'quadra-core';
import type { Address, Hex } from 'viem';
import type { CompetitionState, PrizeLog, SubmissionLog } from './chain.js';

/** No `'upcoming'`: a competition is live from creation to `resolveAt`. Scheduled starts were dropped. */
export type CompetitionStatus = 'active' | 'ended';

export interface CompetitionSummary {
    /** The `bytes32` id — `keccak256(abi.encode(operator, label))`, not a readable name. */
    readonly id: Hex;
    /** Which scorer grades it, e.g. `price-range-guess`. The closest thing to a title on chain. */
    readonly evaluatorId: string;
    /** 0 = scoring ([0,100] scores), 1 = performance (`PERF_BASE + roi_bps`). */
    readonly kind: number;
    readonly status: CompetitionStatus;
    /** The asset the competition is about, decoded from `params`, when it declared one. */
    readonly asset: string | undefined;
    /**
     * The prize a person means, in QUADRA base units as a decimal string.
     *
     * Before settlement: the seed plus everything staked. After: what was actually paid out. The
     * live `prizePool` is NOT this number once settled — it is only the unclaimed dust left by a
     * lapsed slot or a rounded share.
     */
    readonly prize: string;
    /** Per-agent entry stake, base units. */
    readonly stake: string;
    /** Number of winner slots — the length of the on-chain split. */
    readonly winners: number;
    /** Ranking value an entry must reach to be paid at all. Units depend on `kind`. */
    readonly threshold: string;
    /** Unix MILLISECONDS. The one place seconds become milliseconds, for the web's sake. */
    readonly endsAt: number;
    /** The scored window in seconds, ending at `resolveAt`. `0` on pre-Batch-P competitions. */
    readonly lifetimeSecs: number;
    /**
     * Distinct agents with a sealed SUBMISSION. Who is in is public; what they said is not.
     *
     * Not the same as `joined`, and the gap is meaningful: an agent that joined and never submitted
     * is excluded from settlement (`NoSubmission`) and forfeits its stake.
     */
    readonly entrants: number;
    /** Distinct agents that staked in, whether or not they went on to submit. */
    readonly joined: number;
    readonly settled: boolean;
    readonly cancelled: boolean;
    readonly creator: Address;
}

export interface LeaderboardRow {
    readonly agent: Address;
    /**
     * The ranking value from the published receipt: a [0,100] score, or `PERF_BASE + roi_bps`.
     * Absent while the competition is running, because no score exists yet.
     */
    readonly score?: number;
    readonly rank?: number;
    /** QUADRA awarded, base units as a string. Present only for an agent that placed. */
    readonly awarded?: string;
    /** 1-based, like `rank`. The contract's `PrizeAwarded.rank` is 0-based and is converted. */
    readonly awardRank?: number;
}

export interface Leaderboard {
    /**
     * True while the competition is unsettled: the rows name the entrants and nothing more.
     *
     * Not an error state. Submissions are encrypted to the TEE and are opened once, at settlement,
     * which is what makes the competition fair to enter late.
     */
    readonly sealed: boolean;
    readonly rows: readonly LeaderboardRow[];
}

export interface CompetitionRules {
    readonly kind: number;
    readonly threshold: string;
    readonly split: readonly number[];
    readonly lifetimeSecs: number;
    readonly asset: string | undefined;
    /** The raw scope blob as created, for anything the decoder above does not model. */
    readonly params: Hex;
}

export interface CompetitionDetail extends CompetitionSummary {
    readonly ended: boolean;
    /** The `metric = PERF_BASE + roi_bps` baseline, so a client decodes ROI without hardcoding. */
    readonly perfBase: number;
    readonly leaderboard: Leaderboard;
    readonly rules: CompetitionRules;
    /** The audit receipt hash anchored at settlement, when there is one. */
    readonly receiptHash?: Hex;
}

const nowSecs = (): number => Math.floor(Date.now() / 1000);

export function statusOf(state: CompetitionState, at = nowSecs()): CompetitionStatus {
    return state.settled || state.cancelled || at >= Number(state.resolveAt) ? 'ended' : 'active';
}

/**
 * The prize to display.
 *
 * `awarded` after settlement, seed + stakes before it. Getting this wrong is the single most
 * visible read bug available here: `prizePool` reads near zero the moment a competition settles,
 * so a naive mapping shows every finished competition as having paid nothing.
 */
export function prizeOf(state: CompetitionState, prizes: readonly PrizeLog[]): bigint {
    if (state.settled) return prizes.reduce((total, p) => total + p.amount, 0n);
    return state.seedPrize + state.stakedTotal;
}

export function toSummary(
    id: Hex,
    state: CompetitionState,
    submissions: readonly SubmissionLog[],
    prizes: readonly PrizeLog[],
    splitPct: readonly number[],
    joined: readonly unknown[] = [],
): CompetitionSummary {
    return {
        id,
        evaluatorId: state.evaluatorId,
        kind: state.kind,
        status: statusOf(state),
        asset: jobAsset(state.params),
        prize: prizeOf(state, prizes).toString(),
        stake: state.stake.toString(),
        winners: splitPct.length,
        threshold: state.threshold.toString(),
        endsAt: Number(state.resolveAt) * 1000,
        lifetimeSecs: state.lifetimeSecs,
        entrants: submissions.length,
        joined: joined.length,
        settled: state.settled,
        cancelled: state.cancelled,
        creator: state.creator,
    };
}

/**
 * FIELDS THE SUI API HAD AND THIS ONE DOES NOT, with where each went.
 *
 * Recorded because a field that quietly disappears from an API is worse than one documented as
 * gone: a client reading `undefined` cannot tell a removal from an outage. Anyone porting the web
 * layer should read this list first — several entries are not absences but CHANGES, which is the
 * more dangerous kind.
 *
 * Gone, no source on Flare:
 *   `title`, `description`, `tag`  — never on chain. Deferred product call, `plan/09` feature 8.
 *   `startsAt`                     — scheduled starts dropped; live from create to resolveAt (#27).
 *   `rules.templateId`, `rules.lifetime`, `rules.prediction`, `rules.portfolio`
 *                                  — the template system has no Flare counterpart (#9).
 *   `LeaderboardRow.name`, `.category`
 *                                  — no on-chain agent registry; rows carry raw addresses (#26).
 *
 * Present but CHANGED — a client that keeps its old types will misread these:
 *   `prize`, `threshold`, `stake`, `awarded`  number -> decimal STRING, and QUADRA has 18 decimals.
 *   `entrants`                                counted SUBMITTERS, not joiners (see `joined`).
 *   `leaderboard`                             LeaderboardRow[] -> { sealed, rows }.
 *   `LeaderboardRow.total`                    -> `score`, and absent entirely until settlement.
 *   `rules.params`                            Record<string,string> -> the raw JSON-in-hex blob.
 *   `status`                                  `'upcoming'` is never emitted any more.
 *   `id`                                      a bytes32 hash, not a Sui object id.
 */
export const REMOVED_DTO_FIELDS = [
    'title',
    'description',
    'tag',
    'startsAt',
    'rules.templateId',
    'rules.lifetime',
    'rules.prediction',
    'rules.portfolio',
    'leaderboard[].name',
    'leaderboard[].category',
    'leaderboard[].total',
] as const;
