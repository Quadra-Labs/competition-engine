/**
 * settle-competition.ts — settle one competition by hand.
 *
 * NORMALLY YOU DO NOT NEED THIS. The scheduler's relayer watches every competition, asks the
 * enclave when one becomes due, and submits the settlement on its own — with attempt budgets, a
 * ledger and a funding pause this command does not have. This exists for the cases the relayer
 * cannot cover: it is not running, it is pointed at a different deployment, or an operator wants to
 * see exactly what the engine says about one competition.
 *
 * Nothing here holds authority. The settlement is signed inside the TEE against a key registered on
 * chain; this command fetches those bytes and forwards them. A hostile operator's only power is to
 * decline to run it. Racing the relayer is safe for the same reason — the second transaction to
 * arrive reverts `AlreadySettled`, and the simulation usually catches it before any gas is spent.
 */

import { makeCompetitionChain } from '../src/chain.js';
import { loadOrExit, requireKey } from '../src/config.js';
import { adviseOn, EngineRefusal, makeEvalClient } from '../src/evalClient.js';
import {
    explainTxFailure,
    explorerTx,
    fail,
    formatTime,
    parseArgs,
    requireId,
    runCli,
} from './shared.js';

const USAGE = `Usage: npm run settle-competition -- --id <0x...>

  --id <0x...>   The competition to settle.

The scheduler relayer settles competitions automatically; this is the manual path.`;

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

    // Check the chain first. The engine's guard ladder mirrors these same conditions, but asking it
    // to build a settlement for a competition that is already settled wastes an enclave round trip
    // on a question the contract answers for free.
    const state = await chain.getCompetition(competitionId);
    if (!state.exists) {
        fail(`No competition ${competitionId} on ${config.sealedCompetition}.`);
    }
    if (state.settled) {
        console.log(`${competitionId} is already settled. Nothing to do.`);
        return;
    }
    if (state.cancelled) {
        console.log(`${competitionId} was cancelled, so it can never settle.`);
        return;
    }
    const nowSecs = Math.floor(Date.now() / 1000);
    if (nowSecs < Number(state.resolveAt)) {
        fail(
            `${competitionId} resolves ${formatTime(Number(state.resolveAt))}; settling now would revert TooEarly.`,
        );
    }

    if (config.internalToken === undefined) {
        console.warn(
            '[competition] INTAKE_INTERNAL_TOKEN is unset: calling the engine unauthenticated.',
        );
    }

    const engine = makeEvalClient({
        baseUrl: config.evalUrl,
        token: config.internalToken,
        timeoutMs: config.evalTimeoutMs,
    });

    console.log(`asking ${config.evalUrl} for a signed settlement...`);
    let settlement;
    try {
        settlement = await engine.settleCompetition(competitionId);
    } catch (err) {
        if (err instanceof EngineRefusal) {
            fail(`the engine refused (${err.kind}): ${err.message}\n\n${adviseOn(err.kind)}`);
        }
        throw err;
    }

    const entries = settlement[4];
    console.log(`  signed over ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
    for (const entry of entries) console.log(`    ${entry.agent}  score ${entry.score}`);

    console.log('\nsubmitting settle()...');
    const sent = await chain.settle(settlement);
    if (!sent.ok) {
        explainTxFailure('settle', sent);
        process.exitCode = 1;
        return;
    }
    console.log(`settled ${competitionId}`);
    console.log(`  ${explorerTx(sent.hash)}`);
    console.log('  winners are paid through claimPrize(); the contract holds their balances.');
}

runCli(main);
