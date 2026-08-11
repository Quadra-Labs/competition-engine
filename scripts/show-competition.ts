/**
 * show-competition.ts — everything the chain knows about one competition.
 *
 * The Sui version of this command decrypted an agent's delivered result with the engine's Seal key
 * and printed it. That is gone, and its absence is the point: a submission is encrypted to the
 * TEE's key, which this repo does not hold and cannot hold. Nobody — not the operator, not the
 * competition's creator — can read an entry before settlement.
 *
 * What a settled competition does reveal is the published receipt, which carries every entrant's
 * decrypted submission and score. That is the designed reveal: sealed while it runs, public once it
 * is over.
 */

import { formatUnits } from 'viem';
import { makeCompetitionChain } from '../src/chain.js';
import { loadOrExit } from '../src/config.js';
import { makeReader } from '../src/reader.js';
import { makeRegistry } from '../src/registry.js';
import {
    fail,
    formatQuadra,
    formatTime,
    kindName,
    parseArgs,
    requireId,
    runCli,
} from './shared.js';

const USAGE = `Usage: npm run show-competition -- --id <0x...>

  --id <0x...>   The competition to inspect.`;

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args['help'] !== undefined) {
        console.log(USAGE);
        return;
    }

    const competitionId = requireId(args, USAGE);
    const config = loadOrExit();

    const chain = makeCompetitionChain({
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        sealedCompetition: config.sealedCompetition,
    });

    const state = await chain.getCompetition(competitionId);
    if (!state.exists) {
        fail(`No competition ${competitionId} on ${config.sealedCompetition}.`);
    }

    // One pass from FROM_BLOCK, the same the service does at boot. It reads every competition's
    // events, not just this one's — that costs nothing extra, because the price of a log scan is
    // the number of 30-block windows it walks, not the number of events it decodes.
    const registry = makeRegistry({
        chain,
        fromBlock: config.fromBlock,
        pollMs: config.pollMs,
        log: () => undefined,
    });
    const indexed = await registry.discover(competitionId);
    if (indexed === undefined) {
        fail(
            `Found the competition on chain, but no CompetitionCreated log above block ${config.fromBlock}.\n` +
                'Lower FROM_BLOCK to the deploy block to read its entrants and prizes.',
        );
    }

    const detail = await makeReader(chain).detail(indexed);
    if (detail === undefined) {
        fail('The competition disappeared between reads. Try again.');
    }

    console.log(`${detail.id}`);
    console.log(`  evaluator   ${detail.evaluatorId}`);
    console.log(`  kind        ${kindName(detail.kind)}`);
    console.log(
        `  status      ${detail.cancelled ? 'cancelled' : detail.settled ? 'settled' : detail.status}`,
    );
    console.log(`  creator     ${detail.creator}`);
    console.log(`  created     block ${indexed.createdBlock}`);
    console.log(`  resolves    ${formatTime(Math.floor(detail.endsAt / 1000))}`);
    console.log(`  window      ${detail.lifetimeSecs}s (scored, ending at resolveAt)`);
    console.log(`  asset       ${detail.asset ?? 'not declared'}`);
    console.log(`  params      ${detail.rules.params}`);
    console.log(`  stake       ${formatQuadra(BigInt(detail.stake))}`);
    console.log(
        `  prize       ${formatUnits(BigInt(detail.prize), 18)} QUADRA` +
            `${detail.settled ? ' (paid out)' : ' (seed + stakes so far)'}`,
    );
    console.log(`  threshold   ${detail.threshold}`);
    console.log(`  split       ${detail.rules.split.join(',')} (${detail.winners} slots)`);
    if (detail.receiptHash !== undefined) console.log(`  receipt     ${detail.receiptHash}`);

    console.log(`\nentrants (${indexed.submissions.length})`);
    if (indexed.submissions.length === 0) {
        console.log(
            '  none. A competition with no submissions can never settle — see cancel-competition.',
        );
    }
    for (const s of indexed.submissions) {
        // Per-agent stake read live: an entrant's stake is what they actually paid, which is not
        // necessarily the competition's current `stake`.
        const staked = await chain.staked(competitionId, s.agent);
        console.log(`  ${s.agent}`);
        console.log(`    commitment ${s.ciphertextHash}`);
        console.log(`    staked ${formatQuadra(staked)}  block ${s.blockNumber}  tx ${s.txHash}`);
    }

    console.log(`\nleaderboard`);
    if (detail.leaderboard.sealed) {
        console.log(
            '  sealed. Submissions are encrypted to the TEE and are opened only at settlement,',
        );
        console.log('  so no score exists yet — on chain or anywhere else.');
        for (const row of detail.leaderboard.rows) {
            const award =
                row.awarded === undefined
                    ? ''
                    : `  awarded ${formatUnits(BigInt(row.awarded), 18)}`;
            console.log(`  ${row.agent}${award}`);
        }
    } else {
        for (const row of detail.leaderboard.rows) {
            const award =
                row.awarded === undefined
                    ? ''
                    : `  awarded ${formatUnits(BigInt(row.awarded), 18)} QUADRA (rank ${row.awardRank})`;
            console.log(`  ${row.rank}. ${row.agent}  score ${row.score}${award}`);
        }
    }
}

runCli(main);
