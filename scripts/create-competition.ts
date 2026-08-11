/**
 * create-competition.ts — open a competition on Coston2.
 *
 * THE ID IS DERIVED, NOT RETURNED. `competitionId = keccak256(abi.encode(operator, label))`, which
 * is also what `contracts/script/CreateCompetition.s.sol:67` computes. Two derivations that
 * disagree do not collide visibly — the create succeeds under an id nobody can reproduce, and the
 * QUADRA that funded it is stranded behind an id no tool will look up. So this script derives the
 * id, sends the transaction, and then reads the id back out of the emitted `CompetitionCreated`
 * before reporting success. If they differ it says so loudly rather than printing the one it
 * guessed.
 *
 * Binding the id to the operator address is deliberate on the contract's side: it means two
 * operators can both use the label "btc-daily" without one squatting the other's id.
 */

import { EVALUATOR_IDS, isEvaluatorId } from 'quadra-core';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { KIND_PERFORMANCE, MAX_PARAMS_BYTES, PERF_BASE } from '../src/abis.js';

/**
 * The ROI evaluator. Not in `quadra-core`'s scorer registry because it cannot be publicly
 * replayed — the trades it is derived from are private — but the enclave does score it, so it is a
 * legitimate choice for a performance competition. See KNOWN-CONSTRAINTS entry 2.
 */
const PORTFOLIO_EVALUATOR = 'portfolio-roi';
import { createdIdFromLogs, makeCompetitionChain } from '../src/chain.js';
import { loadOrExit, requireKey } from '../src/config.js';
import {
    explainTxFailure,
    explorerTx,
    fail,
    formatQuadra,
    formatTime,
    kindName,
    parseArgs,
    parseDurationSecs,
    parseKind,
    parseSplit,
    requireArg,
    runCli,
    toBaseUnits,
} from './shared.js';

const USAGE = `Usage: npm run create-competition -- --label <name> [options]

  --label <name>          Required. Hashed with your operator address into the competition id.
  --evaluator <id>        Scorer to grade it with (default: price-range-guess). Checked against
                          the scorers this build can settle; --force overrides.
  --kind scoring|performance
                          Default: scoring. Note that agents cannot currently ENTER a
                          performance competition — see KNOWN-CONSTRAINTS.
  --stake <QUADRA>        Per-agent entry stake (default: 0, free to enter).
  --prize <QUADRA>        Seed prize you fund (default: 0). Approved and pulled on create.
  --resolve-in <30m|2h>   When it resolves, from now (default: 6h).
  --resolve-at <unixsecs> Absolute alternative to --resolve-in.
  --threshold <n>         Ranking value needed to be paid. Default: 1 for scoring,
                          1000000 (PERF_BASE, i.e. ROI >= 0) for performance.
  --split 60,40           Winner split in percent, must sum to 100 (default: 100).
  --lifetime <15m>        Scored window ending at resolveAt (default: 1h).
  --asset ETH             Shorthand for --params-json '{"asset":"ETH"}'.
  --params-json <json>    Raw scope blob, max 512 bytes on chain.
  --force                 Create even if the evaluator is one this build cannot settle.
  --dry-run               Derive and print the id and the arguments; send nothing.`;

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args['help'] !== undefined) {
        console.log(USAGE);
        return;
    }

    const config = loadOrExit();
    const privateKey = requireKey(config);
    const operator = privateKeyToAccount(privateKey).address;

    const label = requireArg(args, 'label', USAGE);
    const kind = parseKind(args['kind'] ?? 'scoring');
    const evaluatorId = checkedEvaluator(
        (args['evaluator'] ?? 'price-range-guess').trim(),
        kind,
        args['force'] !== undefined,
    );
    const stake = toBaseUnits(args['stake'] ?? '0', '--stake');
    const prize = toBaseUnits(args['prize'] ?? '0', '--prize');
    const splitPct = parseSplit(args['split'] ?? '100');
    const lifetimeSecs = parseDurationSecs(args['lifetime'] ?? '1h', '--lifetime');

    const nowSecs = Math.floor(Date.now() / 1000);
    const resolveAt =
        args['resolve-at'] !== undefined
            ? Number(args['resolve-at'])
            : nowSecs + parseDurationSecs(args['resolve-in'] ?? '6h', '--resolve-in');
    if (!Number.isFinite(resolveAt) || resolveAt <= nowSecs) {
        fail(`resolveAt must be in the future (got ${resolveAt}, now is ${nowSecs})`);
    }
    // Zero is the ONLY value the contract rejects (BadLifetime). There is deliberately no upper
    // bound: a window longer than the competition has existed reaches back before it was created,
    // which is a legitimate thing to score — "resolve in 30 minutes, grade the last 24 hours" is a
    // real competition. Catching the zero here saves a reverted simulation.
    if (lifetimeSecs === 0) {
        fail('--lifetime must be greater than zero; the contract rejects a zero scored window');
    }

    const threshold = BigInt(
        args['threshold'] ?? (kind === KIND_PERFORMANCE ? PERF_BASE.toString() : '1'),
    );

    const params = paramsFrom(args['params-json'], args['asset']);

    // `abi.encode`, not `encodePacked`: a packed encoding of (address, string) is ambiguous, and
    // the Solidity side uses abi.encode. This is the whole reason the two must be read together.
    const competitionId = keccak256(
        encodeAbiParameters([{ type: 'address' }, { type: 'string' }], [operator, label]),
    );

    console.log(`operator      ${operator}`);
    console.log(`label         ${label}`);
    console.log(`competitionId ${competitionId}`);
    console.log(`evaluator     ${evaluatorId}`);
    console.log(`kind          ${kindName(kind)}`);
    console.log(`stake         ${formatQuadra(stake)}`);
    console.log(`prize         ${formatQuadra(prize)}`);
    console.log(`threshold     ${threshold}`);
    console.log(`split         ${splitPct.join(',')} (${splitPct.length} winner slots)`);
    console.log(`lifetime      ${lifetimeSecs}s`);
    console.log(`resolveAt     ${formatTime(resolveAt)}`);
    console.log(`params        ${params}`);

    if (args['dry-run'] !== undefined) {
        console.log('\n--dry-run: nothing was sent.');
        return;
    }

    const chain = makeCompetitionChain({
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        sealedCompetition: config.sealedCompetition,
        privateKey,
        txTimeoutMs: config.txTimeoutMs,
        confirmations: config.confirmations,
    });

    const existing = await chain.getCompetition(competitionId);
    if (existing.exists) {
        fail(
            `A competition already exists under ${competitionId} (created by ${existing.creator}).\n` +
                'Ids are keccak256(abi.encode(operator, label)), so pick a different --label.',
        );
    }

    if (prize > 0n) {
        if (config.quadraToken === undefined) {
            fail('QUADRA_TOKEN is not set and the deployment file carries no quadraToken address.');
        }
        const balance = await chain.balanceOf(config.quadraToken, operator);
        if (balance < prize) {
            fail(
                `This wallet holds ${formatQuadra(balance)} but the prize is ${formatQuadra(prize)}.`,
            );
        }
        const allowance = await chain.allowance(config.quadraToken, config.sealedCompetition);
        if (allowance < prize) {
            console.log(`\napproving ${formatQuadra(prize)}...`);
            const approved = await chain.approve(
                config.quadraToken,
                config.sealedCompetition,
                prize,
            );
            if (!approved.ok) {
                explainTxFailure('approve', approved);
                process.exitCode = 1;
                return;
            }
            console.log(`  ${explorerTx(approved.hash)}`);
        }
    }

    console.log('\ncreating...');
    const created = await chain.create({
        competitionId,
        evaluatorId,
        kind,
        stake,
        resolveAt: BigInt(resolveAt),
        threshold,
        splitPct,
        prize,
        lifetimeSecs,
        params,
    });
    if (!created.ok) {
        explainTxFailure('create', created);
        process.exitCode = 1;
        return;
    }

    // The cross-check. A mismatch means the two derivations have drifted, and every tool that looks
    // the competition up by the derived id would find nothing.
    const emitted = createdIdFromLogs(created.logs, config.sealedCompetition);
    if (emitted === undefined) {
        fail(
            `\ncreated in ${explorerTx(created.hash)}, but no CompetitionCreated event was found in ` +
                'the receipt. Verify the competition on chain before funding anything else.',
        );
    }
    if (emitted.toLowerCase() !== competitionId.toLowerCase()) {
        fail(
            [
                '',
                'ID MISMATCH. The chain created a different competition id than this script derived:',
                `  derived ${competitionId}`,
                `  emitted ${emitted}`,
                '',
                'Use the emitted id, and reconcile the derivation with',
                'contracts/script/CreateCompetition.s.sol before creating another.',
            ].join('\n'),
        );
    }

    console.log(`created ${competitionId}`);
    console.log(`  ${explorerTx(created.hash)}`);
    console.log(`  resolves ${formatTime(resolveAt)}`);
}

/**
 * The evaluator that will be asked to settle this, or a refusal.
 *
 * THE ONE FIELD THAT DECIDES WHETHER A COMPETITION CAN EVER FINISH, and the contract does not check
 * it: `create` only hashes it into `category`. An unknown or unsettleable evaluator therefore takes
 * the prize, accepts stakes, and then refuses at settle time with `unsupported` — leaving the money
 * locked until `resolveAt + 3 days` makes `cancel` permissionless. The Sui engine caught the
 * equivalent mistake at creation, because its bind step looked the template up.
 *
 * The rule mirrors `evaluation-engine/src/evaluators/index.ts::assertSettleable`: a price scorer
 * from the shared registry settles, `portfolio-roi` settles only as a KIND_PERFORMANCE competition,
 * and everything else — the polymarket evaluators included, since their ground truth has no FTSO
 * feed — cannot. `--force` exists because this build's registry can lag an enclave that has more.
 */
function checkedEvaluator(evaluatorId: string, kind: number, force: boolean): string {
    if (evaluatorId.length === 0) fail('--evaluator cannot be empty');

    const isPriceScorer = isEvaluatorId(evaluatorId);
    const isPortfolio = evaluatorId === PORTFOLIO_EVALUATOR;

    if (isPriceScorer || (isPortfolio && kind === KIND_PERFORMANCE)) return evaluatorId;

    const why = isPortfolio
        ? `"${evaluatorId}" produces a metric around ${PERF_BASE}, so it can only settle as a performance competition (--kind performance).`
        : `"${evaluatorId}" is not a scorer this build knows how to settle. Known: ${EVALUATOR_IDS.join(', ')}, or ${PORTFOLIO_EVALUATOR} with --kind performance.`;

    if (force) {
        console.warn(`WARNING: ${why}`);
        console.warn('Proceeding because --force was given. If the engine cannot settle it, the');
        console.warn('prize and every stake stay locked until cancel becomes permissionless.\n');
        return evaluatorId;
    }
    return fail(
        `${why}\n\nA competition the engine cannot settle locks its prize and every stake until\n` +
            'resolveAt + 3 days. Pass --force if you are certain the enclave has this scorer.',
    );
}

/** The scope blob: `--params-json` verbatim, or `--asset` as the one-key shorthand. */
function paramsFrom(paramsJson: string | undefined, asset: string | undefined): Hex {
    const raw =
        paramsJson !== undefined
            ? paramsJson
            : asset !== undefined
              ? JSON.stringify({ asset: asset.trim().toUpperCase() })
              : undefined;
    if (raw === undefined) return '0x';
    try {
        JSON.parse(raw);
    } catch {
        fail(`--params-json must be valid JSON (got ${raw})`);
    }
    const bytes = Buffer.from(raw, 'utf8');
    // MAX_PARAMS_BYTES on the contract. Checked here so the failure names the flag, not a selector.
    if (bytes.length > MAX_PARAMS_BYTES) {
        fail(`--params-json is ${bytes.length} bytes; the contract caps it at ${MAX_PARAMS_BYTES}`);
    }
    return `0x${bytes.toString('hex')}`;
}

runCli(main);
