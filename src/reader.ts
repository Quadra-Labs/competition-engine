/**
 * reader.ts — chain state assembled into what the API serves.
 *
 * Two sources, and the split matters. The MUTABLE numbers — prize pool, stake total, settled,
 * cancelled — come from a live `competitions()` read, because they change and the answer must be
 * current. The HISTORY — who submitted, what was paid, the published receipt — comes from the
 * registry's log index, because re-scanning it per request is what made the naive version
 * unusable against a rate-limited endpoint.
 *
 * The derivations mirror `data/src/chain/competitions.ts` rather than importing it: no migrated
 * repo depends on the `quadra-data` root package, which would pull the indexer's dependency tree
 * into a service that needs only `viem` and `quadra-core`. The traps that file documents are real,
 * and are repeated here as comments because a re-derivation is exactly where they come back.
 */

import type { Hex } from 'viem';
import type { CompetitionChain } from './chain.js';
import { toSummary, type CompetitionDetail, type CompetitionSummary } from './dto.js';
import { sealedLeaderboard, settledLeaderboard } from './leaderboard.js';
import type { IndexedCompetition } from './registry.js';

export interface CompetitionReader {
    /** One competition, fully assembled. Undefined when the id does not exist on chain. */
    readonly detail: (indexed: IndexedCompetition) => Promise<CompetitionDetail | undefined>;
    /** The list view: the same live read, without the receipt work only a detail page needs. */
    readonly summary: (indexed: IndexedCompetition) => Promise<CompetitionSummary | undefined>;
}

export function makeReader(chain: CompetitionChain): CompetitionReader {
    return {
        async summary(indexed) {
            const state = await chain.getCompetition(indexed.competitionId);
            // `exists` is an explicit field, never a sentinel. The Flare prototype inferred
            // existence from a non-zero `resolveAt`, which read a funded competition as nonexistent.
            if (!state.exists) return undefined;
            const splitPct = await chain
                .getSplit(indexed.competitionId)
                .catch(() => [] as number[]);
            return toSummary(
                indexed.competitionId,
                state,
                indexed.submissions,
                indexed.prizes,
                splitPct,
                indexed.joined,
            );
        },

        async detail(indexed) {
            const state = await chain.getCompetition(indexed.competitionId);
            if (!state.exists) return undefined;
            const splitPct = await chain
                .getSplit(indexed.competitionId)
                .catch(() => [] as number[]);

            const summary = toSummary(
                indexed.competitionId,
                state,
                indexed.submissions,
                indexed.prizes,
                splitPct,
            );

            // The anchored hash is read live rather than taken from the `Settled` log: it is what
            // the leaderboard checks the receipt body against, so it should come from storage.
            const receiptHash = state.settled
                ? await chain
                      .settledReceiptHash(indexed.competitionId)
                      .catch(() => indexed.receiptHash)
                : undefined;

            return {
                ...summary,
                ended: summary.status === 'ended',
                perfBase: 1_000_000,
                leaderboard: state.settled
                    ? settledLeaderboard(
                          indexed.submissions,
                          indexed.prizes,
                          indexed.receipt,
                          receiptHash,
                      )
                    : sealedLeaderboard(indexed.submissions),
                rules: {
                    kind: state.kind,
                    threshold: state.threshold.toString(),
                    split: splitPct,
                    lifetimeSecs: state.lifetimeSecs,
                    asset: summary.asset,
                    params: state.params,
                },
                ...(receiptHash === undefined ? {} : { receiptHash }),
            };
        },
    };
}
