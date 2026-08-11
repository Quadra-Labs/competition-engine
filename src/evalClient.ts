/**
 * evalClient.ts — asking the TEE for a signed settlement, over HTTP.
 *
 * The manual counterpart of `scheduler/src/engineClient.ts`: the relayer does this on a schedule,
 * this repo does it when an operator asks. The relationship is identical and so are its two rules,
 * restated here because getting either wrong is silent.
 *
 * 1. **Classify on `kind`, never on message text.** The engine's `{error, kind}` wire (see
 *    `evaluation-engine/src/errors.ts`) exists precisely because the Sui engine had to regex the
 *    enclave's prose to decide whether a failure was the agent's fault or the oracle's — a regex
 *    that had to be kept in sync by hand across two repos. `EngineRefusal` carries the kind
 *    through untouched.
 *
 * 2. **Rebuild the argument tuple in exactly one place.** Every integer crosses the wire as a
 *    DECIMAL STRING (JSON numbers are IEEE doubles, and a 1e-8-unit ground truth passes 2^53 at a
 *    price around $90m), so the tuple is reassembled with BigInt on this side. The order is the
 *    contract's, and the authority for it is
 *    `evaluation-engine/src/settlement.ts::competitionSettleArgs`. The dangerous detail: `proofs`
 *    is NOT adjacent to `groundTruthValues`, because `entries` and `signature` sit between them.
 */

import type { Address, Hex } from 'viem';

/** The engine's kinds, verbatim. `unauthorized` is the server's 401 shape, not an `EngineErrorKind`. */
export type EngineKind =
    | 'not-found'
    | 'too-early'
    | 'terminal'
    | 'unsupported'
    | 'upstream'
    | 'unauthorized'
    /** Ours: the engine could not be reached or answered something unparseable. */
    | 'unreachable';

/** A refusal the engine names. Never an exception type the caller has to string-match. */
export class EngineRefusal extends Error {
    constructor(
        readonly kind: EngineKind,
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'EngineRefusal';
    }
}

export interface WireFeedProof {
    readonly proof: readonly Hex[];
    readonly body: {
        readonly votingRoundId: number;
        readonly id: Hex;
        readonly value: number;
        readonly turnoutBPS: number;
        readonly decimals: number;
    };
}

export interface WireCompetitionSettlement {
    readonly competitionId: Hex;
    readonly feedIds: readonly Hex[];
    readonly groundTruthValues: readonly string[];
    readonly entries: readonly { readonly agent: Address; readonly score: string }[];
    readonly receiptHash: Hex;
    readonly receipt: Hex;
    readonly proofs: readonly WireFeedProof[];
    readonly signature: Hex;
}

export interface FeedDataWithProof {
    readonly proof: readonly Hex[];
    readonly body: {
        readonly votingRoundId: number;
        readonly id: Hex;
        readonly value: number;
        readonly turnoutBPS: number;
        readonly decimals: number;
    };
}

/** `SealedCompetition.settle` — SealedCompetition.sol:480-489. */
export type CompetitionSettleArgs = readonly [
    Hex,
    Hex,
    readonly Hex[],
    readonly bigint[],
    readonly { agent: Address; score: bigint }[],
    Hex,
    readonly FeedDataWithProof[],
    Hex,
];

export interface EvalClient {
    readonly baseUrl: string;
    readonly settleCompetition: (competitionId: Hex) => Promise<CompetitionSettleArgs>;
}

export interface EvalClientOptions {
    readonly baseUrl: string;
    /** Sent as `x-intake-token`. The engine guards its POST routes only when it has one set. */
    readonly token: string | undefined;
    readonly timeoutMs: number;
}

/** `proofs` crosses as plain JSON; the shape already matches the Solidity struct. */
function toFeedProof(wire: WireFeedProof): FeedDataWithProof {
    return { proof: wire.proof, body: wire.body };
}

/**
 * Rebuild `SealedCompetition.settle`'s arguments.
 *
 * Mirrors `evaluation-engine/src/settlement.ts::competitionSettleArgs` and
 * `scheduler/src/engineClient.ts::competitionSettleArgs`. An entry's `score` is uint64 — a
 * performance metric around 1e6, not the uint8 a paid job carries — so it becomes a BigInt.
 */
export function competitionSettleArgs(wire: WireCompetitionSettlement): CompetitionSettleArgs {
    return [
        wire.competitionId,
        wire.receiptHash,
        wire.feedIds,
        wire.groundTruthValues.map((v) => BigInt(v)),
        wire.entries.map((e) => ({ agent: e.agent, score: BigInt(e.score) })),
        wire.signature,
        wire.proofs.map(toFeedProof),
        wire.receipt,
    ];
}

const KNOWN_KINDS = new Set<string>([
    'not-found',
    'too-early',
    'terminal',
    'unsupported',
    'upstream',
    'unauthorized',
]);

/**
 * Turn a non-2xx answer into a typed refusal.
 *
 * An unrecognised body is `upstream` rather than a guess: a proxy's HTML error page says the engine
 * is unwell, which is worth retrying, and inventing a terminal kind from an unparseable body would
 * tell an operator a competition can never settle when a gateway simply hiccupped.
 */
function refusalFrom(status: number, body: string): EngineRefusal {
    let kind: EngineKind = 'upstream';
    let message = body.slice(0, 300);
    try {
        const parsed = JSON.parse(body) as { error?: unknown; kind?: unknown };
        if (typeof parsed.kind === 'string' && KNOWN_KINDS.has(parsed.kind)) {
            kind = parsed.kind as EngineKind;
        } else if (status === 401) {
            kind = 'unauthorized';
        }
        if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
        if (status === 401) kind = 'unauthorized';
    }
    return new EngineRefusal(kind, message, status);
}

/** What an operator should do about each refusal, in one line. Printed, never branched on. */
export function adviseOn(kind: EngineKind): string {
    switch (kind) {
        case 'too-early':
            return 'the competition has not resolved yet, or its ground truth is not final on the DA layer. Wait a few voting rounds (90s each) and try again.';
        case 'terminal':
            return 'this competition can never settle. Once resolveAt + CANCEL_WINDOW has passed, cancel-competition refunds the seed and frees the stakes.';
        case 'unsupported':
            return "the engine has no scorer for this competition's evaluator, so nothing can sign a settlement for it.";
        case 'not-found':
            return "the engine cannot see this competition. Check its FROM_BLOCK is not above the competition's creation block, and that both processes point at the same deployment.";
        case 'unauthorized':
            return 'the engine rejected the token. Set INTAKE_INTERNAL_TOKEN to the same value on both sides.';
        case 'upstream':
            return 'the engine failed on something outside itself (the oracle, the DA layer, the RPC). Worth retrying.';
        case 'unreachable':
            return 'the engine did not answer. Check EVAL_URL and that the evaluation engine is running.';
    }
}

export function makeEvalClient(options: EvalClientOptions): EvalClient {
    const base = options.baseUrl.replace(/\/+$/, '');

    async function call<T>(path: string, body: unknown): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs);
        try {
            const res = await fetch(`${base}${path}`, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'content-type': 'application/json',
                    ...(options.token === undefined ? {} : { 'x-intake-token': options.token }),
                },
                body: JSON.stringify(body),
            });
            const text = await res.text();
            if (!res.ok) throw refusalFrom(res.status, text);
            return JSON.parse(text) as T;
        } catch (err) {
            if (err instanceof EngineRefusal) throw err;
            // A timeout or a dropped socket is the engine being unreachable, which must never be
            // mistaken for a refusal: an enclave that is merely restarting would otherwise look
            // like one that answered "this can never settle".
            const detail = err instanceof Error ? err.message : String(err);
            const why =
                err instanceof Error && err.name === 'AbortError'
                    ? `no answer within ${options.timeoutMs}ms`
                    : detail;
            throw new EngineRefusal('unreachable', `${base}${path}: ${why}`);
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        baseUrl: base,

        /**
         * Retry only what the TRANSPORT lost — never a refusal the engine actually made.
         *
         * A refusal, including a 502 `upstream`, goes straight back to the caller: an operator
         * running a CLI can decide to try again, and quietly retrying an engine that is serving the
         * intake engine's money path is how one command becomes three requests.
         */
        async settleCompetition(competitionId) {
            const maxAttempts = 3;
            for (let attempt = 1; ; attempt += 1) {
                try {
                    return competitionSettleArgs(
                        await call<WireCompetitionSettlement>('/settle-competition', {
                            competitionId,
                        }),
                    );
                } catch (err) {
                    const lost = err instanceof EngineRefusal && err.kind === 'unreachable';
                    if (!lost || attempt >= maxAttempts) throw err;
                    await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
                }
            }
        },
    };
}
