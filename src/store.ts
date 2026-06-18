import { Redis } from 'ioredis';

/** What the engine needs to dispatch + resolve a competition. Learned from the create CLI's
 * `POST /competitions/:id/bind`; on-chain threshold/split live only in the contract. */
export interface CompetitionBinding {
    competition_id: string;
    /** 0 = scoring, 1 = performance. */
    kind: number;
    template_id: string;
    /** Each agent's single job lifetime, e.g. "5m". */
    lifetime: string;
    /** When prizes may be released (epoch ms). */
    end_time_ms: number;
    /** Fixed parameter values handed to every agent for this competition (e.g. asset, horizon;
     * for prediction jobs market_id / event_id / target_ts). When omitted the engine derives a
     * default ({ asset: first allowed, horizon: lifetime }). */
    params?: Record<string, string>;
    /** PERFORMANCE mode only: the starting portfolio handed to every agent (asset -> USD). */
    portfolio?: Record<string, number>;
    /** SCORING prediction-market competitions (polymarket-*): the evaluator resolves from
     * Polymarket using `params`, so the engine skips the Pyth start-price capture and sends a
     * prediction payload instead of the finance one. Defaults to false (finance scoring). */
    prediction?: boolean;
    // --- presentational + scheduling metadata (set by the admin create script; off-chain only,
    // since the contract has no start time, title, or description) ---
    /** When the competition opens (epoch ms). Before this it reads as "upcoming" on the web and the
     * engine dispatches no jobs. Defaults to the creation time (live immediately) when omitted. */
    start_time_ms?: number;
    /** Display title, blurb, and a short category/type label for the web competitions pages. */
    title?: string;
    description?: string;
    tag?: string;
    /** Original prize pool (QUADRA base units), winner split, and qualifying threshold, copied
     * from the create call so the web can show the full pool even after `release_prizes` drains the
     * on-chain balance. The live contract object stays the source of truth where it is still set. */
    prize?: number;
    threshold?: number;
    split?: number[];
}

/** One dispatched free job (one per agent per competition). */
export interface CompetitionJobRecord {
    competition_id: string;
    agent: string;
    job_id: string;
    kind: number;
    template_id: string;
    lifetime: string;
    /** The asset the job targets (e.g. "BTC"); the eval engine resolves its Pyth feed and the
     * engine fetches the start price for it. Empty for older records (fallback to the binding). */
    asset: string;
    started_at_ms: number;
    deadline_ms: number;
}

const CURSOR = (name: string): string => `competition:cursor:${name}`;
const BIND = (c: string): string => `competition:bind:${c}`;
const BOUND = 'competition:bound';
const KNOWN = 'competition:known';
const END = (c: string): string => `competition:end:${c}`;
const PARTICIPANTS = (c: string): string => `competition:participants:${c}`;
const AGENT_JOB = (c: string, a: string): string => `competition:agentjob:${c}:${a}`;
const JOB = (j: string): string => `competition:job:${j}`;
const LIFETIMES = 'competition:lifetimes';
const SCORED = (j: string): string => `competition:scored:${j}`;
const RELEASED = (c: string): string => `competition:released:${c}`;
const SETTLE = (j: string): string => `competition:settling:${j}`;

/** Redis-backed competition state: bindings, participants, dispatched jobs, lifetimes, and the
 * per-watcher event cursors. Mirrors the intake engine's Store discipline. */
export class Store {
    #redis: Redis;

    constructor(redisUrl: string) {
        this.#redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    }

    // --- event cursors (one per watcher) ---
    async getCursor(name: string): Promise<string | null> {
        return this.#redis.get(CURSOR(name));
    }
    async setCursor(name: string, cursor: string): Promise<void> {
        await this.#redis.set(CURSOR(name), cursor);
    }

    // --- bindings ---
    async putBinding(binding: CompetitionBinding): Promise<void> {
        await this.#redis
            .multi()
            .set(BIND(binding.competition_id), JSON.stringify(binding))
            .sadd(BOUND, binding.competition_id)
            .exec();
    }
    async getBinding(competitionId: string): Promise<CompetitionBinding | null> {
        const raw = await this.#redis.get(BIND(competitionId));
        return raw ? (JSON.parse(raw) as CompetitionBinding) : null;
    }
    async boundCompetitions(): Promise<string[]> {
        return this.#redis.smembers(BOUND);
    }

    // --- known competitions (release tracking; independent of bindings) ---
    /** Note a competition + its end time (from a CompetitionCreated event or a bind), so the
     * engine auto-releases its prizes after the end — across restarts, and even with no binding.
     * Persisted in Redis, so it is re-checked on every startup. */
    async noteCompetition(competitionId: string, endTimeMs: number): Promise<void> {
        await this.#redis
            .multi()
            .sadd(KNOWN, competitionId)
            .set(END(competitionId), String(endTimeMs))
            .exec();
    }
    async knownCompetitions(): Promise<string[]> {
        return this.#redis.smembers(KNOWN);
    }
    async competitionEnd(competitionId: string): Promise<number | null> {
        const raw = await this.#redis.get(END(competitionId));
        return raw === null ? null : Number(raw);
    }

    // --- participants (from AgentJoined) ---
    async addParticipant(competitionId: string, agent: string): Promise<void> {
        await this.#redis.sadd(PARTICIPANTS(competitionId), agent);
    }
    async participants(competitionId: string): Promise<string[]> {
        return this.#redis.smembers(PARTICIPANTS(competitionId));
    }

    // --- dispatched jobs ---
    /** The job id already assigned to an agent for a competition, if any. */
    async getAgentJob(competitionId: string, agent: string): Promise<string | null> {
        return this.#redis.get(AGENT_JOB(competitionId, agent));
    }
    /** Record a newly dispatched job atomically (job record + agent mapping + lifetime). */
    async putJob(record: CompetitionJobRecord): Promise<void> {
        await this.#redis
            .multi()
            .set(JOB(record.job_id), JSON.stringify(record))
            .set(AGENT_JOB(record.competition_id, record.agent), record.job_id)
            .zadd(LIFETIMES, record.deadline_ms, record.job_id)
            .exec();
    }
    async getJob(jobId: string): Promise<CompetitionJobRecord | null> {
        const raw = await this.#redis.get(JOB(jobId));
        return raw ? (JSON.parse(raw) as CompetitionJobRecord) : null;
    }
    /** Job ids whose lifetime ended at or before `now`. */
    async dueLifetimes(now: number): Promise<string[]> {
        return this.#redis.zrangebyscore(LIFETIMES, 0, now);
    }
    /** Drop a job from the lifetime set once it has been scored. */
    async clearLifetime(jobId: string): Promise<void> {
        await this.#redis.zrem(LIFETIMES, jobId);
    }

    // --- one-shot flags ---
    async markScored(jobId: string): Promise<boolean> {
        return (await this.#redis.set(SCORED(jobId), '1', 'NX')) === 'OK';
    }
    /** Whether a competition's prizes have already been released (set only AFTER a confirmed
     * release, so a transient failure is retried rather than silently skipped). */
    async isReleased(competitionId: string): Promise<boolean> {
        return (await this.#redis.exists(RELEASED(competitionId))) === 1;
    }
    async setReleased(competitionId: string): Promise<void> {
        await this.#redis.set(RELEASED(competitionId), '1');
    }

    /** One-shot lock so concurrent scans never score/release the same id twice. */
    async tryLock(jobId: string): Promise<boolean> {
        return (await this.#redis.set(SETTLE(jobId), '1', 'PX', 120_000, 'NX')) === 'OK';
    }
    async unlock(jobId: string): Promise<void> {
        await this.#redis.del(SETTLE(jobId));
    }

    async close(): Promise<void> {
        await this.#redis.quit();
    }
}
