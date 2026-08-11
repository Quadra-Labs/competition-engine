/**
 * cancel-competition.ts — release a competition that can never settle.
 *
 * Cancelling refunds the creator's seed and frees every entrant's stake for `withdrawStake`. It is
 * permissionless once `resolveAt + CANCEL_WINDOW` (three days) has passed, which is the contract's
 * way of saying this is a liveness escape rather than an operator power: nobody can cancel a
 * competition out from under its entrants while it might still resolve.
 *
 * A DELIBERATELY MANUAL DECISION. The scheduler's relayer surfaces unsettleable competitions at
 * `/status` as `needs_cancel` and never acts on them, for the reason its abis.ts states: one
 * competition that cannot settle must not teach an automated process to close contests on its own.
 * This command is where a person makes that call.
 */

import { makeCompetitionChain } from '../src/chain.js';
import { loadOrExit, requireKey } from '../src/config.js';
import {
    explainTxFailure,
    explorerTx,
    fail,
    formatQuadra,
    formatTime,
    parseArgs,
    requireId,
    runCli,
} from './shared.js';

const USAGE = `Usage: npm run cancel-competition -- --id <0x...>

  --id <0x...>   The competition to cancel.

Permissionless, but only after resolveAt + CANCEL_WINDOW (3 days). Refunds the seed to the
creator and frees every stake for withdrawStake.`;

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args['help'] !== undefined) {
        console.log(USAGE);
        return;
    }

    const competitionId = requireId(args, USAGE);
    const config = loadOrExit();
    const privateKey = requireKey(config);

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
    if (state.cancelled) {
        console.log(`${competitionId} is already cancelled. Entrants can call withdrawStake.`);
        return;
    }
    if (state.settled) {
        console.log(`${competitionId} is settled, so it cannot be cancelled.`);
        return;
    }

    // Read the live constant rather than trusting the local copy: telling an operator a competition
    // is cancellable when the contract disagrees costs them a reverted transaction.
    const window = await chain.cancelWindowSecs();
    const cancelAt = Number(state.resolveAt) + Number(window);
    const nowSecs = Math.floor(Date.now() / 1000);
    if (nowSecs < cancelAt) {
        fail(
            [
                `${competitionId} cannot be cancelled yet.`,
                `  resolves    ${formatTime(Number(state.resolveAt))}`,
                `  cancellable ${formatTime(cancelAt)}  (resolveAt + ${Number(window)}s)`,
                '',
                'Until then it may still settle. If the engine says it never can, wait out the window.',
            ].join('\n'),
        );
    }

    console.log(`cancelling ${competitionId}`);
    console.log(`  seed to refund ${formatQuadra(state.seedPrize)}`);
    console.log(`  stakes to free ${formatQuadra(state.stakedTotal)}`);

    const sent = await chain.cancel(competitionId);
    if (!sent.ok) {
        explainTxFailure('cancel', sent);
        process.exitCode = 1;
        return;
    }
    console.log(`cancelled ${competitionId}`);
    console.log(`  ${explorerTx(sent.hash)}`);
    console.log(
        '  each entrant must now call withdrawStake(competitionId) to reclaim their stake.',
    );
}

runCli(main);
