/**
 * index.ts — the library surface, and the process.
 *
 * Both, in one file, guarded by the entrypoint check at the bottom: importing this module gives you
 * the pieces, running it starts the read API. The Sui version kept a separate `server.ts` because
 * the process was an Express app, a Socket.IO hub and a settlement engine at once; what is left is
 * only the first of those.
 *
 * THIS PROCESS HOLDS NO KEY. The chain seam is built without one, so the running service physically
 * cannot sign a transaction — not by misconfiguration, not by a code path nobody reviewed. Writing
 * is the CLIs' job, and they load the key themselves.
 */

import { pathToFileURL } from 'node:url';

export {
    sealedCompetitionAbi,
    erc20Abi,
    KIND_SCORING,
    KIND_PERFORMANCE,
    PERF_BASE,
    CANCEL_WINDOW_SECS,
} from './abis.js';
export {
    coston2,
    makeCompetitionChain,
    classifyTxError,
    createdIdFromLogs,
    ZERO_ADDRESS,
    ZERO_HASH,
    type CompetitionChain,
    type CompetitionChainConfig,
    type CompetitionState,
    type CompetitionEvent,
    type CreatedCompetition,
    type CreateArgs,
    type PrizeLog,
    type ScanArgs,
    type SubmissionLog,
    type TxOutcome,
    type TxErrorKind,
} from './chain.js';
export {
    loadOpsConfig,
    loadOrExit,
    requireKey,
    explainProblems,
    envSearchPaths,
    type OpsConfig,
    type ConfigResult,
} from './config.js';
export { loadDotEnv } from './dotenv.js';
export {
    makeEvalClient,
    competitionSettleArgs,
    adviseOn,
    EngineRefusal,
    type EvalClient,
    type EngineKind,
    type CompetitionSettleArgs,
    type WireCompetitionSettlement,
} from './evalClient.js';
export {
    statusOf,
    prizeOf,
    toSummary,
    type CompetitionStatus,
    type CompetitionSummary,
    type CompetitionDetail,
    type CompetitionRules,
    type Leaderboard,
    type LeaderboardRow,
} from './dto.js';
export { sealedLeaderboard, settledLeaderboard } from './leaderboard.js';
export { makeReader, type CompetitionReader } from './reader.js';
export {
    makeRegistry,
    entrantsOf,
    type Registry,
    type IndexedCompetition,
    type RegistryStats,
} from './registry.js';
export { makeServer, type ServerDeps, type RunningServer } from './server.js';

import { makeCompetitionChain } from './chain.js';
import { explainProblems, loadOpsConfig } from './config.js';
import { makeReader } from './reader.js';
import { makeRegistry } from './registry.js';
import { makeServer } from './server.js';

async function main(): Promise<void> {
    const loaded = loadOpsConfig();
    if (!loaded.ok) {
        // Every problem at once. An operator should need one restart, not four.
        console.error(explainProblems(loaded.problems, Number(process.env['CHAIN_ID'] ?? 114)));
        process.exit(1);
    }
    const config = loaded.config;

    const chain = makeCompetitionChain({
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        sealedCompetition: config.sealedCompetition,
        pollMs: config.pollMs,
        onError: (where, err) =>
            console.error(
                `[competition] ${where}: ${err instanceof Error ? err.message : String(err)}`,
            ),
    });

    const registry = makeRegistry({
        chain,
        fromBlock: config.fromBlock,
        pollMs: config.pollMs,
        log: (line) => console.log(line),
    });
    const reader = makeReader(chain);

    console.log(
        `[competition] reading SealedCompetition ${config.sealedCompetition} on chain ${config.chainId}`,
    );
    await registry.start();

    const server = makeServer({
        registry,
        reader,
        chainId: config.chainId,
        sealedCompetition: config.sealedCompetition,
        corsOrigin: config.corsOrigin,
        port: config.port,
        log: (line) => console.log(line),
    });

    // Without this a Ctrl-C or a pm2 restart leaves the watchers polling and the port bound for as
    // long as the runtime takes to tear itself down. The Sui service had no shutdown handler at all.
    let closing = false;
    const shutdown = (signal: string): void => {
        if (closing) return;
        closing = true;
        console.log(`[competition] ${signal} received, stopping`);
        registry.stop();
        server.close(() => process.exit(0));
        // A client holding a socket open must not keep the process alive forever.
        setTimeout(() => process.exit(0), 5_000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
    main().catch((err: unknown) => {
        console.error(
            `[competition] failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
    });
}
