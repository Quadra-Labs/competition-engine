// bind-competition.ts — (re)register an EXISTING competition's off-chain binding with the engine.
// Needed when create-competition's auto-bind was skipped because the engine was down: the
// competition is on-chain (and agents may have joined) but the engine has no template/lifetime to
// dispatch from. This reads `kind` + `end_time_ms` from the on-chain CompetitionCreated event, so
// you only pass --competition --template --lifetime [--portfolio BTC:5000,ETH:5000] [--params k:v].
// Run from competition/: `npm run bind -- --competition 0x.. --template btc-price-range --lifetime 3m`.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Agent, setGlobalDispatcher } from "undici";

import { loadDataEnv, requireEnv, network, parseArgs } from "./shared.js";

setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

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

// Read kind + end_time_ms from the on-chain CompetitionCreated event for this competition.
async function fromEvent(
  client: SuiJsonRpcClient,
  pkg: string,
  competitionId: string,
): Promise<{ kind: number; endMs: number } | undefined> {
  let cursor: { txDigest: string; eventSeq: string } | null | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await client.queryEvents({
      query: { MoveEventType: `${pkg}::competition::CompetitionCreated` },
      cursor,
      order: "descending",
      limit: 50,
    });
    for (const e of res.data) {
      const j = e.parsedJson as { competition_id?: string; kind?: unknown; end_time_ms?: unknown };
      if (j.competition_id === competitionId) {
        return { kind: Number(j.kind ?? 0), endMs: Number(j.end_time_ms ?? 0) };
      }
    }
    if (!res.hasNextPage) break;
    cursor = res.nextCursor;
  }
  return undefined;
}

async function main(): Promise<void> {
  loadDataEnv();
  const args = parseArgs(process.argv.slice(2));
  const competitionId = args.competition;
  const templateId = args.template;
  const lifetime = args.lifetime;
  if (!competitionId || !templateId || !lifetime) {
    console.error("Required: --competition <id> --template <id> --lifetime <e.g. 3m>");
    process.exit(1);
  }
  const pkg = requireEnv("QUADRA_PACKAGE_ID");
  const engineUrl = (args.engine ?? process.env.COMPETITION_URL ?? "http://localhost:5100").replace(/\/$/, "");
  const adminToken = (process.env.COMPETITION_ADMIN_TOKEN ?? process.env.ROLE_TOKEN_ADMIN ?? "").trim();
  if (!adminToken) {
    console.error("No COMPETITION_ADMIN_TOKEN / ROLE_TOKEN_ADMIN set (the engine's bind is admin-gated).");
    process.exit(1);
  }

  // kind + end from flags, else from the on-chain CompetitionCreated event.
  let kind = args.kind === "performance" ? 1 : args.kind === "scoring" ? 0 : undefined;
  let endMs = args.end !== undefined ? Number(args.end) : undefined;
  if (kind === undefined || endMs === undefined) {
    const client = new SuiJsonRpcClient({
      network: network(),
      url: process.env.DATA_BASE_URL ?? getJsonRpcFullnodeUrl(network()),
    });
    const ev = await fromEvent(client, pkg, competitionId);
    if (!ev) {
      console.error("Could not find CompetitionCreated for that id; pass --kind and --end <ms> explicitly.");
      process.exit(1);
    }
    if (kind === undefined) kind = ev.kind;
    if (endMs === undefined) endMs = ev.endMs;
  }

  const portfolio = args.portfolio !== undefined ? parseKeyNums(args.portfolio) : undefined;
  const params = args.params !== undefined ? parseKeyStrs(args.params) : undefined;
  // Prediction-market (polymarket) competitions: the engine sends a prediction payload and skips
  // the Pyth start-price capture. Pass --prediction (target_ts in --params must be unix seconds,
  // since parseKeyStrs splits each pair on ':').
  const prediction = args.prediction !== undefined;
  const body = {
    kind,
    template_id: templateId,
    lifetime,
    end_time_ms: endMs,
    ...(params ? { params } : {}),
    ...(portfolio ? { portfolio } : {}),
    ...(prediction ? { prediction: true } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${engineUrl}/competitions/${competitionId}/bind`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-competition-admin": adminToken },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`Engine unreachable at ${engineUrl} (${err instanceof Error ? err.message : "error"}). Start it and retry.`);
    process.exit(1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Bind failed: ${res.status}${text ? `: ${text}` : ""}`);
    process.exit(1);
  }
  console.log(`Bound ${competitionId} (kind ${kind}, template ${templateId}, lifetime ${lifetime}). Joined agents will receive a free job.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("bind-competition error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
