// shared.ts — small helpers for the competition admin CLIs: load the shared data/.env, read
// required env vars, parse `--flag value` args, and upsert keys back into data/.env (preserving
// the rest). Mirrors the conventions in data/sandbox/setup-env.ts and the agent seedTemplate.ts.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path to the shared data/.env (two levels up from competition/scripts). */
export const DATA_ENV_PATH = fileURLToPath(new URL("../../data/.env", import.meta.url));

/** Load data/.env (then a local .env if present) into process.env. Best-effort. */
export function loadDataEnv(): void {
  const loader = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  for (const path of [DATA_ENV_PATH, ".env"]) {
    try {
      loader(path);
    } catch {
      // optional
    }
  }
}

export function requireEnv(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (value.length === 0) {
    console.error(`Missing required env var ${name} (set it in data/.env).`);
    process.exit(1);
  }
  return value;
}

/** Network union for the @mysten/sui clients, from DATA_NETWORK (default testnet). */
export function network(): "testnet" | "mainnet" | "devnet" | "localnet" {
  const n = (process.env.DATA_NETWORK ?? "testnet").trim();
  return n === "mainnet" || n === "devnet" || n === "localnet" ? n : "testnet";
}

/** Parse `--flag value` / `--flag=value` / boolean `--flag` into a map. */
export function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

/** Upsert keys into data/.env, preserving everything else (with a .bak backup). */
export function upsertDataEnv(updates: Record<string, string>): void {
  if (!existsSync(DATA_ENV_PATH)) {
    console.error(`No .env at ${DATA_ENV_PATH}; run the data layer setup first.`);
    process.exit(1);
  }
  const text = readFileSync(DATA_ENV_PATH, "utf8");
  const lines = text.split("\n");
  const remaining = { ...updates };
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in remaining) {
      const value = remaining[key];
      delete remaining[key];
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(remaining)) next.push(`${key}=${value}`);
  copyFileSync(DATA_ENV_PATH, `${DATA_ENV_PATH}.bak`);
  writeFileSync(DATA_ENV_PATH, next.join("\n"));
}
