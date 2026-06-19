// seed-prediction-templates.ts — seed the three Polymarket prediction-market job templates into
// the data gateway so enrolled agents can run them. Mirrors seed-competition-template.ts: PUT
// /templates is admin-gated (x-quadra-role) and the gateway stores each template JSON verbatim,
// so this seeds the rich intake-ready shape (params + output). Gated on DATA_GATEWAY_URL reachable
// + ROLE_TOKEN_ADMIN. Run: `npm run seed-prediction-templates`.
//
// Each `evaluator_id` routes scoring to the one polymarket enclave, which dispatches by category.
// Arrays (event guesses) are JSON-encoded into a `string` output field (data-layer output is
// primitives only). `target_ts` is unix-seconds (a number) so it survives the bind --params ':'
// split. Every template MUST declare non-empty `params` or the agent parser skips it as not
// intake-ready, even though competitions pre-fill the params.

import { fileURLToPath } from "node:url";

const TEMPLATES = [
  {
    id: "polymarket-resolution",
    category: "prediction",
    evaluator_id: "polymarket-resolution",
    description: "Predict whether a Polymarket market resolves YES or NO.",
    params: [
      { key: "market_id", ask: "Which Polymarket market id (Gamma id)?", type: "string", required: true },
    ],
    output: { outcome: "string" },
    start_data_template: {},
    minimum_lifetime: 60000,
    allowed_assets: [],
  },
  {
    id: "polymarket-event",
    category: "prediction",
    evaluator_id: "polymarket-event",
    description: "Predict outcomes for the markets in a Polymarket event (more correct = higher score).",
    params: [
      { key: "event_id", ask: "Which Polymarket event id (Gamma id)?", type: "string", required: true },
    ],
    // A JSON-encoded array of { market_id, outcome }.
    output: { guesses: "string" },
    start_data_template: {},
    minimum_lifetime: 60000,
    allowed_assets: [],
  },
  {
    id: "polymarket-price",
    category: "prediction",
    evaluator_id: "polymarket-price",
    description: "Predict a Polymarket market's YES price (probability 0-1) at a target date.",
    params: [
      { key: "market_id", ask: "Which Polymarket market id (Gamma id)?", type: "string", required: true },
      { key: "target_ts", ask: "Target date as a unix-seconds timestamp?", type: "number", required: true },
    ],
    output: { probability: "number" },
    start_data_template: {},
    minimum_lifetime: 60000,
    allowed_assets: [],
  },
];

function loadDotEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  // Engines share data/.env (two levels up from competition/scripts).
  for (const path of [fileURLToPath(new URL("../../data/.env", import.meta.url)), ".env"]) {
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
  console.log(`seed-prediction-templates: gateway=${gatewayUrl} (${TEMPLATES.length} templates)`);

  if (adminToken.length === 0) {
    console.log("SKIPPED: ROLE_TOKEN_ADMIN not set (admin token required to PUT /templates).");
    process.exit(0);
  }

  for (const template of TEMPLATES) {
    let res: Response;
    try {
      res = await fetch(`${gatewayUrl}/templates`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-quadra-role": adminToken },
        body: JSON.stringify(template),
      });
    } catch (err) {
      console.log(`SKIPPED: gateway not reachable (${err instanceof Error ? err.message : "error"}).`);
      process.exit(0);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`FAILED: "${template.id}" -> ${res.status}${body ? `: ${body}` : ""} (check ROLE_TOKEN_ADMIN).`);
      process.exit(1);
    }
    console.log(`PASS: seeded template "${template.id}".`);
  }
  console.log("Create scoring competitions against these with --prediction (see create-competition.ts).");
  process.exit(0);
}

main().catch((err) => {
  console.error("seed-prediction-templates error:", err);
  process.exit(1);
});
