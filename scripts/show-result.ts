// show-result.ts — decrypt and print one competition job's delivered result, using the
// competition engine key (the set_competition Seal reader). Reads the index + Walrus blob via
// the data layer directly (no gateway needed). Usage:
//   npm run show-result -- comp_8b12d11a_8236c6a0

import { DataLayer } from "quadra-data";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { loadDataEnv, requireEnv } from "./shared.js";

async function main(): Promise<void> {
  loadDataEnv();
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("Usage: npm run show-result -- <jobId>   (e.g. comp_8b12d11a_8236c6a0)");
    process.exit(1);
  }

  const dl = DataLayer.forReads();
  const kp = Ed25519Keypair.fromSecretKey(requireEnv("COMPETITION_SECRET_KEY"));

  try {
    const r = await dl.jobResults.decrypt(jobId, kp);
    console.log(`job        : ${jobId}`);
    console.log(`agent      : ${r.agent}`);
    console.log(`template   : ${r.job.template.id} (evaluator: ${r.job.template.evaluator_id})`);
    console.log(`AI result  : ${JSON.stringify(r.agent_result)}`);
    console.log(`started_at : ${new Date(r.started_at).toISOString()}`);
    console.log(`delivered  : ${new Date(r.delivered_at).toISOString()}`);
  } catch (err) {
    console.error(`decrypt failed: ${err instanceof Error ? err.message : err}`);
    console.error("(no result indexed for this job, or the engine key is not the set_competition reader)");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("show-result error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
