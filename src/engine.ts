import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import type { DataLayer, JobResult, JobTemplate } from 'quadra-data';

import type { CompetitionConfig, EvalEngine } from './config.js';
import { Store, type CompetitionBinding, type CompetitionJobRecord } from './store.js';
import { CompetitionChain } from './onchain.js';
import {
    EventWatcher,
    decodeAgentJoined,
    decodeCompetitionCreated,
    type AgentJoinedEvent,
    type CompetitionCreatedEvent,
} from './events.js';
import {
    buildPayload,
    buildPortfolioPayload,
    buildPredictionPayload,
    callEvalEngine,
    callStartData,
    classifyEvalError,
    verifyScoreSignature,
    verifyMetricSignature,
    type EvalScoreResponse,
    type EvalMetricResponse,
} from './evaluation.js';
import type { AgentNotifier } from './notify.js';

const KIND_SCORING = 0;
const KIND_PERFORMANCE = 1;

export type Outcome =
    | 'scored'
    | 'recorded'
    | 'not_delivered'
    | 'agent_fault'
    | 'eval_error'
    | 'no_engine'
    | 'released';

export interface FiredRecord {
    id: string;
    at: number;
    outcome: Outcome;
    detail?: string;
}

/** Parse a lifetime like "5m" / "30s" / "2h" / "1d" into milliseconds (mirrors the engines). */
export function parseLifetimeMs(lifetime: string): number {
    const m = /^(\d+)\s*(s|m|h|d)$/.exec(lifetime.trim());
    if (!m) throw new Error(`bad lifetime "${lifetime}"`);
    const n = Number(m[1]);
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
    return n * unit;
}

/** Deterministic, stable job id for one agent's entry in a competition (re-dispatch idempotent,
 * seal id stable). Distinct `comp_` prefix from intake's `job_` ids. */
function competitionJobId(competitionId: string, agent: string): string {
    const c = competitionId.replace(/^0x/, '').slice(0, 8);
    const a = agent.replace(/^0x/, '').slice(0, 8);
    return `comp_${c}_${a}`;
}

/**
 * Orchestrates competitions: watches `AgentJoined` (enrolment) and `CompetitionCreated`, learns
 * each competition's template/lifetime/portfolio from the create CLI's bind, dispatches one free
 * job per enrolled agent over Socket.IO, scores each at its lifetime end (decrypt -> eval engine
 * -> record on-chain), and releases prizes after the competition's end time. Reads + HTTP only
 * besides the cap-gated records (CompetitionChain), mirroring the scheduler's discipline.
 */
export class CompetitionEngine {
    #dl: DataLayer;
    #config: CompetitionConfig;
    #store: Store;
    #chain: CompetitionChain;
    #notifier: AgentNotifier;
    #sui: SuiJsonRpcClient;
    #joinWatcher: EventWatcher<AgentJoinedEvent>;
    #createdWatcher: EventWatcher<CompetitionCreatedEvent>;
    #timer: ReturnType<typeof setInterval> | undefined;
    #fired = new Map<string, FiredRecord>();
    #enclavePkCache = new Map<string, Uint8Array>();
    // Last good template per id, so a transient Walrus/RPC blip doesn't stop dispatch.
    #templateCache = new Map<string, JobTemplate>();

    constructor(dl: DataLayer, config: CompetitionConfig, notifier: AgentNotifier) {
        this.#dl = dl;
        this.#config = config;
        this.#notifier = notifier;
        this.#store = new Store(config.redisUrl);
        this.#sui = new SuiJsonRpcClient({
            url: process.env.DATA_BASE_URL ?? getJsonRpcFullnodeUrl(dl.config.network),
            network: dl.config.network,
        });
        this.#chain = new CompetitionChain({
            sui: this.#sui,
            keypair: config.keypair,
            quadraPackageId: config.quadraPackageId,
            competitionCapId: config.competitionCapId,
            agentRegistryId: config.agentRegistryId,
        });
        this.#joinWatcher = new EventWatcher({
            sui: this.#sui,
            store: this.#store,
            eventType: `${config.quadraPackageId}::competition::AgentJoined`,
            cursorName: 'agent_joined',
            pollMs: config.pollMs,
            decode: decodeAgentJoined,
            handler: (e) => this.#onAgentJoined(e),
        });
        this.#createdWatcher = new EventWatcher({
            sui: this.#sui,
            store: this.#store,
            eventType: `${config.quadraPackageId}::competition::CompetitionCreated`,
            cursorName: 'competition_created',
            pollMs: config.pollMs,
            decode: decodeCompetitionCreated,
            handler: (e) => this.#onCompetitionCreated(e),
        });
    }

    start(): void {
        this.#joinWatcher.start();
        this.#createdWatcher.start();
        this.#timer = setInterval(() => void this.#scan(), this.#config.pollMs);
        // Check due jobs + prize releases IMMEDIATELY on startup (not only after the first
        // interval), so a competition that ended while the engine was down is released at once.
        void this.#scan();
        console.log(
            `[competition] started: poll ${this.#config.pollMs}ms, network ${this.#dl.config.network}, ${this.#config.evalEngines.size} eval engine(s)`,
        );
    }

    async stop(): Promise<void> {
        this.#joinWatcher.stop();
        this.#createdWatcher.stop();
        if (this.#timer) clearInterval(this.#timer);
        await this.#store.close();
    }

    /** Learn (or update) a competition's off-chain binding from the create CLI. Also notes it for
     * auto-release (so dispatch/scoring and prize release are tracked independently). */
    async bind(binding: CompetitionBinding): Promise<void> {
        await this.#store.putBinding(binding);
        await this.#store.noteCompetition(binding.competition_id, binding.end_time_ms);
        console.log(
            `[competition] bound ${binding.competition_id} (kind ${binding.kind}, template ${binding.template_id}, lifetime ${binding.lifetime})`,
        );
    }

    status(): { fired: FiredRecord[] } {
        return { fired: [...this.#fired.values()] };
    }

    // --- event handlers ---

    async #onCompetitionCreated(e: CompetitionCreatedEvent): Promise<void> {
        // Track the competition + its on-chain end time for auto-release — independent of any
        // off-chain bind, so prizes still release for a competition that was only created.
        await this.#store.noteCompetition(e.competition_id, e.end_time_ms);
        console.log(
            `[competition] observed CompetitionCreated ${e.competition_id} (kind ${e.kind}, ends ${new Date(e.end_time_ms).toISOString()})`,
        );
    }

    async #onAgentJoined(e: AgentJoinedEvent): Promise<void> {
        await this.#store.addParticipant(e.competition_id, e.agent_id);
        console.log(`[competition] ${e.agent_id} joined ${e.competition_id}`);
    }

    // --- periodic scan: dispatch, score, release ---

    async #scan(): Promise<void> {
        const now = Date.now();
        try {
            await this.#reconcileDispatch(now);
        } catch (err) {
            console.error('[competition] dispatch failed:', err instanceof Error ? err.message : err);
        }
        for (const jobId of await this.#store.dueLifetimes(now)) {
            await this.#onJobExpired(jobId);
        }
        await this.#releaseDue(now);
    }

    /** For each bound, still-open competition, ensure every enrolled agent has a job and (re)push
     * it while it is live. The agent dedupes pushes, so re-pushing survives a lost push/reconnect. */
    async #reconcileDispatch(now: number): Promise<void> {
        for (const competitionId of await this.#store.boundCompetitions()) {
            const binding = await this.#store.getBinding(competitionId);
            if (!binding || now >= binding.end_time_ms) continue;

            // Read the template, but fall back to the last good copy on a transient Walrus/RPC
            // failure — and never let one competition's fetch error abort dispatch for the rest.
            let template = this.#templateCache.get(binding.template_id);
            try {
                const fresh = await this.#dl.jobTemplates.get(binding.template_id);
                if (fresh) {
                    template = fresh;
                    this.#templateCache.set(binding.template_id, fresh);
                }
            } catch (err) {
                console.warn(
                    `[competition] template ${binding.template_id} read failed (using cache): ${err instanceof Error ? err.message : err}`,
                );
            }
            if (!template) continue;
            // The gateway stores the rich template (with `params`) verbatim, so the agent can
            // re-parse it; pass the whole object through (typed only as JobTemplate here).
            const templateObj = template as unknown as Record<string, unknown>;

            const params = this.#deriveParams(binding, template);
            for (const agent of await this.#store.participants(competitionId)) {
                let jobId = await this.#store.getAgentJob(competitionId, agent);
                let record: CompetitionJobRecord | null;
                if (!jobId) {
                    jobId = competitionJobId(competitionId, agent);
                    record = {
                        competition_id: competitionId,
                        agent,
                        job_id: jobId,
                        kind: binding.kind,
                        template_id: binding.template_id,
                        lifetime: binding.lifetime,
                        asset: params.asset ?? '',
                        started_at_ms: now,
                        deadline_ms: now + parseLifetimeMs(binding.lifetime),
                    };
                    await this.#store.putJob(record);
                    console.log(`[competition] dispatched ${jobId} to ${agent}`);
                } else {
                    record = await this.#store.getJob(jobId);
                }
                if (!record || now >= record.deadline_ms) continue; // expired -> handled by scoring

                this.#notifier.competitionJob(agent, {
                    competition_id: competitionId,
                    job_id: record.job_id,
                    template_id: binding.template_id,
                    template: templateObj,
                    params,
                    lifetime: binding.lifetime,
                    started_at_ms: record.started_at_ms,
                    deadline_ms: record.deadline_ms,
                    kind: binding.kind,
                    ...(binding.portfolio !== undefined ? { portfolio: binding.portfolio } : {}),
                });
            }
        }
    }

    /** Fixed params for the job: the operator's bind params, else a default of the first allowed
     * asset + the lifetime as the horizon. */
    #deriveParams(binding: CompetitionBinding, template: JobTemplate): Record<string, string> {
        if (binding.params) return binding.params;
        const params: Record<string, string> = {};
        const first = template.allowed_assets?.[0];
        if (typeof first === 'string') params.asset = first;
        params.horizon = binding.lifetime;
        return params;
    }

    /** A job's lifetime ended: decrypt the delivered result, score/record it, and finalize. A
     * non-delivery needs no on-chain write (join pre-seeded the agent at 0, eliminating it). */
    async #onJobExpired(jobId: string): Promise<void> {
        if (!(await this.#store.tryLock(jobId))) return;
        try {
            const job = await this.#store.getJob(jobId);
            if (!job) {
                await this.#store.clearLifetime(jobId);
                return;
            }

            let result: JobResult | undefined;
            try {
                result = await this.#dl.jobResults.decrypt(jobId, this.#config.keypair);
            } catch {
                result = undefined; // no blob indexed, or decrypt failed -> treat as not delivered
            }
            if (!result) {
                await this.#finalize(jobId, job.competition_id, 'not_delivered');
                return;
            }

            const evaluatorId = result.job.template.evaluator_id;
            const engine = this.#config.evalEngines.get(evaluatorId);
            if (!engine) {
                console.warn(`[competition] ${jobId}: no eval engine for '${evaluatorId}'`);
                await this.#finalize(jobId, job.competition_id, 'no_engine', evaluatorId);
                return;
            }

            if (job.kind === KIND_PERFORMANCE) {
                await this.#scorePerformance(jobId, job, result, engine);
            } else {
                await this.#scoreScoring(jobId, job, result, engine);
            }
        } catch (err) {
            // Transient (RPC / chain / decrypt): leave it in the lifetime set to retry next scan.
            console.error(
                `[competition] onJobExpired ${jobId} failed (will retry):`,
                err instanceof Error ? err.message : err,
            );
        } finally {
            await this.#store.unlock(jobId);
        }
    }

    async #scoreScoring(
        jobId: string,
        job: CompetitionJobRecord,
        result: JobResult,
        engine: EvalEngine,
    ): Promise<void> {
        const binding = await this.#store.getBinding(job.competition_id);

        // Prediction (polymarket) competitions resolve from Polymarket using the fixed `params`
        // (market_id / event_id / target_ts), so there is no Pyth start price to capture: send the
        // prediction payload. Finance evaluators need the target asset + the delivered start price;
        // the competition has no delivery-time snapshot, so capture it now for the start moment.
        let payload: unknown;
        if (binding?.prediction) {
            payload = buildPredictionPayload(jobId, result, job, binding.params ?? {});
        } else {
            const asset = job.asset || binding?.params?.asset || '';
            const sd = await callStartData(engine.url, asset, job.started_at_ms);
            if (!sd.ok) {
                // Transient (oracle) or config (unsupported asset): leave unfinalized to retry.
                this.#record(jobId, 'eval_error', `start_data ${sd.status}: ${sd.message}`);
                throw new Error(`start_data fetch failed (${sd.status}): ${sd.message}`);
            }
            payload = buildPayload(jobId, result, asset, sd.startData);
        }
        const call = await callEvalEngine<EvalScoreResponse>(engine.url, payload);
        if (call.ok) {
            const ev = call.body as EvalScoreResponse;
            if (!(await this.#verify(engine, ev, 'score'))) {
                throw new Error(`enclave signature invalid for ${jobId}`);
            }
            const score = Number(ev.response.data.score);
            await this.#chain.recordScore(job.competition_id, result.agent, jobId, score);
            await this.#finalize(jobId, job.competition_id, 'scored', `score=${score}`);
            return;
        }
        const msg = typeof call.body === 'string' ? call.body : JSON.stringify(call.body);
        if (classifyEvalError(msg) === 'agent') {
            await this.#chain.recordScore(job.competition_id, result.agent, jobId, 0);
            await this.#finalize(jobId, job.competition_id, 'agent_fault', msg);
        } else {
            // Engine/oracle fault: leave unfinalized to retry on the next scan.
            this.#record(jobId, 'eval_error', msg);
            throw new Error(`eval engine error: ${msg}`);
        }
    }

    async #scorePerformance(
        jobId: string,
        job: CompetitionJobRecord,
        result: JobResult,
        engine: EvalEngine,
    ): Promise<void> {
        const binding = await this.#store.getBinding(job.competition_id);
        const portfolio = binding?.portfolio ?? {};
        const call = await callEvalEngine<EvalMetricResponse>(
            engine.url,
            buildPortfolioPayload(jobId, result, job, portfolio),
        );
        if (call.ok) {
            const ev = call.body as EvalMetricResponse;
            if (!(await this.#verify(engine, ev, 'metric'))) {
                throw new Error(`enclave signature invalid for ${jobId}`);
            }
            const metric = Number(ev.response.data.metric);
            await this.#chain.recordPerformance(job.competition_id, result.agent, metric);
            await this.#finalize(jobId, job.competition_id, 'recorded', `metric=${metric}`);
            return;
        }
        const msg = typeof call.body === 'string' ? call.body : JSON.stringify(call.body);
        if (classifyEvalError(msg) === 'agent') {
            // Agent fault: the join pre-seed (0) already eliminates them; just finalize.
            await this.#finalize(jobId, job.competition_id, 'agent_fault', msg);
        } else {
            this.#record(jobId, 'eval_error', msg);
            throw new Error(`eval engine error: ${msg}`);
        }
    }

    /** Verify an enclave response signature when the engine declares an on-chain enclave id; in
     * dev (no enclave id) trust the response. */
    async #verify(
        engine: EvalEngine,
        ev: EvalScoreResponse | EvalMetricResponse,
        kind: 'score' | 'metric',
    ): Promise<boolean> {
        if (!engine.enclaveId) return true;
        const pk = await this.#enclavePk(engine.enclaveId);
        return kind === 'score'
            ? verifyScoreSignature(pk, (ev as EvalScoreResponse).response, ev.signature)
            : verifyMetricSignature(pk, (ev as EvalMetricResponse).response, ev.signature);
    }

    /** Release every known competition's prizes once its end time has passed (idempotent). Driven
     * by the persisted known-competition set (from CompetitionCreated + binds), so it works across
     * restarts and without a binding. release_prizes is public + time-gated; markReleased (Redis
     * NX) + the on-chain EAlreadyEnded guard prevent a double payout. */
    async #releaseDue(now: number): Promise<void> {
        for (const competitionId of await this.#store.knownCompetitions()) {
            const endMs = await this.#store.competitionEnd(competitionId);
            if (endMs === null || now < endMs) continue;
            if (await this.#store.isReleased(competitionId)) continue; // fast path, no RPC/lock
            if (!(await this.#store.tryLock(`release:${competitionId}`))) continue;
            try {
                if (await this.#store.isReleased(competitionId)) continue; // re-check under lock
                // Already paid out on-chain (by anyone)? Mark done; never double-release.
                if (await this.#isEndedOnChain(competitionId)) {
                    await this.#store.setReleased(competitionId);
                    continue;
                }
                const digest = await this.#chain.releasePrizes(competitionId);
                await this.#store.setReleased(competitionId); // only AFTER a confirmed release
                this.#record(competitionId, 'released', digest);
                console.log(`[competition] released prizes for ${competitionId} (tx ${digest})`);
            } catch (err) {
                // Transient (RPC/chain): leave UNreleased so the next scan retries.
                console.error(
                    `[competition] release ${competitionId} failed (will retry):`,
                    err instanceof Error ? err.message : err,
                );
            } finally {
                await this.#store.unlock(`release:${competitionId}`);
            }
        }
    }

    /** Whether the competition's on-chain `ended` flag is set (already paid out). Best-effort:
     * on a read error, returns false so release is attempted (the on-chain time gate + EAlreadyEnded
     * keep it safe). */
    async #isEndedOnChain(competitionId: string): Promise<boolean> {
        try {
            const o = await this.#sui.getObject({
                id: competitionId,
                options: { showContent: true },
            });
            const ended = (o.data?.content as { fields?: { ended?: boolean } } | undefined)?.fields
                ?.ended;
            return ended === true;
        } catch {
            return false;
        }
    }

    async #finalize(
        jobId: string,
        _competitionId: string,
        outcome: Outcome,
        detail?: string,
    ): Promise<void> {
        if (await this.#store.markScored(jobId)) {
            await this.#store.clearLifetime(jobId);
            this.#record(jobId, outcome, detail);
            console.log(`[competition] job ${jobId}: ${outcome}${detail ? ` (${detail})` : ''}`);
        }
    }

    #record(id: string, outcome: Outcome, detail?: string): void {
        this.#fired.set(id, { id, at: Date.now(), outcome, ...(detail ? { detail } : {}) });
    }

    /** Read the registered ed25519 public key from the on-chain `Enclave` object (cached). */
    async #enclavePk(enclaveId: string): Promise<Uint8Array> {
        const cached = this.#enclavePkCache.get(enclaveId);
        if (cached) return cached;
        const o = await this.#sui.getObject({ id: enclaveId, options: { showContent: true } });
        const pk = (o.data?.content as { fields?: { pk?: number[] } } | undefined)?.fields?.pk;
        if (!pk) throw new Error(`Enclave ${enclaveId} has no pk`);
        const bytes = Uint8Array.from(pk);
        this.#enclavePkCache.set(enclaveId, bytes);
        return bytes;
    }
}
