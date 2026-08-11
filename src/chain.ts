/**
 * chain.ts — this repo's entire relationship with the chain.
 *
 * The only file that can hold a key, and it holds one only when a CLI hands it over: the read
 * service constructs this seam WITHOUT a private key and gets a client that physically cannot
 * write. That is the split the repo is built around. On Sui this process owned a `CompetitionCap`
 * and was the sole author of every score; here it owns nothing. Scores arrive inside a TEE-signed
 * settlement that any address may relay, so the operator wallet's only power is to create a
 * competition, to forward a settlement it cannot forge, and to cancel one the contract already
 * considers cancellable.
 *
 * Nothing here throws for an expected failure. Every write returns a typed `TxOutcome` carrying an
 * honest `retryable` and, on a revert, the contract's own `errorName` — `AlreadySettled` means
 * somebody else relayed the settlement and the work is done, while `BadTeeSignature` means the
 * registry is bound to a key the enclave does not hold. Collapsing those into one "it failed"
 * string is how an operator retries a competition that settled ten minutes ago.
 */

import {
    BaseError,
    ContractFunctionRevertedError,
    TransactionNotFoundError,
    TransactionReceiptNotFoundError,
    WaitForTransactionReceiptTimeoutError,
    createPublicClient,
    createWalletClient,
    decodeEventLog,
    defineChain,
    http,
    type Account,
    type Address,
    type Hex,
    type Log,
    type PublicClient,
    type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getLogsChunked, withWriteLock } from 'quadra-core';
import { erc20Abi, sealedCompetitionAbi } from './abis.js';
import type { CompetitionSettleArgs } from './evalClient.js';

/** Coston2. Gas is native C2FLR; prizes and stakes are ERC-20 QUADRA. */
export const coston2 = defineChain({
    id: 114,
    name: 'Flare Testnet Coston2',
    nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
    rpcUrls: { default: { http: ['https://coston2-api.flare.network/ext/C/rpc'] } },
    blockExplorers: {
        default: { name: 'Coston2 Explorer', url: 'https://coston2-explorer.flare.network' },
    },
    testnet: true,
});

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const ZERO_HASH =
    '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

export interface CompetitionChainConfig {
    readonly rpcUrl: string;
    readonly chainId: number;
    readonly sealedCompetition: Address;
    /** Absent for the read service. Present only when a CLI is about to sign something. */
    readonly privateKey?: Hex | undefined;
    readonly quadraToken?: Address | undefined;
    /** Tail interval, and the receipt poll interval for a write. */
    readonly pollMs?: number;
    /** Delay between log windows during a scan. Raise it if the endpoint still throttles. */
    readonly scanPaceMs?: number;
    /** How long a write waits for its receipt before reporting `unconfirmed`. */
    readonly txTimeoutMs?: number;
    readonly confirmations?: number;
    /** Where a watcher or a failed write reports itself. Without it, a dead watcher is silent. */
    readonly onError?: (where: string, err: unknown) => void;
}

/**
 * All fifteen fields the contract stores for a competition.
 *
 * `exists` is carried rather than collapsed into `undefined` by the caller, because the three
 * booleans are read together: a competition can exist, be settled, and be uncancellable all at
 * once, and each answer sends a CLI down a different path.
 */
export interface CompetitionState {
    readonly evaluatorId: string;
    readonly category: Hex;
    /** KIND_SCORING or KIND_PERFORMANCE. Decides how to READ the ranking values. */
    readonly kind: number;
    readonly stake: bigint;
    readonly seedPrize: bigint;
    readonly stakedTotal: bigint;
    /** What the contract still holds — after settlement, only unclaimed dust. */
    readonly prizePool: bigint;
    /** Unix SECONDS. The contract works in seconds; the Sui original worked in milliseconds. */
    readonly resolveAt: bigint;
    readonly threshold: bigint;
    readonly exists: boolean;
    readonly settled: boolean;
    readonly cancelled: boolean;
    readonly creator: Address;
    /** The window entries are SCORED over, ending at `resolveAt`. Not `resolveAt - createdAt`. */
    readonly lifetimeSecs: number;
    /** Raw JSON-in-hex scope, the same convention a paid job's params use. `'0x'` means none. */
    readonly params: Hex;
}

/** A `CompetitionCreated` log, flattened. Everything a registry entry needs, with no follow-up read. */
export interface CreatedCompetition {
    readonly competitionId: Hex;
    readonly evaluatorId: string;
    readonly kind: number;
    readonly resolveAt: bigint;
    readonly creator: Address;
    readonly lifetimeSecs: number;
    readonly params: Hex;
    readonly blockNumber: bigint;
}

export interface SubmissionLog {
    readonly agent: Address;
    readonly ciphertextHash: Hex;
    readonly blockNumber: bigint;
    readonly txHash: Hex;
}

export interface PrizeLog {
    readonly agent: Address;
    readonly rank: number;
    readonly amount: bigint;
}

/**
 * One decoded event from the competition contract.
 *
 * A union rather than six separate scans, because the cost of a historical scan is the number of
 * 30-block WINDOWS, not the number of events in them. Six filtered scans over the same range cost
 * six times what one unfiltered scan costs and return the same information.
 */
export type CompetitionEvent =
    | { readonly type: 'created'; readonly competition: CreatedCompetition }
    | { readonly type: 'joined'; readonly competitionId: Hex; readonly agent: Address }
    | {
          readonly type: 'submitted';
          readonly competitionId: Hex;
          readonly submission: SubmissionLog;
      }
    | { readonly type: 'prize'; readonly competitionId: Hex; readonly prize: PrizeLog }
    | { readonly type: 'settled'; readonly competitionId: Hex; readonly receiptHash: Hex }
    | { readonly type: 'cancelled'; readonly competitionId: Hex }
    | { readonly type: 'receipt'; readonly competitionId: Hex; readonly receipt: Hex };

export interface ScanArgs {
    readonly fromBlock: bigint;
    /** Defaults to the head. Bounding it is what keeps a tail scan to one window. */
    readonly toBlock?: bigint;
    /** Called per window, so a long historical scan shows progress instead of looking hung. */
    readonly onProgress?: (windows: number, block: bigint) => void;
}

export interface CreateArgs {
    readonly competitionId: Hex;
    readonly evaluatorId: string;
    readonly kind: number;
    readonly stake: bigint;
    readonly resolveAt: bigint;
    readonly threshold: bigint;
    readonly splitPct: readonly number[];
    readonly prize: bigint;
    readonly lifetimeSecs: number;
    readonly params: Hex;
}

export type TxErrorKind =
    | 'insufficient_funds'
    /** The contract said no, before any gas was spent. Deterministic: it will say no again. */
    | 'reverted'
    | 'nonce_error'
    | 'rpc_error'
    | 'timeout'
    /** Mined, and the EVM rejected it. The simulation passed, so state moved in between. */
    | 'reverted_onchain'
    /** Broadcast, but no receipt arrived. It may still land: do NOT retry, reconcile. */
    | 'unconfirmed';

export type TxOutcome =
    | {
          readonly ok: true;
          readonly hash: Hex;
          readonly blockNumber: bigint;
          /** The receipt's logs, so a caller can read back what the transaction emitted. */
          readonly logs: readonly Log[];
      }
    | {
          readonly ok: false;
          readonly kind: TxErrorKind;
          readonly message: string;
          readonly retryable: boolean;
          /** The contract's custom error, when the node gave one. Callers branch on this. */
          readonly errorName?: string | undefined;
          /** Set once broadcast: the transaction to reconcile against the chain. */
          readonly hash?: Hex | undefined;
      };

/**
 * Classify a failed write.
 *
 * A verbatim copy of `intake-engine/src/chain.ts::classifyTxError`, which `scheduler/src/chain.ts`
 * also carries. The distinction that matters: a revert is DETERMINISTIC — the contract said no, and
 * it will say no again — while a dropped socket or a rate limit is not.
 */
export function classifyTxError(err: unknown): {
    kind: TxErrorKind;
    message: string;
    retryable: boolean;
    errorName?: string | undefined;
} {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();

    if (err instanceof BaseError) {
        const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
        if (reverted instanceof ContractFunctionRevertedError) {
            const errorName = reverted.data?.errorName;
            const reason = errorName ?? reverted.reason ?? 'the contract rejected the call';
            return {
                kind: 'reverted',
                message: `reverted: ${reason}`,
                retryable: false,
                errorName,
            };
        }
    }

    if (lower.includes('insufficient funds') || lower.includes('exceeds balance')) {
        return { kind: 'insufficient_funds', message, retryable: false };
    }
    if (lower.includes('nonce') || lower.includes('replacement transaction underpriced')) {
        // Retryable once the in-flight transaction settles, which the write lock serializes within
        // one process. Seeing it at all means something else is signing with the same key — the
        // relayer, or a second CLI.
        return { kind: 'nonce_error', message, retryable: true };
    }
    // A receipt that never arrived is NOT a plain timeout. The transaction is broadcast and may
    // still be mined, so re-sending it is how a prize is funded twice.
    if (
        err instanceof WaitForTransactionReceiptTimeoutError ||
        err instanceof TransactionNotFoundError ||
        err instanceof TransactionReceiptNotFoundError
    ) {
        return { kind: 'unconfirmed', message, retryable: false };
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
        return { kind: 'timeout', message, retryable: true };
    }
    if (
        lower.includes('fetch failed') ||
        lower.includes('econnreset') ||
        lower.includes('etimedout') ||
        lower.includes('enotfound') ||
        lower.includes('eai_again') ||
        lower.includes('socket hang') ||
        lower.includes('429') ||
        lower.includes('rate limit')
    ) {
        return { kind: 'rpc_error', message, retryable: true };
    }
    // Unknown. Treated as NOT retryable, because retrying something we cannot classify is how a
    // loop burns the operator wallet's gas on a call that was never going to work.
    return { kind: 'rpc_error', message, retryable: false };
}

export interface CompetitionChain {
    /** The operator address, or undefined when this seam was built without a key. */
    readonly account: Address | undefined;
    readonly publicClient: PublicClient;
    readonly sealedCompetition: Address;

    // --- scans ---
    /** Every competition event in a block range, oldest first. The one way history is read. */
    readonly events: (args: ScanArgs) => Promise<CompetitionEvent[]>;
    /**
     * The block one competition was created in, found by a newest-first scan that stops at the
     * first hit. For a competition created recently this is a handful of windows; for an old one
     * it is the full walk, which is why callers that already know the block pass it instead.
     */
    readonly createdBlock: (competitionId: Hex, fromBlock: bigint) => Promise<bigint | undefined>;

    // --- reads ---
    readonly getCompetition: (competitionId: Hex) => Promise<CompetitionState>;
    readonly getSplit: (competitionId: Hex) => Promise<number[]>;
    /** The receipt hash anchored at settlement. `ZERO_HASH` while the competition is unsettled. */
    readonly settledReceiptHash: (competitionId: Hex) => Promise<Hex>;
    readonly staked: (competitionId: Hex, agent: Address) => Promise<bigint>;
    readonly cancelWindowSecs: () => Promise<bigint>;
    readonly blockNumber: () => Promise<bigint>;
    readonly allowance: (token: Address, spender: Address) => Promise<bigint>;
    readonly balanceOf: (token: Address, owner: Address) => Promise<bigint>;

    // --- writes (throw if this seam holds no key) ---
    readonly approve: (token: Address, spender: Address, amount: bigint) => Promise<TxOutcome>;
    readonly create: (args: CreateArgs) => Promise<TxOutcome>;
    readonly settle: (args: CompetitionSettleArgs) => Promise<TxOutcome>;
    readonly cancel: (competitionId: Hex) => Promise<TxOutcome>;
    readonly withdrawRemaining: (competitionId: Hex) => Promise<TxOutcome>;
}

const DEFAULT_POLL_MS = 3_000;
const DEFAULT_TX_TIMEOUT_MS = 120_000;

/**
 * Delay between log windows, so a long scan does not trip the endpoint's rate limiter.
 *
 * Coston2's public RPC answers a burst with a 429 that persists for long enough to exhaust the
 * scanner's retry budget, which turns a slow scan into a failed one. ~16 windows a second is
 * comfortably under the limit and still walks a day of blocks in under two minutes.
 */
const DEFAULT_SCAN_PACE_MS = 60;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Parse a `CompetitionCreated` log.
 *
 * A named function rather than an inline field check, so a decode failure is REPORTED. Filtering
 * malformed logs away inside `onLogs` makes genuine ABI drift look identical to a quiet stretch
 * with no competitions.
 */
function parseCreated(
    args: Record<string, unknown>,
    blockNumber: bigint | null,
): CreatedCompetition | undefined {
    const { competitionId, evaluatorId, kind, resolveAt, creator, lifetimeSecs, params } =
        args as Partial<{
            competitionId: Hex;
            evaluatorId: string;
            kind: number;
            resolveAt: bigint;
            creator: Address;
            lifetimeSecs: number;
            params: Hex;
        }>;
    if (competitionId === undefined || resolveAt === undefined) return undefined;
    return {
        competitionId,
        evaluatorId: evaluatorId ?? '',
        kind: Number(kind ?? 0),
        resolveAt,
        creator: creator ?? ZERO_ADDRESS,
        lifetimeSecs: Number(lifetimeSecs ?? 0),
        params: params ?? '0x',
        blockNumber: blockNumber ?? 0n,
    };
}

export function makeCompetitionChain(config: CompetitionChainConfig): CompetitionChain {
    const chain = config.chainId === coston2.id ? coston2 : { ...coston2, id: config.chainId };
    const transport = http(config.rpcUrl);
    const publicClient: PublicClient = createPublicClient({ chain, transport });

    // No key, no wallet client, no possibility of a write. The read service runs in exactly this
    // state, which is why "the service cannot move money" is a property of the process rather than
    // a promise about its code paths.
    const account: Account | undefined =
        config.privateKey === undefined ? undefined : privateKeyToAccount(config.privateKey);
    const walletClient: WalletClient | undefined =
        account === undefined ? undefined : createWalletClient({ chain, transport, account });

    const pollingInterval = config.pollMs ?? DEFAULT_POLL_MS;
    const paceMs = config.scanPaceMs ?? DEFAULT_SCAN_PACE_MS;
    const report = (where: string, err: unknown): void => config.onError?.(where, err);

    /**
     * Turn one decoded contract log into an event, or report it and skip.
     *
     * A named step rather than an inline filter, so a decode failure is REPORTED: dropping
     * malformed logs quietly makes genuine ABI drift look identical to a stretch with no activity.
     * An event this repo does not model (`Joined`, `StakeWithdrawn`, `PrizeClaimed`) is skipped
     * without a report — it is expected, not malformed.
     */
    function toEvent(log: {
        eventName?: string;
        args?: unknown;
        blockNumber?: bigint | null;
        transactionHash?: Hex | null;
    }): CompetitionEvent | undefined {
        const args = (log.args ?? {}) as Record<string, unknown>;
        const competitionId = args['competitionId'] as Hex | undefined;
        const blockNumber = log.blockNumber ?? 0n;

        switch (log.eventName) {
            case 'CompetitionCreated': {
                const competition = parseCreated(args, log.blockNumber ?? null);
                if (competition === undefined) {
                    report('decode:CompetitionCreated', new Error(JSON.stringify(args)));
                    return undefined;
                }
                return { type: 'created', competition };
            }
            case 'Joined': {
                const agent = args['agent'] as Address | undefined;
                if (competitionId === undefined || agent === undefined) {
                    report('decode:Joined', new Error(JSON.stringify(args)));
                    return undefined;
                }
                return { type: 'joined', competitionId, agent };
            }
            case 'Submitted': {
                const agent = args['agent'] as Address | undefined;
                if (competitionId === undefined || agent === undefined) {
                    report('decode:Submitted', new Error(JSON.stringify(args)));
                    return undefined;
                }
                return {
                    type: 'submitted',
                    competitionId,
                    submission: {
                        agent,
                        ciphertextHash: (args['ciphertextHash'] as Hex | undefined) ?? ZERO_HASH,
                        blockNumber,
                        txHash: log.transactionHash ?? ZERO_HASH,
                    },
                };
            }
            case 'PrizeAwarded': {
                const agent = args['agent'] as Address | undefined;
                const amount = args['amount'] as bigint | undefined;
                if (competitionId === undefined || agent === undefined || amount === undefined) {
                    report('decode:PrizeAwarded', new Error(JSON.stringify(args)));
                    return undefined;
                }
                return {
                    type: 'prize',
                    competitionId,
                    prize: { agent, rank: Number(args['rank'] ?? 0n), amount },
                };
            }
            case 'Settled': {
                if (competitionId === undefined) {
                    report('decode:Settled', new Error(JSON.stringify(args)));
                    return undefined;
                }
                return {
                    type: 'settled',
                    competitionId,
                    receiptHash: (args['receiptHash'] as Hex | undefined) ?? ZERO_HASH,
                };
            }
            case 'Cancelled': {
                if (competitionId === undefined) {
                    report('decode:Cancelled', new Error(JSON.stringify(args)));
                    return undefined;
                }
                return { type: 'cancelled', competitionId };
            }
            case 'ReceiptPublished': {
                const receipt = args['receipt'] as Hex | undefined;
                if (competitionId === undefined || receipt === undefined) {
                    report('decode:ReceiptPublished', new Error(JSON.stringify(args)));
                    return undefined;
                }
                return { type: 'receipt', competitionId, receipt };
            }
            default:
                return undefined;
        }
    }

    /**
     * Send a write, and do not return until the chain has answered.
     *
     * Serialized per address through `quadra-core`'s write lock, and the locked region is
     * simulate -> broadcast -> RECEIPT deliberately: releasing at broadcast hands the next send a
     * state that does not include this transaction. Within one process that is enough; the lock
     * cannot see a relayer or a second CLI signing with the same key, which is why the README asks
     * for a distinct operator wallet.
     */
    async function send(
        label: string,
        address: Address,
        abi: typeof sealedCompetitionAbi | typeof erc20Abi,
        functionName: string,
        args: readonly unknown[],
    ): Promise<TxOutcome> {
        if (account === undefined || walletClient === undefined) {
            throw new Error(
                `${label}: this chain seam holds no key. Build it with a privateKey to sign.`,
            );
        }
        return withWriteLock(account.address, async () => {
            let hash: Hex | undefined;
            try {
                const { request } = await publicClient.simulateContract({
                    address,
                    abi: abi as never,
                    functionName: functionName as never,
                    args: args as never,
                    account,
                });
                hash = await walletClient.writeContract(request as never);
                const receipt = await publicClient.waitForTransactionReceipt({
                    hash,
                    confirmations: config.confirmations ?? 1,
                    timeout: config.txTimeoutMs ?? DEFAULT_TX_TIMEOUT_MS,
                    pollingInterval,
                });
                if (receipt.status !== 'success') {
                    const message = `reverted on chain (tx ${hash})`;
                    report(label, new Error(message));
                    return { ok: false, kind: 'reverted_onchain', message, retryable: false, hash };
                }
                return { ok: true, hash, blockNumber: receipt.blockNumber, logs: receipt.logs };
            } catch (err) {
                report(label, err);
                // Before broadcast nothing left this process, so the normal rules apply. After
                // broadcast the transaction exists and may yet be mined — retrying it is how a
                // prize gets funded twice.
                if (hash === undefined) return { ok: false, ...classifyTxError(err) };
                const detail = err instanceof Error ? err.message : String(err);
                return {
                    ok: false,
                    kind: 'unconfirmed',
                    message: `broadcast but unconfirmed (tx ${hash}): ${detail}`,
                    retryable: false,
                    hash,
                };
            }
        });
    }

    /**
     * Every window of a log scan, through the CHUNKED walker.
     *
     * Never a raw range: Coston2's public RPC caps `eth_getLogs` at 30 blocks and rejects anything
     * wider outright, and a boot scan from the deploy block asks for millions.
     */
    async function scan<T>(
        args: ScanArgs & {
            fetch: (from: bigint, to: bigint) => Promise<T[]>;
            stopAtFirstHit?: boolean;
        },
    ): Promise<T[]> {
        return getLogsChunked<T>({
            client: publicClient,
            fromBlock: args.fromBlock,
            ...(args.toBlock === undefined ? {} : { toBlock: args.toBlock }),
            ...(args.onProgress === undefined ? {} : { onProgress: args.onProgress }),
            ...(args.stopAtFirstHit === undefined ? {} : { stopAtFirstHit: args.stopAtFirstHit }),
            fetch: async (from, to) => {
                // Paced. The scanner already retries a 429 with backoff, but a historical scan is
                // thousands of windows and firing them as fast as the event loop allows gets the
                // whole walk throttled rather than one window — the retry then burns its budget on
                // a limit that is still in force.
                if (paceMs > 0) await sleep(paceMs);
                return args.fetch(from, to);
            },
        });
    }

    return {
        account: account?.address,
        publicClient,
        sealedCompetition: config.sealedCompetition,

        async events(args) {
            // No `eventName`: one unfiltered pass decodes every event the ABI knows. Six filtered
            // passes over the same range would cost six times as much and learn the same things.
            const logs = await scan({
                ...args,
                fetch: (from, to) =>
                    publicClient.getContractEvents({
                        address: config.sealedCompetition,
                        abi: sealedCompetitionAbi,
                        fromBlock: from,
                        toBlock: to,
                    }),
            });
            const events: CompetitionEvent[] = [];
            for (const log of logs) {
                const event = toEvent(log);
                if (event !== undefined) events.push(event);
            }
            return events;
        },

        async createdBlock(competitionId, fromBlock) {
            const logs = await scan({
                fromBlock,
                stopAtFirstHit: true,
                fetch: (from, to) =>
                    publicClient.getContractEvents({
                        address: config.sealedCompetition,
                        abi: sealedCompetitionAbi,
                        eventName: 'CompetitionCreated',
                        args: { competitionId },
                        fromBlock: from,
                        toBlock: to,
                    }),
            });
            return logs.at(-1)?.blockNumber ?? undefined;
        },

        async getCompetition(competitionId) {
            const row = (await publicClient.readContract({
                address: config.sealedCompetition,
                abi: sealedCompetitionAbi,
                functionName: 'competitions',
                args: [competitionId],
            })) as readonly [
                string,
                Hex,
                number,
                bigint,
                bigint,
                bigint,
                bigint,
                bigint,
                bigint,
                boolean,
                boolean,
                boolean,
                Address,
                number,
                Hex,
            ];
            return {
                evaluatorId: row[0],
                category: row[1],
                kind: Number(row[2]),
                stake: row[3],
                seedPrize: row[4],
                stakedTotal: row[5],
                prizePool: row[6],
                resolveAt: row[7],
                threshold: row[8],
                exists: row[9],
                settled: row[10],
                cancelled: row[11],
                creator: row[12],
                lifetimeSecs: Number(row[13]),
                params: row[14],
            };
        },

        async getSplit(competitionId) {
            const split = (await publicClient.readContract({
                address: config.sealedCompetition,
                abi: sealedCompetitionAbi,
                functionName: 'getSplit',
                args: [competitionId],
            })) as readonly number[];
            return [...split];
        },

        settledReceiptHash: async (competitionId) =>
            (await publicClient.readContract({
                address: config.sealedCompetition,
                abi: sealedCompetitionAbi,
                functionName: 'settledReceiptHash',
                args: [competitionId],
            })) as Hex,

        staked: async (competitionId, agent) =>
            (await publicClient.readContract({
                address: config.sealedCompetition,
                abi: sealedCompetitionAbi,
                functionName: 'staked',
                args: [competitionId, agent],
            })) as bigint,

        cancelWindowSecs: async () =>
            (await publicClient.readContract({
                address: config.sealedCompetition,
                abi: sealedCompetitionAbi,
                functionName: 'CANCEL_WINDOW',
            })) as bigint,

        blockNumber: () => publicClient.getBlockNumber(),

        allowance: async (token, spender) => {
            if (account === undefined) return 0n;
            return (await publicClient.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [account.address, spender],
            })) as bigint;
        },

        balanceOf: async (token, owner) =>
            (await publicClient.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [owner],
            })) as bigint,

        approve: (token, spender, amount) =>
            send('approve', token, erc20Abi, 'approve', [spender, amount]),

        create: (args) =>
            send('create', config.sealedCompetition, sealedCompetitionAbi, 'create', [
                args.competitionId,
                args.evaluatorId,
                args.kind,
                args.stake,
                args.resolveAt,
                args.threshold,
                args.splitPct,
                args.prize,
                args.lifetimeSecs,
                args.params,
            ]),

        // The tuple arrives already ordered by `evalClient.competitionSettleArgs` and is passed
        // straight through. Re-ordering it here would be a second place to get the order wrong.
        settle: (args) =>
            send('settle', config.sealedCompetition, sealedCompetitionAbi, 'settle', args),

        cancel: (competitionId) =>
            send('cancel', config.sealedCompetition, sealedCompetitionAbi, 'cancel', [
                competitionId,
            ]),

        withdrawRemaining: (competitionId) =>
            send(
                'withdrawRemaining',
                config.sealedCompetition,
                sealedCompetitionAbi,
                'withdrawRemaining',
                [competitionId],
            ),
    };
}

/**
 * Find the `CompetitionCreated` id a transaction actually emitted.
 *
 * The create CLI derives the id locally and must prove the chain agreed. A second derivation that
 * disagrees does not collide visibly — it burns an id nobody can reproduce — so the emitted value
 * is checked against the derived one before a create is reported as successful.
 */
export function createdIdFromLogs(logs: readonly Log[], address: Address): Hex | undefined {
    for (const log of logs) {
        if (log.address.toLowerCase() !== address.toLowerCase()) continue;
        try {
            const decoded = decodeEventLog({
                abi: sealedCompetitionAbi,
                data: log.data,
                topics: log.topics,
            });
            if (decoded.eventName === 'CompetitionCreated') {
                return (decoded.args as { competitionId: Hex }).competitionId;
            }
        } catch {
            // Another event from the same contract (a Joined, a token Transfer): not a failure.
        }
    }
    return undefined;
}
