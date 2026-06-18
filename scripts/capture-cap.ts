// capture-cap.ts — one-time setup after publishing the quadra package. The CompetitionCap and
// JobAccessCap are OWNED objects (minted to the deployer = DATA_SECRET_KEY), so the data layer's
// setup-env.ts (which finds SHARED objects) does not capture them. This script:
//   1. finds both caps owned by the deployer,
//   2. transfers the CompetitionCap to the competition engine key (COMPETITION_SECRET_KEY) if it
//      is a different address, so the engine can record scores/metrics,
//   3. runs job_access::set_competition(cap, registry, engineAddr) so the engine can Seal-decrypt
//      free competition results (mirrors set_scheduler),
//   4. writes COMPETITION_CAP_ID + JOB_ACCESS_CAP_ID into data/.env.
// Run from competition/: `npm run capture-cap`.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { Agent, setGlobalDispatcher } from "undici";

import { loadDataEnv, requireEnv, network, upsertDataEnv } from "./shared.js";

setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

async function findOwnedCap(
  client: SuiJsonRpcClient,
  owner: string,
  structType: string,
): Promise<string | undefined> {
  const res = await client.getOwnedObjects({
    owner,
    filter: { StructType: structType },
    options: { showType: true },
  });
  return res.data[0]?.data?.objectId;
}

async function exec(client: SuiJsonRpcClient, signer: Ed25519Keypair, tx: Transaction): Promise<string> {
  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true },
  });
  if (res.effects?.status.status !== "success") {
    throw new Error(`tx ${res.digest} failed: ${res.effects?.status.error ?? "unknown"}`);
  }
  return res.digest;
}

async function main(): Promise<void> {
  loadDataEnv();
  const deployer = Ed25519Keypair.fromSecretKey(requireEnv("DATA_SECRET_KEY"));
  const engine = Ed25519Keypair.fromSecretKey(requireEnv("COMPETITION_SECRET_KEY"));
  const pkg = requireEnv("QUADRA_PACKAGE_ID");
  const registry = requireEnv("JOB_ACCESS_REGISTRY_ID");

  const deployerAddr = deployer.toSuiAddress();
  const engineAddr = engine.toSuiAddress();
  const client = new SuiJsonRpcClient({
    network: network(),
    url: process.env.DATA_BASE_URL ?? getJsonRpcFullnodeUrl(network()),
  });

  const competitionCapType = `${pkg}::competition::CompetitionCap`;
  const jobAccessCapType = `${pkg}::job_access::JobAccessCap`;

  // CompetitionCap may already be at the engine address (re-run) or still at the deployer.
  let competitionCapId =
    (await findOwnedCap(client, engineAddr, competitionCapType)) ??
    (await findOwnedCap(client, deployerAddr, competitionCapType));
  if (!competitionCapId) throw new Error(`No CompetitionCap found for deployer or engine address`);

  const jobAccessCapId = await findOwnedCap(client, deployerAddr, jobAccessCapType);
  if (!jobAccessCapId) throw new Error(`No JobAccessCap found for the deployer`);

  console.log(`Deployer:           ${deployerAddr}`);
  console.log(`Competition engine: ${engineAddr}`);
  console.log(`CompetitionCap:     ${competitionCapId}`);
  console.log(`JobAccessCap:       ${jobAccessCapId}`);

  // 1. Transfer the CompetitionCap to the engine address if it is not already there.
  const ownedByEngine = await findOwnedCap(client, engineAddr, competitionCapType);
  if (!ownedByEngine && engineAddr !== deployerAddr) {
    const tx = new Transaction();
    tx.transferObjects([tx.object(competitionCapId)], engineAddr);
    const digest = await exec(client, deployer, tx);
    console.log(`Transferred CompetitionCap to the engine (tx ${digest}).`);
  } else {
    console.log("CompetitionCap already held by the engine (or engine == deployer); no transfer.");
  }

  // 2. Point the Seal policy's competition blanket reader at the engine address.
  const setTx = new Transaction();
  setTx.moveCall({
    target: `${pkg}::job_access::set_competition`,
    arguments: [setTx.object(jobAccessCapId), setTx.object(registry), setTx.pure.address(engineAddr)],
  });
  const setDigest = await exec(client, deployer, setTx);
  console.log(`set_competition -> ${engineAddr} (tx ${setDigest}).`);

  // 3. Persist the cap ids for the engine + future runs.
  upsertDataEnv({ COMPETITION_CAP_ID: competitionCapId, JOB_ACCESS_CAP_ID: jobAccessCapId });
  console.log("Wrote COMPETITION_CAP_ID + JOB_ACCESS_CAP_ID to data/.env (previous saved to .env.bak).");
  console.log("Done. Start the competition engine: npm run start.");
}

main().catch((err) => {
  console.error("capture-cap error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
