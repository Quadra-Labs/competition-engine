// list-competitions.ts — read-only status: queries the competition events for the package and
// prints a per-competition summary (created, joins, scores/metrics, prizes), plus the engine's
// in-memory /status if reachable. Usage: `npm run list-competitions`.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import type { SuiEvent } from "@mysten/sui/jsonRpc";
import { Agent, setGlobalDispatcher } from "undici";

import { loadDataEnv, requireEnv, network } from "./shared.js";

setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

async function queryAll(client: SuiJsonRpcClient, eventType: string): Promise<SuiEvent[]> {
  const out: SuiEvent[] = [];
  let cursor: { txDigest: string; eventSeq: string } | null | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await client.queryEvents({
      query: { MoveEventType: eventType },
      cursor,
      order: "ascending",
      limit: 50,
    });
    out.push(...res.data);
    if (!res.hasNextPage) break;
    cursor = res.nextCursor;
  }
  return out;
}

function field(ev: SuiEvent, key: string): string {
  return String((ev.parsedJson as Record<string, unknown>)[key] ?? "");
}

async function main(): Promise<void> {
  loadDataEnv();
  const pkg = requireEnv("QUADRA_PACKAGE_ID");
  const client = new SuiJsonRpcClient({
    network: network(),
    url: process.env.DATA_BASE_URL ?? getJsonRpcFullnodeUrl(network()),
  });

  const [created, joined, scores, metrics, prizes] = await Promise.all([
    queryAll(client, `${pkg}::competition::CompetitionCreated`),
    queryAll(client, `${pkg}::competition::AgentJoined`),
    queryAll(client, `${pkg}::competition::ScoreRecorded`),
    queryAll(client, `${pkg}::competition::PerformanceRecorded`),
    queryAll(client, `${pkg}::competition::PrizeAwarded`),
  ]);

  const countBy = (events: SuiEvent[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const ev of events) {
      const id = field(ev, "competition_id");
      m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  };
  const joins = countBy(joined);
  const scored = countBy(scores);
  const recorded = countBy(metrics);
  const awarded = countBy(prizes);

  console.log(`Competitions for package ${pkg}:\n`);
  if (created.length === 0) console.log("  (none created yet)");
  for (const ev of created) {
    const id = field(ev, "competition_id");
    const kind = field(ev, "kind") === "1" ? "performance" : "scoring";
    console.log(`  ${id}`);
    console.log(
      `    kind=${kind} prize=${field(ev, "prize")} threshold=${field(ev, "threshold")} ` +
        `winners=${field(ev, "winners")} end=${new Date(Number(field(ev, "end_time_ms"))).toISOString()}`,
    );
    console.log(
      `    joined=${joins.get(id) ?? 0} scored=${scored.get(id) ?? 0} ` +
        `metrics=${recorded.get(id) ?? 0} prizesAwarded=${awarded.get(id) ?? 0}`,
    );
  }

  const engineUrl = (process.env.COMPETITION_URL ?? "http://localhost:5100").replace(/\/$/, "");
  try {
    const res = await fetch(`${engineUrl}/status`);
    if (res.ok) console.log(`\nEngine /status: ${await res.text()}`);
  } catch {
    console.log(`\n(engine at ${engineUrl} not reachable)`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("list-competitions error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
