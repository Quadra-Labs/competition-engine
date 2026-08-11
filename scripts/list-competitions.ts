/**
 * list-competitions.ts — what exists on chain, as a table.
 *
 * Reads directly rather than through the service, so it works whether or not anything is running.
 * That means paying for the log scan every invocation — one pass over the range, the same pass the
 * service does once at boot — so `--lookback` is there for when the deploy block is far behind and
 * only recent competitions matter.
 *
 * The Sui version appended the engine's `/status` when it could reach it, and that is kept: it is
 * the quickest way to see whether the read API is indexing the same set this scan just found.
 */

import { formatUnits } from 'viem';
import { makeCompetitionChain } from '../src/chain.js';
import { loadOrExit } from '../src/config.js';
import { makeReader } from '../src/reader.js';
import { makeRegistry } from '../src/registry.js';
import { formatTime, kindName, parseArgs, runCli } from './shared.js';

const USAGE = `Usage: npm run list-competitions -- [options]

  --lookback <blocks>   Scan back this many blocks from the head instead of from FROM_BLOCK.
  --url <base>          Read API to append status from (default: http://localhost:5100).
  --no-status           Skip the read API entirely.`;

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args['help'] !== undefined) {
        console.log(USAGE);
        return;
    }

    const config = loadOrExit();
    const chain = makeCompetitionChain({
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        sealedCompetition: config.sealedCompetition,
    });

    let floor = config.fromBlock;
    if (args['lookback'] !== undefined) {
        const lookback = BigInt(args['lookback']);
        const head = await chain.blockNumber();
        floor = head > lookback ? head - lookback : 0n;
    }

    console.log(`SealedCompetition ${config.sealedCompetition} on chain ${config.chainId}`);
    console.log(`scanning from block ${floor}\n`);

    // The same index the service builds, built once here and thrown away when the process exits.
    const registry = makeRegistry({
        chain,
        fromBlock: floor,
        pollMs: config.pollMs,
        log: (line) => console.log(line),
    });
    await registry.start();
    registry.stop();

    const indexed = registry.list();
    if (indexed.length === 0) {
        console.log('\nNo competitions found. If you expect some, check FROM_BLOCK is not above');
        console.log('the block SealedCompetition was deployed in.');
        return;
    }

    const reader = makeReader(chain);
    console.log('');
    for (const entry of indexed) {
        const summary = await reader.summary(entry);
        if (summary === undefined) {
            console.log(`${entry.competitionId}  (no longer readable on chain)`);
            continue;
        }
        const state = summary.cancelled
            ? 'cancelled'
            : summary.settled
              ? 'settled'
              : summary.status;
        console.log(`${summary.id}`);
        console.log(
            `  ${summary.evaluatorId}  ${kindName(summary.kind)}  ${state}` +
                `${summary.asset === undefined ? '' : `  asset ${summary.asset}`}`,
        );
        console.log(
            `  prize ${formatUnits(BigInt(summary.prize), 18)} QUADRA` +
                `  stake ${formatUnits(BigInt(summary.stake), 18)}` +
                `  entrants ${summary.entrants}` +
                `  slots ${summary.winners}` +
                `  threshold ${summary.threshold}`,
        );
        console.log(
            `  resolves ${formatTime(Math.floor(summary.endsAt / 1000))}` +
                `  window ${summary.lifetimeSecs}s  block ${entry.createdBlock}`,
        );
        console.log('');
    }
    console.log(`${indexed.length} competition${indexed.length === 1 ? '' : 's'}`);

    if (args['no-status'] === undefined) await appendStatus(args['url'] ?? 'http://localhost:5100');
}

/** Best-effort: the read API is optional, and its absence is not an error for this command. */
async function appendStatus(baseUrl: string): Promise<void> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/status`, {
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return;
        const status = (await res.json()) as Record<string, unknown>;
        console.log(`\nread API at ${baseUrl}:`);
        console.log(
            `  indexed ${status['competitions']}  active ${status['active']}  ended ${status['ended']}` +
                `  tailing ${status['tailing']}`,
        );
        if (status['lastScanError'] !== undefined) {
            console.log(`  last scan error: ${String(status['lastScanError'])}`);
        }
    } catch {
        // Not running, or not reachable. Nothing to report.
    }
}

runCli(main);
