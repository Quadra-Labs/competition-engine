// create-competition.ts — admin CLI to launch a competition. It (1) calls
// competition::create_competition on-chain (cap-gated, splitting a QUADRA prize coin), then
// (2) tells the engine the off-chain binding (template + lifetime + portfolio) via
// POST /competitions/:id/bind so the engine can dispatch free jobs and resolve it.
//
// Usage (from competition/):
//   npm run create-competition -- --kind scoring     --prize 1000000 --threshold 1 \
//       --in 10m --split 100 --template btc-price-range --lifetime 5m
//   npm run create-competition -- --kind performance --prize 1000000 --threshold 1000000 \
//       --in 1h --split 60,40 --template crypto-trading --lifetime 30m \
//       --portfolio BTC:5000,ETH:5000
//   npm run create-competition -- --kind scoring --prize 1000000 --threshold 1 \
//       --in 1h --split 100 --template polymarket-resolution --lifetime 30m \
//       --prediction --params market_id:507033   (event_id / market_id+target_ts for the others)

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { Agent, setGlobalDispatcher } from "undici";

import { loadDataEnv, requireEnv, network, parseArgs } from "./shared.js";

setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

function parseDurationMs(value: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim());
  if (!m) throw new Error(`bad duration "${value}"`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

function parseSplit(raw: string): number[] {
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length === 0 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`bad --split "${raw}" (use e.g. 60,40)`);
  }
  if (parts.reduce((a, b) => a + b, 0) !== 100) throw new Error("--split must sum to 100");
  return parts;
}

function parseKeyNums(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split(":");
    if (!k || v === undefined || !Number.isFinite(Number(v))) throw new Error(`bad pair "${pair}"`);
    out[k.trim()] = Number(v);
  }
  return out;
}

function parseKeyStrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split(":");
    if (!k || v === undefined) throw new Error(`bad pair "${pair}"`);
    out[k.trim()] = v.trim();
  }
  return out;
}

async function main(): Promise<void> {
  loadDataEnv();
  const args = parseArgs(process.argv.slice(2));

  const kindStr = (args.kind ?? "").toLowerCase();
  if (kindStr !== "scoring" && kindStr !== "performance") {
    console.error("Required: --kind scoring|performance");
    process.exit(1);
  }
  const kind = kindStr === "performance" ? 1 : 0;
  const templateId = args.template;
  const lifetime = args.lifetime;
  if (!templateId || !lifetime) {
    console.error("Required: --template <id> and --lifetime <e.g. 5m>");
    process.exit(1);
  }
  const prize = Number(args.prize);
  if (!Number.isFinite(prize) || prize <= 0) {
    console.error("Required: --prize <QUADRA base units, > 0>");
    process.exit(1);
  }
  // Performance threshold defaults to PERF_BASE (require >= 0% ROI); scoring defaults to 1.
  const threshold = args.threshold !== undefined ? Number(args.threshold) : kind === 1 ? 1_000_000 : 1;
  const split = parseSplit(args.split ?? "100");
  const endMs = args.end !== undefined ? Number(args.end) : Date.now() + parseDurationMs(args.in ?? "10m");
  const portfolio = args.portfolio !== undefined ? parseKeyNums(args.portfolio) : undefined;
  const params = args.params !== undefined ? parseKeyStrs(args.params) : undefined;
  // Prediction-market (polymarket) scoring competitions: the engine resolves from Polymarket via
  // `params` and skips the Pyth start-price capture. Use unix-seconds for a target_ts param.
  const prediction = args.prediction !== undefined;

  if (kind === 1 && portfolio === undefined) {
    console.error("Performance competitions need --portfolio BTC:5000,ETH:5000 (starting USD per asset).");
    process.exit(1);
  }

  const pkg = requireEnv("QUADRA_PACKAGE_ID");
  const capId = requireEnv("COMPETITION_CAP_ID");
  const signer = Ed25519Keypair.fromSecretKey(requireEnv("COMPETITION_SECRET_KEY"));
  const addr = signer.toSuiAddress();
  const engineUrl = (args.engine ?? process.env.COMPETITION_URL ?? "http://localhost:5100").replace(/\/$/, "");
  const adminToken = (process.env.COMPETITION_ADMIN_TOKEN ?? process.env.ROLE_TOKEN_ADMIN ?? "").trim();

  const client = new SuiJsonRpcClient({
    network: network(),
    url: process.env.DATA_BASE_URL ?? getJsonRpcFullnodeUrl(network()),
  });

  // Select + merge the signer's QUADRA coins, then split the prize.
  const coins = (await client.getCoins({ owner: addr, coinType: `${pkg}::quadra::QUADRA` })).data;
  if (coins.length === 0) throw new Error("signer holds no QUADRA coins to fund the prize");
  const total = coins.reduce((a, c) => a + BigInt(c.balance), 0n);
  if (total < BigInt(prize)) throw new Error(`insufficient QUADRA: have ${total}, need ${prize}`);

  const tx = new Transaction();
  const first = coins[0]!;
  const primary = tx.object(first.coinObjectId);
  if (coins.length > 1) {
    tx.mergeCoins(primary, coins.slice(1).map((c) => tx.object(c.coinObjectId)));
  }
  const [prizeCoin] = tx.splitCoins(primary, [tx.pure.u64(prize)]);
  tx.moveCall({
    target: `${pkg}::competition::create_competition`,
    arguments: [
      tx.object(capId),
      tx.pure.u8(kind),
      prizeCoin!,
      tx.pure.u64(threshold),
      tx.pure.u64(Math.floor(endMs)),
      tx.pure.vector("u64", split),
    ],
  });

  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });
  if (res.effects?.status.status !== "success") {
    throw new Error(`create_competition failed: ${res.effects?.status.error ?? "unknown"}`);
  }
  const created = (res.objectChanges ?? []).find(
    (c) => c.type === "created" && c.objectType.endsWith("::competition::Competition"),
  );
  if (!created || created.type !== "created") {
    throw new Error("competition created but its object id was not found in objectChanges");
  }
  const competitionId = created.objectId;
  console.log(`Created competition ${competitionId} (kind ${kindStr}, prize ${prize}, ends ${new Date(endMs).toISOString()}).`);
  console.log(`  tx: ${res.digest}`);

  // Tell the engine the off-chain binding so it can dispatch + resolve.
  if (!adminToken) {
    console.log("NOTE: no COMPETITION_ADMIN_TOKEN / ROLE_TOKEN_ADMIN set; skipping engine bind.");
    console.log(`Bind manually: POST ${engineUrl}/competitions/${competitionId}/bind`);
    process.exit(0);
  }
  const bindBody = {
    kind,
    template_id: templateId,
    lifetime,
    end_time_ms: Math.floor(endMs),
    ...(params ? { params } : {}),
    ...(portfolio ? { portfolio } : {}),
    ...(prediction ? { prediction: true } : {}),
  };
  let bindRes: Response;
  try {
    bindRes = await fetch(`${engineUrl}/competitions/${competitionId}/bind`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-competition-admin": adminToken },
      body: JSON.stringify(bindBody),
    });
  } catch (err) {
    console.log(`Created on-chain, but engine bind failed (engine unreachable: ${err instanceof Error ? err.message : "error"}).`);
    console.log(`Start the engine and re-bind: POST ${engineUrl}/competitions/${competitionId}/bind ${JSON.stringify(bindBody)}`);
    process.exit(0);
  }
  if (!bindRes.ok) {
    const body = await bindRes.text().catch(() => "");
    console.error(`Engine bind failed: ${bindRes.status}${body ? `: ${body}` : ""}`);
    process.exit(1);
  }
  console.log(`Bound to the engine; agents that join ${competitionId} will receive free jobs.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("create-competition error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
