/**
 * withdraw-remaining.ts — reclaim what a settled competition did not pay out.
 *
 * Two things leave money in the pool. A slot lapses when fewer entrants clear the threshold than
 * there are winner slots, and every share is `floor(prize * pct / 100)`, so the remainder of the
 * division stays behind. Both belong to the creator, and only after settlement.
 *
 * Creator-only, so the wallet in COMPETITION_PRIVATE_KEY must be the one that created it.
 */

import { makeCompetitionChain } from '../src/chain.js';
import { loadOrExit, requireKey } from '../src/config.js';
import { privateKeyToAccount } from 'viem/accounts';
import {
    explainTxFailure,
    explorerTx,
    fail,
    formatQuadra,
    parseArgs,
    requireId,
    runCli,
} from './shared.js';

const USAGE = `Usage: npm run withdraw-remaining -- --id <0x...>

  --id <0x...>   The settled competition to reclaim dust from.

Creator-only, and only after settlement.`;

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args['help'] !== undefined) {
        console.log(USAGE);
        return;
    }

    const competitionId = requireId(args, USAGE);
    const config = loadOrExit();
    const privateKey = requireKey(config);
    const wallet = privateKeyToAccount(privateKey).address;

    const chain = makeCompetitionChain({
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        sealedCompetition: config.sealedCompetition,
        privateKey,
        txTimeoutMs: config.txTimeoutMs,
        confirmations: config.confirmations,
    });

    const state = await chain.getCompetition(competitionId);
    if (!state.exists) {
        fail(`No competition ${competitionId} on ${config.sealedCompetition}.`);
    }
    if (!state.settled) {
        fail(`${competitionId} is not settled yet; the pool is still the prize, not remainder.`);
    }
    if (state.creator.toLowerCase() !== wallet.toLowerCase()) {
        fail(
            [
                `${competitionId} was created by ${state.creator}, and only the creator can reclaim.`,
                `  this wallet ${wallet}`,
            ].join('\n'),
        );
    }
    if (state.prizePool === 0n) {
        console.log(`${competitionId} has nothing left in the pool.`);
        return;
    }

    console.log(`reclaiming ${formatQuadra(state.prizePool)} from ${competitionId}`);
    const sent = await chain.withdrawRemaining(competitionId);
    if (!sent.ok) {
        explainTxFailure('withdrawRemaining', sent);
        process.exitCode = 1;
        return;
    }
    console.log(`  ${explorerTx(sent.hash)}`);
}

runCli(main);
