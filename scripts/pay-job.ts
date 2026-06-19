// pay-job.ts — the dApp's pay_for_job step, from the CLI (for local/testnet runs without a frontend).
// Locks `cost` QUADRA into an Escrow for an open intake session, emitting JobPaid (which the intake
// engine watches). Pays with DATA_SECRET_KEY (the deployer wallet, which holds the QUADRA supply).
//
// Run from competition/:
//   npx tsx scripts/pay-job.ts --session <id> --job <id> --agent <0xwallet> --cost <quadra base units>

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { Agent, setGlobalDispatcher } from "undici";

import { loadDataEnv, requireEnv, network, parseArgs } from "./shared.js";

setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

async function main(): Promise<void> {
  loadDataEnv();
  const args = parseArgs(process.argv.slice(2));
  const session = args.session;
  const job = args.job;
  const agentWallet = args.agent;
  const cost = args.cost;
  if (!session || !job || !agentWallet || !cost) {
    console.error("usage: --session <id> --job <id> --agent <0xwallet> --cost <quadra base units>");
    process.exit(1);
  }

  const pkg = requireEnv("QUADRA_PACKAGE_ID");
  const agentRegistry = requireEnv("AGENT_REGISTRY_ID");
  const accessRegistry = requireEnv("JOB_ACCESS_REGISTRY_ID");
  const payer = Ed25519Keypair.fromSecretKey(requireEnv("DATA_SECRET_KEY"));
  const payerAddr = payer.toSuiAddress();
  const client = new SuiJsonRpcClient({ network: network(), url: process.env.DATA_BASE_URL ?? getJsonRpcFullnodeUrl(network()) });

  const quadraType = `${pkg}::quadra::QUADRA`;
  const costN = BigInt(cost);

  const coins = await client.getCoins({ owner: payerAddr, coinType: quadraType });
  if (coins.data.length === 0) throw new Error(`payer ${payerAddr} holds no ${quadraType} coins`);
  const sorted = [...coins.data].sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
  const total = sorted.reduce((s, c) => s + BigInt(c.balance), 0n);
  if (total < costN) throw new Error(`insufficient QUADRA: have ${total}, need ${costN}`);

  const tx = new Transaction();
  const primary = tx.object(sorted[0]!.coinObjectId);
  if (BigInt(sorted[0]!.balance) < costN && sorted.length > 1) {
    tx.mergeCoins(primary, sorted.slice(1).map((c) => tx.object(c.coinObjectId)));
  }
  const [payment] = tx.splitCoins(primary, [tx.pure.u64(costN)]);
  tx.moveCall({
    target: `${pkg}::intake::pay_for_job`,
    arguments: [
      tx.object(agentRegistry),
      tx.object(accessRegistry),
      tx.pure.string(session),
      tx.pure.string(job),
      tx.pure.address(agentWallet),
      payment!,
      tx.object("0x6"),
    ],
  });

  const res = await client.signAndExecuteTransaction({
    signer: payer,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });
  if (res.effects?.status.status !== "success") {
    throw new Error(`pay_for_job failed (tx ${res.digest}): ${res.effects?.status.error ?? "unknown"}`);
  }
  const paid = res.events?.find((e) => e.type.endsWith("::intake::JobPaid"));
  console.log(`PAID job ${job} (${costN} QUADRA) tx ${res.digest}`);
  if (paid) console.log(`JobPaid: ${JSON.stringify(paid.parsedJson)}`);
}

main().catch((err) => {
  console.error("pay-job error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
