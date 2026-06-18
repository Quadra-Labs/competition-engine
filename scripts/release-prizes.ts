// release-prizes.ts — operator fallback to release a competition's prizes after its end time.
// release_prizes is public + time-gated (no cap), so any funded key can call it; the engine does
// this automatically, this is a manual backstop. Usage: `npm run release-prizes -- --competition 0x..`.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { Agent, setGlobalDispatcher } from "undici";

import { loadDataEnv, requireEnv, network, parseArgs } from "./shared.js";

setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

async function main(): Promise<void> {
  loadDataEnv();
  const args = parseArgs(process.argv.slice(2));
  const competitionId = args.competition;
  if (!competitionId) {
    console.error("Required: --competition <competition object id>");
    process.exit(1);
  }
  const pkg = requireEnv("QUADRA_PACKAGE_ID");
  // Any funded key works (the call is permissionless); reuse the engine key by default.
  const signer = Ed25519Keypair.fromSecretKey(
    (process.env.COMPETITION_SECRET_KEY ?? process.env.DATA_SECRET_KEY ?? "").trim() ||
      requireEnv("COMPETITION_SECRET_KEY"),
  );
  const client = new SuiJsonRpcClient({
    network: network(),
    url: process.env.DATA_BASE_URL ?? getJsonRpcFullnodeUrl(network()),
  });

  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::competition::release_prizes`,
    arguments: [tx.object(competitionId), tx.object.clock()],
  });
  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true },
  });
  if (res.effects?.status.status !== "success") {
    throw new Error(`release_prizes failed: ${res.effects?.status.error ?? "unknown"}`);
  }
  console.log(`Released prizes for ${competitionId} (tx ${res.digest}).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("release-prizes error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
