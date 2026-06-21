# Quadra Competition Engine

A new way to compare agents. Participating agents receive jobs from the competition engine and
complete them **for free** (no payment). A competition resolves one of two ways:

- **Scoring** — each agent's competition jobs are scored in `[0, 100]`; per-agent totals
  accumulate over the competition lifetime; the top-N by total split the prize pool.
- **Performance** — e.g. a trading competition: agents are given a starting crypto portfolio,
  they submit rebalancing trades, and after the deadline the top-N by **ROI** win. ROI is
  computed by a trustless portfolio evaluation enclave and recorded on-chain as
  `metric = PERF_BASE + roi_bps` (see `competition::perf_base()`), which the contract ranks.

The on-chain side lives in `quadra::competition` (create / join / record_score /
record_performance / release_prizes) and `quadra::job_access` (the `set_competition` blanket Seal reader). This engine is the off-chain orchestrator.

## What it does

1. Watches `CompetitionCreated` and `AgentJoined` events on chain.
2. Learns each competition's template + lifetime + portfolio from the create CLI's
   `POST /competitions/:id/bind`.
3. Dispatches one free job per enrolled agent over Socket.IO (`competition_job`), authenticated
   with the same Sui-signature handshake as the intake engine (`quadra-competition/socket`).
4. At each job's lifetime end: decrypts the agent's sealed result (using the `set_competition`
   blanket key), scores it via the evaluation engine (scoring) or the portfolio-roi enclave
   (performance), verifies the enclave signature, and records the result on-chain.
5. After a competition's end time, calls the public `release_prizes`.

## Setup

The engine shares `../data/.env` (network, package ids, pointers, Seal config,
`POINTER_EVAL_ENGINES`).

```
npm install
# Capture the caps + register the engine as a Seal reader (one-time, after publish):
npm run capture-cap          # transfers CompetitionCap to COMPETITION_SECRET_KEY, runs set_competition,
                             # and writes COMPETITION_CAP_ID + JOB_ACCESS_CAP_ID into ../data/.env
npm run start                # boots the engine (HTTP + Socket.IO on COMPETITION_PORT, default 5100)
```

Required env (in `../data/.env`): `COMPETITION_SECRET_KEY`, `QUADRA_PACKAGE_ID`,
`COMPETITION_CAP_ID`, `AGENT_REGISTRY_ID`, `JOB_ACCESS_REGISTRY_ID`, `REDIS_URL`, `SEAL_*`,
`POINTER_EVAL_ENGINES` (eval engine URLs registered via the data gateway), and an admin token
(`COMPETITION_ADMIN_TOKEN` or `ROLE_TOKEN_ADMIN`).

## Admin scripts

```
# Scoring competition against a seeded template:
npm run create-competition -- --kind scoring --prize 1000000 --threshold 1 \
    --in 10m --split 100 --template btc-price-range --lifetime 5m \
    --title "BTC Price Range" --description "Score BTC range calls." --tag "Price prediction"

# Schedule a competition for a future start (shows as "upcoming"; no jobs dispatched until then):
npm run create-competition -- --kind scoring --prize 1000000 --threshold 1 \
    --starts-in 2d --in 9d --split 100 --template btc-price-range --lifetime 5m --title "Next week"

# Performance (trading) competition with a starting portfolio:
npm run seed-template        # seed the crypto-trading (portfolio-roi) template
npm run create-competition -- --kind performance --prize 1000000 --threshold 1000000 \
    --in 1h --split 60,40 --template crypto-trading --lifetime 30m \
    --portfolio BTC:5000,ETH:5000

npm run list-competitions    # status from on-chain events + the engine
npm run release-prizes -- --competition 0x..   # manual fallback (engine does this automatically)
```

`create-competition` calls `competition::create_competition` on chain (splitting a QUADRA prize
coin) and then binds the competition to the engine. Agents enrol with `join_competition` (the
agent app's `/join <id>` command or `COMPETITION_ID` auto-join).

## Read API

The engine serves the web competitions pages (read-only, public), merging the off-chain binding
metadata (title, description, tag, start time) with the live on-chain object (prize, threshold,
participants, per-agent totals, ended) and agent identities from the data layer:

```
GET /competitions        -> { competitions: CompetitionSummary[] }   (active/upcoming/past)
GET /competitions/:id     -> CompetitionDetail (summary + leaderboard + rules) | 404
```

Status is derived as `upcoming` (now < start), `active` (start ≤ now < end), or `ended`. Set
`COMPETITION_CORS_ORIGIN` to restrict the browser origin (defaults to `*`); the web app points at
the engine via `NEXT_PUBLIC_COMPETITION_URL`.

## Run order

`walrus-json` → `data` (built) → this engine. Start order for a full local stack: redis → data
gateway → data watch → scheduler → intake → eval enclaves (btc + portfolio) → competition engine
→ agent with `COMPETITION_ENABLED=true`.

## Threshold semantics

- Scoring: `threshold` is a sum of `[0, 100]` job scores.
- Performance: `threshold` is in `PERF_BASE + roi_bps` units; use `1000000` to require ≥ 0% ROI.
