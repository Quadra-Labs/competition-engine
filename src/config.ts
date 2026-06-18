import { fileURLToPath } from 'node:url';

import { Agent, setGlobalDispatcher } from 'undici';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { DataLayer } from 'quadra-data';

// Generous connect timeout for public Sui/Walrus endpoints. We do NOT pin family:4 here: on a
// long-running process, forcing IPv4 was making outbound fetches intermittently "fetch failed";
// letting Node auto-select the family (Happy Eyeballs) is more reliable.
setGlobalDispatcher(new Agent({ connect: { timeout: 60_000 } }));

// The competition engine shares the data layer's .env (network, pointers, keys, and
// QUADRA_PACKAGE_ID), exactly like the intake engine and scheduler. Override with DATA_ENV_PATH.
try {
    const envPath =
        process.env.DATA_ENV_PATH ?? fileURLToPath(new URL('../../data/.env', import.meta.url));
    process.loadEnvFile(envPath);
} catch {
    // env may already be provided by the parent process (e.g. a spawned child)
}

/** Where to reach (and how to verify) one evaluation engine. Mirrors the scheduler's shape. */
export interface EvalEngine {
    /** Base URL of the enclave / its backend (POST /process_data). */
    url: string;
    /** On-chain `enclave::Enclave` object id. Omit to skip signature verification (local dev). */
    enclaveId?: string;
}

export interface CompetitionConfig {
    /** The wallet that owns `CompetitionCap` AND is the `job_access::set_competition` blanket
     * reader (so it can Seal-decrypt free competition results). Signs all on-chain records. */
    keypair: Ed25519Keypair;
    quadraPackageId: string;
    competitionCapId: string;
    /** The shared `agent::AgentRegistry` id (record_score / record_performance need it). */
    agentRegistryId: string;
    /** Operator token guarding `POST /competitions/:id/bind` (the engine learns a competition's
     * template + lifetime + portfolio from the create CLI). Falls back to ROLE_TOKEN_ADMIN. */
    adminToken: string;
    redisUrl: string;
    port: number;
    /** Reconcile + lifetime/end scan interval (default 3s). */
    pollMs: number;
    /** Allowed clock skew on a signed agent socket handshake (default 60s). */
    authWindowMs: number;
    /** evaluator_id -> evaluation engine (scoring scorer + the portfolio-roi evaluator). */
    evalEngines: Map<string, EvalEngine>;
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var ${name}`);
    return value;
}

function num(name: string, fallback: number): number {
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${value}"`);
    return n;
}

export function loadCompetitionConfig(): CompetitionConfig {
    return {
        keypair: Ed25519Keypair.fromSecretKey(required('COMPETITION_SECRET_KEY')),
        quadraPackageId: required('QUADRA_PACKAGE_ID'),
        competitionCapId: required('COMPETITION_CAP_ID'),
        agentRegistryId: required('AGENT_REGISTRY_ID'),
        adminToken: process.env.COMPETITION_ADMIN_TOKEN ?? process.env.ROLE_TOKEN_ADMIN ?? '',
        redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
        port: num('COMPETITION_PORT', 5100),
        pollMs: num('COMPETITION_POLL_MS', 3000),
        authWindowMs: num('COMPETITION_AUTH_WINDOW_MS', 60_000),
        evalEngines: loadEvalEngines(),
    };
}

/** Parse `EVAL_ENGINES` (a JSON object `evaluator_id -> { url, enclave_id? }`). Shared shape
 * with the scheduler; the portfolio-roi evaluator is just another entry. */
function loadEvalEngines(): Map<string, EvalEngine> {
    const raw = process.env.EVAL_ENGINES;
    if (!raw) return new Map();
    let parsed: Record<string, { url: string; enclave_id?: string }>;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `EVAL_ENGINES is not valid JSON: ${error instanceof Error ? error.message : error}`,
        );
    }
    return new Map(
        Object.entries(parsed).map(([id, e]) => [
            id,
            { url: e.url, ...(e.enclave_id ? { enclaveId: e.enclave_id } : {}) },
        ]),
    );
}

/** Read-only data layer (no master key); the engine reads templates + Seal-decrypts results. */
export function createDataLayer(): DataLayer {
    return DataLayer.forReads();
}
