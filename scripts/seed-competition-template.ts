// seed-competition-template.ts — seed the trading/portfolio job template used by PERFORMANCE
// competitions into the data gateway, so enrolled agents can run it. Mirrors the agent app's
// seedTemplate.ts: PUT /templates is admin-gated (x-quadra-role) and the gateway stores the
// JSON verbatim, so this seeds the rich intake-ready shape (params + output). Gated on
// DATA_GATEWAY_URL reachable + ROLE_TOKEN_ADMIN. Run: `npm run seed-template`.

// The portfolio/trading template. `evaluator_id` routes scoring to the portfolio-roi enclave.
// `trades` is a JSON-encoded array of { symbol, side, quantity } (data-layer output is
// primitives only). The starting portfolio is supplied per-competition by the engine, not here.
const TEMPLATE = {
  id: "crypto-trading",
  category: "finance",
  evaluator_id: "portfolio-roi",
  description: "Trade a starting crypto portfolio to maximize ROI over the window.",
  params: [
    { key: "horizon", ask: "Over what window will you trade? (e.g. 1h)", type: "duration", required: true },
  ],
  output: { trades: "string", final_note: "string" },
  start_data_template: {},
  minimum_lifetime: 60000,
  allowed_assets: ["BTC", "ETH"],
};

function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  // Engines share data/.env (two levels up from competition/scripts).
  for (const path of [new URL("../../data/.env", import.meta.url).pathname, ".env"]) {
    try {
      loader(path);
    } catch {
      // optional
    }
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const gatewayUrl = (process.env.DATA_GATEWAY_URL ?? "http://localhost:8787").trim();
  const adminToken = (process.env.ROLE_TOKEN_ADMIN ?? "").trim();
  console.log(`seed-competition-template: gateway=${gatewayUrl} template=${TEMPLATE.id}`);

  if (adminToken.length === 0) {
    console.log("SKIPPED: ROLE_TOKEN_ADMIN not set (admin token required to PUT /templates).");
    process.exit(0);
  }

  let res: Response;
  try {
    res = await fetch(`${gatewayUrl}/templates`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-quadra-role": adminToken },
      body: JSON.stringify(TEMPLATE),
    });
  } catch (err) {
    console.log(`SKIPPED: gateway not reachable (${err instanceof Error ? err.message : "error"}).`);
    process.exit(0);
  }

  if (res.ok) {
    console.log(`PASS: seeded template "${TEMPLATE.id}". Create a performance competition against it.`);
    process.exit(0);
  }
  const body = await res.text().catch(() => "");
  console.error(`FAILED: gateway responded ${res.status}${body ? `: ${body}` : ""} (check ROLE_TOKEN_ADMIN).`);
  process.exit(1);
}

main().catch((err) => {
  console.error("seed-competition-template error:", err);
  process.exit(1);
});
