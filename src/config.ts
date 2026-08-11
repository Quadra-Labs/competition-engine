/**
 * config.ts — the whole environment contract, in one place.
 *
 * Three rules, two of them carried over from the Sui version's mistakes:
 *
 *   1. **Report everything wrong at once.** The Sui loader threw on the first absent variable, so
 *      an operator with four unset settings found out about one per restart. This returns the
 *      complete list, and counts a malformed number as a problem rather than silently substituting
 *      a default — a `COMPETITION_POLL_MS` of `3o00` parses to NaN, which `setInterval` treats as
 *      1ms and turns into a permanent hammering of the RPC.
 *   2. **Every variable this package reads appears here.** The exception is documented:
 *      `LOG_CHUNK_BLOCKS` is read inside `quadra-core`'s `logChunkSize()`, and `CONTRACTS_DIR`
 *      inside its `loadDeployment()`. Both are listed in `.env.example` for that reason.
 *   3. **The private key is never echoed.** It is reported by NAME when malformed and never by
 *      value.
 *
 * THE KEY IS OPTIONAL, and that is the point of the split in this repo. The read service holds no
 * key at all — it only reads chain state and serves it — so a missing key must not stop it from
 * starting. The write CLIs call `requireKey` and fail there, where the key is actually needed.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeployment, type Deployment } from 'quadra-core/deployments';
import type { Address, Hex } from 'viem';
import { loadDotEnv } from './dotenv.js';

export interface OpsConfig {
    // --- chain -----------------------------------------------------------------------------------
    readonly rpcUrl: string;
    readonly chainId: number;
    readonly sealedCompetition: Address;
    /** The prize/stake token. Only the create CLI needs it, for the approve before `create`. */
    readonly quadraToken: Address | undefined;
    /**
     * The operator wallet, for the write CLIs only. `undefined` is a normal state: the read service
     * never signs anything, and an operator running `list-competitions` needs no key either.
     */
    readonly privateKey: Hex | undefined;
    /**
     * The scan floor — the block `SealedCompetition` was deployed in.
     *
     * Too LOW is merely slow. Too HIGH silently hides competitions, which is the failure that looks
     * like an empty chain rather than an error, so it is never defaulted: with no value and none in
     * the deployment file, this is a recorded problem.
     */
    readonly fromBlock: bigint;

    // --- evaluation engine (the settle CLI only) ---------------------------------------------------
    /** Explicit IPv4: `localhost` can resolve to ::1 and hang on a service listening on v4. */
    readonly evalUrl: string;
    /** Optional shared secret sent as `x-intake-token`. Unset means the engine is unauthenticated. */
    readonly internalToken: string | undefined;
    readonly evalTimeoutMs: number;

    // --- timing ------------------------------------------------------------------------------------
    /** Drives the event watchers behind the read API. */
    readonly pollMs: number;
    /** How long a write waits for its receipt. The write lock is held for the whole wait. */
    readonly txTimeoutMs: number;
    readonly confirmations: number;

    // --- serving -----------------------------------------------------------------------------------
    readonly port: number;
    readonly corsOrigin: string;
}

export type ConfigResult =
    | { readonly ok: true; readonly config: OpsConfig; readonly source: ConfigSource }
    | { readonly ok: false; readonly problems: readonly string[] };

export interface ConfigSource {
    readonly deploymentFile: boolean;
    readonly chainId: number;
}

const DEFAULT_RPC = 'https://coston2-api.flare.network/ext/C/rpc';
const DEFAULT_EVAL_URL = 'http://127.0.0.1:3000';

/**
 * Where a `.env` may live, nearest first.
 *
 * The house convention is one file beside the sibling checkouts configuring all ten repos, so the
 * parent-of-siblings candidate is not a fallback — it is the normal case.
 */
export function envSearchPaths(): readonly string[] {
    const here = fileURLToPath(new URL('.', import.meta.url));
    // Deduped, because run from the repo root the first two candidates are the same file and an
    // error listing the same path twice reads like a bug in the error.
    return [
        ...new Set([
            join(process.cwd(), '.env'),
            join(here, '..', '.env'),
            join(here, '..', '..', '.env'),
            join(homedir(), '.quadra', '.env'),
        ]),
    ];
}

function env(name: string): string {
    return (process.env[name] ?? '').trim();
}

export function loadOpsConfig(): ConfigResult {
    loadDotEnv(envSearchPaths());

    const problems: string[] = [];

    /** A positive, finite number, or a recorded problem. Never a silent fallback for a typo. */
    function num(name: string, fallback: number): number {
        const raw = env(name);
        if (raw.length === 0) return fallback;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
            problems.push(`${name} must be a positive number (got "${raw}")`);
            return fallback;
        }
        return n;
    }

    const chainId = num('CHAIN_ID', 114);
    const deployed: Deployment | undefined = loadDeployment(chainId);

    const sealedRaw = env('SEALED_COMPETITION') || (deployed?.sealedCompetition ?? '');
    if (sealedRaw.length === 0) {
        problems.push(
            `SEALED_COMPETITION is not set and contracts/deployments/${chainId}.json was not reachable`,
        );
    }

    // Absent is fine — the read service never signs. Present but malformed is not: it means an
    // operator believes they configured a wallet, and the CLI would fail at the moment of signing.
    const rawKey = env('COMPETITION_PRIVATE_KEY');
    let privateKey: Hex | undefined;
    if (rawKey.length > 0 && rawKey !== '0x') {
        if (/^0x[0-9a-fA-F]{64}$/.test(rawKey)) {
            privateKey = rawKey as Hex;
        } else {
            problems.push('COMPETITION_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
        }
    }

    // `deployment.fromBlock` is typed by quadra-core but absent from the live 114.json, so in
    // practice the env var is the only source today. Defaulting to 0 would send a boot scan through
    // 33 million blocks at 30 blocks a request, which reads as a hang rather than a misconfiguration.
    const fromBlockRaw = env('FROM_BLOCK') || (deployed?.fromBlock?.toString() ?? '');
    let fromBlock = 0n;
    if (fromBlockRaw.length === 0) {
        problems.push(
            `FROM_BLOCK is not set and contracts/deployments/${chainId}.json carries no fromBlock; ` +
                'set it to the block SealedCompetition was deployed in',
        );
    } else {
        try {
            fromBlock = BigInt(fromBlockRaw);
            if (fromBlock < 0n) throw new Error('negative');
        } catch {
            problems.push(`FROM_BLOCK must be a non-negative integer (got "${fromBlockRaw}")`);
        }
    }

    const config: OpsConfig = {
        rpcUrl: env('CHAIN_RPC_URL') || DEFAULT_RPC,
        chainId,
        sealedCompetition: sealedRaw as Address,
        quadraToken: (env('QUADRA_TOKEN') || deployed?.quadraToken || undefined) as
            Address | undefined,
        privateKey,
        fromBlock,

        evalUrl: (env('EVAL_URL') || DEFAULT_EVAL_URL).replace(/\/+$/, ''),
        internalToken: env('INTAKE_INTERNAL_TOKEN') || undefined,
        evalTimeoutMs: num('EVAL_TIMEOUT_MS', 30_000),

        pollMs: num('COMPETITION_POLL_MS', 3_000),
        txTimeoutMs: num('COMPETITION_TX_TIMEOUT_MS', 120_000),
        confirmations: num('COMPETITION_CONFIRMATIONS', 1),

        port: num('COMPETITION_PORT', 5_100),
        corsOrigin: env('COMPETITION_CORS_ORIGIN') || '*',
    };

    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, config, source: { deploymentFile: deployed !== undefined, chainId } };
}

/**
 * The key, or a readable exit.
 *
 * For the write CLIs. Separated from the loader so that a missing key is an error exactly where
 * signing is required, and never at the boot of a service that only reads.
 */
export function requireKey(config: OpsConfig): Hex {
    if (config.privateKey === undefined) {
        console.error(
            [
                'COMPETITION_PRIVATE_KEY is not set, and this command signs a transaction.',
                '',
                'Set it in the environment, or in a .env at one of:',
                ...envSearchPaths().map((p) => `  ${p}`),
                '',
                'The wallet needs C2FLR for gas, and QUADRA if it is funding a prize.',
            ].join('\n'),
        );
        process.exit(1);
    }
    return config.privateKey;
}

/** A human-readable explanation of a failed load, for a process that is about to exit. */
export function explainProblems(problems: readonly string[], chainId: number): string {
    return [
        `quadra-competition: ${problems.length} configuration problem${
            problems.length === 1 ? '' : 's'
        }:`,
        ...problems.map((p) => `  - ${p}`),
        '',
        'Set them in the environment, or in a .env at one of:',
        ...envSearchPaths().map((p) => `  ${p}`),
        '',
        `Contract addresses are read from contracts/deployments/${chainId}.json when it is`,
        'reachable, so a redeploy normally needs no config change at all.',
    ].join('\n');
}

/** Load the config or exit with every problem at once. The entry point every CLI shares. */
export function loadOrExit(): OpsConfig {
    const loaded = loadOpsConfig();
    if (!loaded.ok) {
        console.error(explainProblems(loaded.problems, Number(process.env['CHAIN_ID'] ?? 114)));
        process.exit(1);
    }
    return loaded.config;
}
