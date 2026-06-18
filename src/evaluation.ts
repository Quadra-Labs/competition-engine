import { bcs } from '@mysten/sui/bcs';
import { fromHex } from '@mysten/sui/utils';
import * as ed25519 from '@noble/ed25519';
import type { JobResult } from 'quadra-data';

import type { CompetitionJobRecord } from './store.js';

// --- shared envelope -------------------------------------------------------

/** The signed score the enclave returns (SCORING mode). Mirrors the scheduler. */
export interface ScoreData {
    agent_id: string | number[];
    category_id: string;
    job_id: string;
    score: number;
    finalized_price: number | string;
}

/** The signed ROI metric the portfolio enclave returns (PERFORMANCE mode). `metric` is the
 * on-chain `PERF_BASE + roi_bps` encoding; `roi_bps` is an unauthenticated human-readable echo. */
export interface MetricData {
    agent_id: string | number[];
    category_id: string;
    job_id: string;
    metric: number | string;
    roi_bps?: number | string;
}

export interface EvalScoreResponse {
    response: { intent: number; timestamp_ms: number | string; data: ScoreData };
    signature: string;
}

export interface EvalMetricResponse {
    response: { intent: number; timestamp_ms: number | string; data: MetricData };
    signature: string;
}

export interface EvalCallResult<T> {
    status: number;
    ok: boolean;
    /** Parsed JSON on success; the raw message text on a 400. */
    body: T | string;
}

// --- BCS layouts (must match the enclave's IntentMessage<...> exactly) ------

const ScoreResult = bcs.struct('ScoreResult', {
    agent_id: bcs.fixedArray(32, bcs.u8()),
    category_id: bcs.string(),
    job_id: bcs.string(),
    score: bcs.u8(),
    finalized_price: bcs.u64(),
});

const MetricResult = bcs.struct('MetricResult', {
    agent_id: bcs.fixedArray(32, bcs.u8()),
    category_id: bcs.string(),
    job_id: bcs.string(),
    metric: bcs.u64(),
});

const ScoreIntentMessage = bcs.struct('IntentMessage', {
    intent: bcs.u8(),
    timestamp_ms: bcs.u64(),
    data: ScoreResult,
});

const MetricIntentMessage = bcs.struct('IntentMessage', {
    intent: bcs.u8(),
    timestamp_ms: bcs.u64(),
    data: MetricResult,
});

// --- SCORING mode ----------------------------------------------------------

/** Build the `process_data` payload from a decrypted scoring result. The new finance evaluators
 * resolve the END price themselves from `asset` (Pyth feed) at the resolution moment, and read
 * the delivered START price from `start_data.start_price` (1e-8 fixed-point units), so both must
 * be supplied. */
export function buildPayload(jobId: string, result: JobResult, asset: string, startData: unknown) {
    return {
        payload: {
            agent_id: result.agent,
            category_id: result.job.template.evaluator_id,
            job_id: jobId,
            agent_result: result.agent_result,
            job_template: {
                output: result.job.template.output,
                lifetime: result.job.lifetime,
            },
            started_at_ms: result.started_at,
            delivered_at_ms: result.delivered_at,
            asset,
            start_data: startData,
        },
    };
}

export type StartDataResult =
    | { ok: true; startData: unknown }
    | { ok: false; status: number; message: string };

/** Capture an asset's start price via the eval engine's `/start_data` (price at `atMs`, in 1e-8
 * units). The competition engine calls this for the job's `started_at_ms` before scoring, since —
 * unlike the paid flow — there is no delivery-time snapshot. Returns `{ start_price }` on success. */
export async function callStartData(
    url: string,
    asset: string,
    atMs: number,
): Promise<StartDataResult> {
    const res = await fetch(`${url.replace(/\/$/, '')}/start_data`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { asset, at_ms: atMs } }),
    });
    if (!res.ok) return { ok: false, status: res.status, message: await res.text() };
    const body = (await res.json()) as { start_data?: unknown };
    return { ok: true, startData: body.start_data ?? {} };
}

// --- PERFORMANCE mode ------------------------------------------------------

/** Build the portfolio `process_data` payload: the agent's trades plus the starting portfolio
 * and the [start, end] window the enclave prices the result against. */
export function buildPortfolioPayload(
    jobId: string,
    result: JobResult,
    job: CompetitionJobRecord,
    portfolio: Record<string, number>,
) {
    return {
        payload: {
            agent_id: result.agent,
            category_id: result.job.template.evaluator_id,
            job_id: jobId,
            agent_result: result.agent_result,
            job_template: {
                output: result.job.template.output,
                lifetime: result.job.lifetime,
            },
            started_at_ms: result.started_at,
            delivered_at_ms: result.delivered_at,
            portfolio_start: portfolio,
            window: { start_ms: job.started_at_ms, end_ms: job.deadline_ms },
            allowed_assets: result.job.template.allowed_assets,
        },
    };
}

// --- PREDICTION mode (polymarket-*) ----------------------------------------

/** Build the prediction `process_data` payload: the agent's guess plus the fixed competition
 * `params` (market_id / event_id / target_ts) the evaluator resolves against Polymarket, and the
 * [start, end] window. No `asset`/`start_data` — the polymarket evaluator has no Pyth snapshot and
 * reads the market id from `params` (authoritative, not the agent's echo). */
export function buildPredictionPayload(
    jobId: string,
    result: JobResult,
    job: CompetitionJobRecord,
    params: Record<string, string>,
) {
    return {
        payload: {
            agent_id: result.agent,
            category_id: result.job.template.evaluator_id,
            job_id: jobId,
            agent_result: result.agent_result,
            job_template: {
                output: result.job.template.output,
                lifetime: result.job.lifetime,
            },
            started_at_ms: result.started_at,
            delivered_at_ms: result.delivered_at,
            params,
            window: { start_ms: job.started_at_ms, end_ms: job.deadline_ms },
        },
    };
}

// --- HTTP -----------------------------------------------------------------

/** POST a job to an evaluation engine's `/process_data` endpoint. */
export async function callEvalEngine<T>(url: string, payload: unknown): Promise<EvalCallResult<T>> {
    const res = await fetch(`${url.replace(/\/$/, '')}/process_data`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) return { status: res.status, ok: true, body: (await res.json()) as T };
    return { status: res.status, ok: false, body: await res.text() };
}

// --- signature verification ------------------------------------------------

function agentIdBytes(agent: string | number[]): number[] {
    if (Array.isArray(agent)) return agent;
    return Array.from(fromHex(agent));
}

/** Verify the enclave signature over the SCORING IntentMessage. */
export async function verifyScoreSignature(
    pk: Uint8Array,
    response: EvalScoreResponse['response'],
    signatureHex: string,
): Promise<boolean> {
    const bytes = ScoreIntentMessage.serialize({
        intent: response.intent,
        timestamp_ms: BigInt(response.timestamp_ms),
        data: {
            agent_id: agentIdBytes(response.data.agent_id),
            category_id: response.data.category_id,
            job_id: response.data.job_id,
            score: response.data.score,
            finalized_price: BigInt(response.data.finalized_price),
        },
    }).toBytes();
    try {
        return await ed25519.verifyAsync(fromHex(signatureHex), bytes, pk);
    } catch {
        return false;
    }
}

/** Verify the enclave signature over the PERFORMANCE IntentMessage (metric only). */
export async function verifyMetricSignature(
    pk: Uint8Array,
    response: EvalMetricResponse['response'],
    signatureHex: string,
): Promise<boolean> {
    const bytes = MetricIntentMessage.serialize({
        intent: response.intent,
        timestamp_ms: BigInt(response.timestamp_ms),
        data: {
            agent_id: agentIdBytes(response.data.agent_id),
            category_id: response.data.category_id,
            job_id: response.data.job_id,
            metric: BigInt(response.data.metric),
        },
    }).toBytes();
    try {
        return await ed25519.verifyAsync(fromHex(signatureHex), bytes, pk);
    } catch {
        return false;
    }
}

/** Classify an eval-engine rejection (HTTP 400). `'agent'` -> the agent is at fault (zero
 * score/metric); `'engine'` -> an engine/oracle/config problem (leave for retry). For prediction
 * jobs a malformed guess / unknown market is the agent's fault, but "not resolved yet" is transient
 * (the default 'engine' path), so the engine keeps retrying until the market resolves. */
export function classifyEvalError(message: string): 'agent' | 'engine' {
    return /too late|before started_at|missing field|not of type|valid sui address|empty portfolio|unknown asset|insufficient|invalid guess|unknown market/i.test(
        message,
    )
        ? 'agent'
        : 'engine';
}
