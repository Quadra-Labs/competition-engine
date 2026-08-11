/**
 * leaderboard.ts — who is in, and once it is over, how they did.
 *
 * On Sui the engine wrote every score itself, so a running competition had a live ranking that grew
 * as jobs were graded. On Flare it cannot: submissions are encrypted to the TEE and opened exactly
 * once, inside the enclave, at settlement. Until then there is no score to show anywhere — not in
 * the contract, not in an event, not in the calldata.
 *
 * So this file builds two different things. Before settlement: the entrant list, marked `sealed`.
 * After: the ranking parsed out of the published receipt, merged with the prizes actually paid. The
 * receipt is the only source for per-entry scores — `Settled` carries a count and a total, and
 * there is no per-score event by design.
 */

import { keccak256 } from 'viem';
import { parseReceipt } from 'quadra-core/verify';
import type { Hex } from 'viem';
import { ZERO_HASH, type PrizeLog, type SubmissionLog } from './chain.js';
import type { Leaderboard, LeaderboardRow } from './dto.js';

/**
 * `PrizeAwarded.rank` is 0-BASED — the contract's payout loop starts at zero
 * (`SealedCompetition.sol:664`). Every rank this file emits is 1-based, so the winner of a
 * competition is rank 1 next to `rank: 1` in the same row rather than a 0 that reads like an error.
 */
const displayRank = (contractRank: number): number => contractRank + 1;

/** The entrant list of a running competition. Names who is in; reveals nothing about what they said. */
export function sealedLeaderboard(submissions: readonly SubmissionLog[]): Leaderboard {
    return {
        sealed: true,
        rows: submissions.map((s) => ({ agent: s.agent })),
    };
}

/**
 * The final ranking, from the published receipt.
 *
 * `receiptBody` is verified against the anchored `receiptHash` before it is parsed. The body comes
 * from an event, and an event is only as trustworthy as the hash in storage that commits to it —
 * checking costs one keccak and turns "some bytes a node handed us" into the artifact the
 * settlement signature covered.
 *
 * A receipt that fails either check yields the sealed view rather than an exception: an operator
 * looking at a settled competition should see its entrants and prizes, not a stack trace.
 */
export function settledLeaderboard(
    submissions: readonly SubmissionLog[],
    prizes: readonly PrizeLog[],
    receiptBody: Hex | undefined,
    anchoredReceiptHash: Hex | undefined,
): Leaderboard {
    const awards = new Map<string, PrizeLog>();
    for (const prize of prizes) awards.set(prize.agent.toLowerCase(), prize);

    const scored = scoresFrom(receiptBody, anchoredReceiptHash);
    if (scored === undefined) {
        // Settled, but the receipt is unreadable or was published outside the scanned window. The
        // prizes are still on chain, so rank by what was paid rather than pretending nothing exists.
        const rows: LeaderboardRow[] = submissions.map((s) => {
            const award = awards.get(s.agent.toLowerCase());
            return {
                agent: s.agent,
                ...(award === undefined
                    ? {}
                    : {
                          awarded: award.amount.toString(),
                          awardRank: displayRank(award.rank),
                      }),
            };
        });
        return { sealed: true, rows };
    }

    const rows: LeaderboardRow[] = scored
        .map(({ agent, score }) => {
            const award = awards.get(agent.toLowerCase());
            return {
                agent,
                score,
                ...(award === undefined
                    ? {}
                    : {
                          awarded: award.amount.toString(),
                          awardRank: displayRank(award.rank),
                      }),
            };
        })
        .sort((a, b) => b.score - a.score)
        .map((row, i) => ({ ...row, rank: i + 1 }));

    return { sealed: false, rows };
}

/**
 * The receipt's entries, or undefined if the body is missing, unanchored or unparseable.
 *
 * FAIL-CLOSED on a missing anchor. The body arrives in an event, and an event is only as
 * trustworthy as the storage slot that commits to it; with no anchor to compare against there is
 * nothing tying these scores to the settlement, so they are not served as if there were.
 */
function scoresFrom(
    receiptBody: Hex | undefined,
    anchoredReceiptHash: Hex | undefined,
): { agent: `0x${string}`; score: number }[] | undefined {
    if (receiptBody === undefined || receiptBody === '0x') return undefined;
    if (anchoredReceiptHash === undefined || anchoredReceiptHash === ZERO_HASH) return undefined;
    if (keccak256(receiptBody).toLowerCase() !== anchoredReceiptHash.toLowerCase()) {
        return undefined;
    }
    try {
        return parseReceipt(receiptBody).entries.map((e) => ({ agent: e.agent, score: e.score }));
    } catch {
        return undefined;
    }
}
