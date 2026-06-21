// provision-paid.ts — one-time setup for the PAID intake/scheduler flow (mirrors capture-cap.ts).
// It fills the intake + scheduler config into data/.env so those engines can boot:
//   1. ensures the IntakeCap (minted to the deployer at publish) is owned by INTAKE_SECRET_KEY's
//      address (transfers it from the deployer if needed),
//   2. finds the shared IntakeConfig id from the package's publish transaction,
//   3. generates a scheduler keypair + registers it via job_access::set_scheduler (deployer-signed)
//      so it can Seal-decrypt results to score them,
//   4. generates the shared role/internal tokens, points EVAL_ENGINES at the polymarket evaluator,
//   5. upserts everything into data/.env (previous saved to .env.bak). Secrets are never printed.
//
// Run from competition/:  INTAKE_SECRET_KEY=<suiprivkey...> npx tsx scripts/provision-paid.ts

import { randomBytes } from "node:crypto";

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { Agent, setGlobalDispatcher } from "undici";

import { loadDataEnv, requireEnv, network, upsertDataEnv } from "./shared.js";

setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

type Client = InstanceType<typeof SuiJsonRpcClient>;

async function findOwnedCap(client: Client, owner: string, structType: string): Promise<string | undefined> {
  const res = await client.getOwnedObjects({ owner, filter: { StructType: structType }, options: { showType: true } });
  return res.data[0]?.data?.objectId;
}

async function exec(client: Client, signer: Ed25519Keypair, tx: Transaction): Promise<string> {
  const res = await client.signAndExecuteTransaction({ signer, transaction: tx, options: { showEffects: true } });
  if (res.effects?.status.status !== "success") {
    throw new Error(`tx ${res.digest} failed: ${res.effects?.status.error ?? "unknown"}`);
  }
  return res.digest;
}

const token = () => randomBytes(24).toString("hex");

async function main(): Promise<void> {
  loadDataEnv();
  const pkg = requireEnv("QUADRA_PACKAGE_ID");
  const registry = requireEnv("JOB_ACCESS_REGISTRY_ID");
  const deployer = Ed25519Keypair.fromSecretKey(requireEnv("DATA_SECRET_KEY"));
  const intake = Ed25519Keypair.fromSecretKey(requireEnv("INTAKE_SECRET_KEY"));
  const deployerAddr = deployer.toSuiAddress();
  const intakeAddr = intake.toSuiAddress();

  const client = new SuiJsonRpcClient({ network: network(), url: process.env.DATA_BASE_URL ?? getJsonRpcFullnodeUrl(network()) });

  console.log(`Deployer: ${deployerAddr}`);
  console.log(`Intake:   ${intakeAddr}`);

  // 1. IntakeCap: find it (at the intake addr on a re-run, else at the deployer), transfer to intake.
  const intakeCapType = `${pkg}::intake::IntakeCap`;
  let intakeCapId = (await findOwnedCap(client, intakeAddr, intakeCapType)) ?? (await findOwnedCap(client, deployerAddr, intakeCapType));
  if (!intakeCapId) throw new Error(`No IntakeCap found for the intake or deployer address (is QUADRA_PACKAGE_ID right?)`);
  const capAtIntake = await findOwnedCap(client, intakeAddr, intakeCapType);
  if (!capAtIntake && intakeAddr !== deployerAddr) {
    const tx = new Transaction();
    tx.transferObjects([tx.object(intakeCapId)], intakeAddr);
    console.log(`Transferred IntakeCap to intake (tx ${await exec(client, deployer, tx)}).`);
  } else {
    console.log("IntakeCap already held by intake (or intake == deployer); no transfer.");
  }
  console.log(`IntakeCap: ${intakeCapId}`);

  // 2. IntakeConfig (shared) id from the package's publish transaction.
  const pkgObj = await client.getObject({ id: pkg, options: { showPreviousTransaction: true } });
  const publishDigest = pkgObj.data?.previousTransaction;
  if (!publishDigest) throw new Error("could not read the package's publish transaction");
  const tb = await client.getTransactionBlock({ digest: publishDigest, options: { showObjectChanges: true } });
  const changes = (tb.objectChanges ?? []) as Array<{ type: string; objectType?: string; objectId?: string }>;
  const cfg = changes.find((c) => c.type === "created" && (c.objectType ?? "").endsWith("::intake::IntakeConfig"));
  if (!cfg?.objectId) throw new Error("IntakeConfig not found in the publish tx (was the package upgraded?)");
  const intakeConfigId = cfg.objectId;
  console.log(`IntakeConfig: ${intakeConfigId}`);

  // 3. Scheduler key + on-chain registration as the Seal reader (deployer signs; needs JobAccessCap).
  const jobAccessCapId = requireEnv("JOB_ACCESS_CAP_ID");
  const scheduler = Ed25519Keypair.generate();
  const schedulerAddr = scheduler.toSuiAddress();
  const setTx = new Transaction();
  setTx.moveCall({
    target: `${pkg}::job_access::set_scheduler`,
    arguments: [setTx.object(jobAccessCapId), setTx.object(registry), setTx.pure.address(schedulerAddr)],
  });
  console.log(`set_scheduler -> ${schedulerAddr} (tx ${await exec(client, deployer, setTx)}).`);

  // 4. Shared tokens + the polymarket eval-engine route (the engine you run on :3000).
  const evalEngines = JSON.stringify({
    "polymarket-price": { url: "http://localhost:3000" },
    "polymarket-event": { url: "http://localhost:3000" },
    "polymarket-resolution": { url: "http://localhost:3000" },
  });

  // 5. Write everything to data/.env (secrets included but never printed).
  upsertDataEnv({
    INTAKE_SECRET_KEY: requireEnv("INTAKE_SECRET_KEY"),
    INTAKE_CAP_ID: intakeCapId,
    INTAKE_CONFIG_ID: intakeConfigId,
    SCHEDULER_SECRET_KEY: scheduler.getSecretKey(),
    INTAKE_INTERNAL_TOKEN: token(),
    ROLE_TOKEN_INTAKE: token(),
    ROLE_TOKEN_SCHEDULER: token(),
    INTAKE_VALIDATOR_URL: "http://127.0.0.1:4000",
    DATA_GATEWAY_URL: "http://localhost:8787",
    EVAL_ENGINES: evalEngines,
  });

  // Gas check: the intake key signs release_payment on-chain.
  const bal = await client.getBalance({ owner: intakeAddr });
  const sui = Number(bal.totalBalance) / 1e9;
  console.log(`\nWrote intake/scheduler config to data/.env (previous -> .env.bak).`);
  console.log(`Keys set: INTAKE_SECRET_KEY, INTAKE_CAP_ID, INTAKE_CONFIG_ID, SCHEDULER_SECRET_KEY, INTAKE_INTERNAL_TOKEN, ROLE_TOKEN_INTAKE, ROLE_TOKEN_SCHEDULER, INTAKE_VALIDATOR_URL, DATA_GATEWAY_URL, EVAL_ENGINES.`);
  console.log(`Intake gas balance: ${sui} SUI ${sui < 0.05 ? "(LOW — fund this address for release_payment)" : "(ok)"}`);
  console.log(`Scheduler addr (registered Seal reader, needs no gas): ${schedulerAddr}`);
  console.log(`\nNext: start gateway (data: npm run serve), scheduler (npm start), intake (npm start), eval engine (:3000), then seed the template + chat.`);
}

main().catch((err) => {
  console.error("provision-paid error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
