/**
 * shared.ts — small helpers the operator CLIs have in common.
 *
 * The Sui version of this file also owned the environment: it read `../data/.env` and wrote keys
 * back into it with `upsertDataEnv`, because provisioning meant capturing capability objects and
 * recording their ids. There are no capability objects on Flare and nothing to provision, so
 * configuration is `src/config.ts` like every other repo, and this file is left with argument
 * parsing and formatting.
 */

import { formatUnits, parseUnits, type Address, type Hex } from 'viem';
import { coston2 } from '../src/chain.js';
import { KIND_PERFORMANCE, KIND_SCORING, MAX_WINNER_SLOTS } from '../src/abis.js';

/** Parse `--flag value` / `--flag=value` / boolean `--flag` into a map. */
export function parseArgs(argv: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === undefined || !arg.startsWith('--')) continue;
        const eq = arg.indexOf('=');
        if (eq !== -1) {
            out[arg.slice(2, eq)] = arg.slice(eq + 1);
            continue;
        }
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            out[key] = next;
            i++;
        } else {
            out[key] = 'true';
        }
    }
    return out;
}

/** A failure with a message an operator can act on, as opposed to an unexpected crash. */
export class CliError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliError';
    }
}

/**
 * Fail with a message rather than a stack trace. Every CLI failure here is an operator's typo.
 *
 * THROWS rather than calling `process.exit`. Exiting hard after an RPC call has happened tears
 * libuv down while the connection pool is still closing, which on Windows prints
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` — a crash dump stapled to the end of a
 * message that was meant to be clear. Unwinding to `main().catch` and setting an exit code ends
 * the process just as promptly, because nothing here holds the loop open.
 *
 * Typed `never` so it can stand in an expression position, e.g. inside a `.map` callback.
 */
export function fail(message: string): never {
    throw new CliError(message);
}

/**
 * The tail of every CLI: print what went wrong, set a failing exit code, drain.
 *
 * A `CliError` is a message we wrote, so it prints alone. Anything else is unexpected and keeps its
 * stack, because that is the case where the stack is the useful part.
 */
export function runCli(main: () => Promise<void>): void {
    main().catch((err: unknown) => {
        if (err instanceof CliError) console.error(err.message);
        else console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
        process.exitCode = 1;
    });
}

export function requireArg(args: Record<string, string>, name: string, usage: string): string {
    const value = (args[name] ?? '').trim();
    if (value.length === 0) fail(`Missing --${name}.\n\n${usage}`);
    return value;
}

/**
 * A `bytes32` competition id, lowercased.
 *
 * Normalised, not merely validated. Ids are compared as strings against keys that came from
 * viem-decoded logs, which are always lowercase, so an id pasted from a checksummed source would
 * miss the index and report a competition that exists as unknown.
 */
export function requireId(args: Record<string, string>, usage: string): Hex {
    const raw = requireArg(args, 'id', usage);
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
        fail(`--id must be a 0x-prefixed 32-byte hex competition id (got "${raw}")`);
    }
    return raw.toLowerCase() as Hex;
}

/**
 * A duration in SECONDS: `30s`, `5m`, `2h`, `1d`, or a bare number of seconds.
 *
 * Seconds, not the milliseconds the Sui engine used everywhere. `block.timestamp` is in seconds and
 * so is every field of the competition struct; keeping one unit end to end removes the `/1000` that
 * silently turns a 15-minute window into a 15-hour one.
 */
export function parseDurationSecs(raw: string, flag: string): number {
    const text = raw.trim();
    const match = /^(\d+)\s*(s|m|h|d)?$/.exec(text);
    if (match === null) {
        fail(`${flag} must look like 30s, 5m, 2h, 1d, or a plain number of seconds (got "${raw}")`);
    }
    const n = Number(match[1]);
    const unit = match[2] ?? 's';
    const scale = { s: 1, m: 60, h: 3_600, d: 86_400 }[unit as 's' | 'm' | 'h' | 'd'];
    return n * scale;
}

/** A winner split like `60,40`. Must sum to 100 — the contract rejects anything else with BadSplit. */
export function parseSplit(raw: string): number[] {
    const parts = raw
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => {
            const n = Number(p);
            if (!Number.isInteger(n) || n <= 0 || n > 100) {
                fail(`--split must be positive whole percentages, e.g. 60,40 (got "${raw}")`);
            }
            return n;
        });
    if (parts.length === 0) fail('--split must name at least one winner slot, e.g. 100');
    // MAX_WINNER_SLOTS on the contract. Checked here so the failure names the flag rather than
    // arriving as a TooManySlots selector from a reverted simulation.
    if (parts.length > MAX_WINNER_SLOTS) {
        fail(
            `--split names ${parts.length} winner slots; the contract caps it at ${MAX_WINNER_SLOTS}`,
        );
    }
    const total = parts.reduce((sum, n) => sum + n, 0);
    if (total !== 100) fail(`--split must sum to 100 (got ${total} from "${raw}")`);
    return parts;
}

export function parseKind(raw: string): number {
    const text = raw.trim().toLowerCase();
    if (text === 'scoring' || text === '0') return KIND_SCORING;
    if (text === 'performance' || text === '1') return KIND_PERFORMANCE;
    return fail(`--kind must be scoring (0) or performance (1) (got "${raw}")`);
}

export const kindName = (kind: number): string =>
    kind === KIND_PERFORMANCE ? 'performance' : kind === KIND_SCORING ? 'scoring' : `kind ${kind}`;

/** QUADRA is an 18-decimal ERC-20. Whole tokens in, base units out. */
export const toBaseUnits = (raw: string, flag: string): bigint => {
    try {
        return parseUnits(raw.trim(), 18);
    } catch {
        return fail(`${flag} must be a decimal amount of QUADRA, e.g. 1 or 0.5 (got "${raw}")`);
    }
};

export const formatQuadra = (amount: bigint): string => `${formatUnits(amount, 18)} QUADRA`;

const explorer = coston2.blockExplorers.default.url;
export const explorerTx = (hash: Hex): string => `${explorer}/tx/${hash}`;
export const explorerAddress = (address: Address): string => `${explorer}/address/${address}`;

/** Unix seconds as something a human can check against a wall clock. */
export function formatTime(unixSecs: number): string {
    if (unixSecs <= 0) return 'never';
    const iso = new Date(unixSecs * 1000).toISOString().replace('.000', '');
    const delta = unixSecs - Math.floor(Date.now() / 1000);
    const abs = Math.abs(delta);
    const span =
        abs < 90
            ? `${abs}s`
            : abs < 5_400
              ? `${Math.round(abs / 60)} min`
              : `${(abs / 3_600).toFixed(1)} h`;
    return `${iso} (${delta >= 0 ? `in ${span}` : `${span} ago`})`;
}

/** Report a write that failed, in the terms the contract used. Never a stack trace. */
export function explainTxFailure(
    label: string,
    outcome: {
        kind: string;
        message: string;
        errorName?: string | undefined;
        hash?: Hex | undefined;
    },
): void {
    console.error(`${label} failed (${outcome.kind}): ${outcome.message}`);
    if (outcome.hash !== undefined) console.error(`  tx ${explorerTx(outcome.hash)}`);

    switch (outcome.errorName) {
        case 'BadTeeSignature':
            console.error(
                [
                    '',
                    'The contract did not recognise the settlement signature. The live TeeRegistry is',
                    'still bound to a development key that no enclave holds, so nothing can settle',
                    'until the registry owner re-binds it:',
                    '',
                    "  1. read the evaluation engine's key:  curl $EVAL_URL/pubkey",
                    '  2. the TeeRegistry owner calls setActiveTee with that address',
                    '',
                    'This is a deployment prerequisite, not a problem with this command.',
                ].join('\n'),
            );
            break;
        case 'TeeRevoked':
            console.error(
                '\nTeeRegistry.activeTeeWallet is zero: no TEE is bound, so no settlement can be accepted.',
            );
            break;
        case 'AlreadySettled':
            console.error(
                '\nThis competition is already settled — the scheduler relayer most likely got there first.',
            );
            break;
        case 'NotOperator':
            console.error(
                '\nThis wallet is not an operator on SealedCompetition. The contract owner grants that with setOperator(address, true).',
            );
            break;
        case 'TooEarly':
            console.error(
                '\nThe chain considers this too early. Check resolveAt and try again later.',
            );
            break;
        default:
            break;
    }
}
