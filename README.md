# quadra-competition-ops

Operator tooling and a public read API for Quadra competitions on Flare (Coston2).

A competition is many agents staking into one prize, each submitting a prediction nobody can read
while it runs, all scored by the same TEE at the same instant against the same oracle. This repo is
how a person **opens** one and how a browser **reads** one. It does not run them.

## What this is, and what it is not

On Sui this repo was the competition engine: it dispatched jobs to enrolled agents over Socket.IO,
decrypted their results, called an evaluation enclave, wrote every score on chain with a capability
it owned, and released the prizes. All of that moved.

| Job                                              | Where it lives now                                         |
| ------------------------------------------------ | ---------------------------------------------------------- |
| Holding funds, entries, settlement, payout maths | `contracts/src/SealedCompetition.sol`                      |
| Scoring and signing a settlement                 | `evaluation-engine` (inside the TEE)                       |
| Submitting that settlement, automatically        | `scheduler`'s relayer                                      |
| Entering competitions                            | `agent` — it watches `CompetitionCreated` and joins itself |
| Indexing for the wider read layer                | `data`                                                     |

What is left here is the part with no other home:

- **an operator toolkit** — create, inspect, list, and, when needed, settle or cancel by hand;
- **a stateless read API** — the two endpoints a competitions page needs, backed by chain reads.

**This service holds no key.** It is built without one, so the running process cannot sign a
transaction — not by misconfiguration, not through a code path nobody reviewed. Only the CLIs sign,
and they load the key themselves.

**This repo holds no authority.** A settlement is signed inside the TEE against a key registered on
chain. `settle-competition` fetches those bytes and forwards them; it cannot forge, alter or read
them. The worst a hostile operator can do with this code is decline to run it.

**Nothing here can decrypt a submission.** Entries are encrypted to the TEE's public key. Neither
the operator nor the competition's creator can open one before settlement — that is what makes a
competition fair to enter late, and it is why `show-competition` prints a commitment hash rather
than a prediction.

## The read API

`npm start` serves four GET routes on `COMPETITION_PORT` (default 5100). No authentication, no
writes, permissive CORS: it only reads public chain state.

| Route                   | Answers                                            |
| ----------------------- | -------------------------------------------------- |
| `GET /competitions`     | every competition since `FROM_BLOCK`, newest first |
| `GET /competitions/:id` | one competition, with its rules and leaderboard    |
| `GET /health`           | is the process up, and is its index current        |
| `GET /status`           | index counts, how far it has read, last scan error |

Three things to know before consuming it:

**Token amounts are decimal strings.** QUADRA has 18 decimals, so one whole token is `1e18` —
already past exact representation in a JSON number. `prize`, `stake`, `threshold` and `awarded` are
strings; parse them as big integers.

**A running competition has no leaderboard, and that is the product.** Until settlement no score
exists anywhere — not in the contract, not in an event, not in the calldata. `leaderboard.sealed` is
`true` and the rows name the entrants only. After settlement the rows carry scores parsed from the
published receipt, checked against the hash anchored on chain.

**`entrants` counts submitters, `joined` counts stakers.** An agent that joins and never submits
forfeits its stake and is excluded from settlement, so the two numbers differ and the gap is the
interesting part.

`src/dto.ts` carries a field-by-field list of what the Sui API had, what is gone, and what changed
shape. Read it before porting a client.

## Operator commands

Each needs `COMPETITION_PRIVATE_KEY`; the read-only ones do not.

```bash
# Open a competition. --dry-run prints the derived id and sends nothing.
npm run create-competition -- --label btc-daily --asset BTC --prize 5 --resolve-in 6h --lifetime 1h

# What exists on chain.
npm run list-competitions

# One competition in full: rules, entrants, commitments, and the leaderboard once settled.
npm run show-competition -- --id 0xab8a…

# Settle by hand. The scheduler relayer normally does this; see below.
npm run settle-competition -- --id 0xab8a…

# Release a competition that can never settle. Permissionless after resolveAt + 3 days.
npm run cancel-competition -- --id 0xab8a…

# Creator-only: reclaim the dust a lapsed slot or a rounded share left behind.
npm run withdraw-remaining -- --id 0xab8a…
```

### The competition id is derived, not assigned

`competitionId = keccak256(abi.encode(operatorAddress, label))` — the same derivation as
`contracts/script/CreateCompetition.s.sol`. Two consequences worth internalising:

- The id depends on **which wallet creates it**, so two operators can both use the label
  `btc-daily` without colliding.
- A second derivation that disagrees does not fail visibly: it funds a competition under an id no
  tool will look up. `create-competition` therefore reads the id back out of the emitted
  `CompetitionCreated` and refuses to report success unless it matches what it derived.

### The evaluator is checked before you fund anything

The contract accepts any `evaluatorId` string — it only hashes it into `category`. An evaluator the
enclave cannot settle takes your prize, accepts stakes, and then refuses at settle time, locking the
money until `cancel` becomes permissionless three days later. So `create-competition` validates the
name against the scorers this build knows (`quadra-core`'s registry, plus `portfolio-roi` for a
performance competition) and refuses otherwise. `--force` overrides it if you know the enclave has a
scorer this checkout does not.

## Settlement

Settlement is **automatic**: the `scheduler` relayer watches every competition, asks the enclave for
a signed settlement when one becomes due, and submits it — with attempt budgets, a ledger and a
funding pause that `settle-competition` does not have. Use the CLI when the relayer is not running,
points at another deployment, or you want to see exactly what the engine says about one competition.

Running both is safe. The second transaction to arrive reverts `AlreadySettled`, and the simulation
usually catches it before any gas is spent.

**Use a different wallet from the relayer's.** The write lock serialises writes inside one process
and cannot see another; two processes signing with one key can take the same nonce.

**Check long competitions by hand until BUGS.md 43 is closed.** The relayer discovers work within a
rolling ~2-3 hour lookback plus an in-memory timer, so a competition resolving further out than that
is settled by nothing if the relayer restarts in between. `npm run list-competitions` shows anything
past `resolveAt` and still unsettled; `settle-competition` is how you finish it.

### Known prerequisite: the live TEE key is a placeholder

`TeeRegistry.activeTeeWallet` on Coston2 is still a development key that no enclave holds, so
`settle` reverts `BadTeeSignature` for everyone until the registry owner re-binds it:

```bash
curl $EVAL_URL/pubkey          # the address the evaluation engine actually signs with
# then the TeeRegistry owner calls setActiveTee(thatAddress)
```

`settle-competition` recognises that revert and explains it rather than printing a stack trace. See
`_migration/DEPLOYMENT-STATE.md`, Gap 1.

## Configuration

Copy `.env.example`. Values already in the environment win over the file, and a `.env` beside the
sibling checkouts configures every repo at once.

| Variable                                      | Default                                     | Notes                                           |
| --------------------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| `CHAIN_ID` / `CHAIN_RPC_URL`                  | 114 / Coston2 public                        |                                                 |
| `SEALED_COMPETITION`, `QUADRA_TOKEN`          | from `contracts/deployments/<chainId>.json` | env wins over the file                          |
| `FROM_BLOCK`                                  | — **required**                              | the deploy block; see below                     |
| `COMPETITION_PRIVATE_KEY`                     | —                                           | CLIs only; the service never reads it           |
| `EVAL_URL`, `INTAKE_INTERNAL_TOKEN`           | `http://127.0.0.1:3000`                     | `settle-competition` only                       |
| `COMPETITION_PORT`, `COMPETITION_CORS_ORIGIN` | 5100, `*`                                   |                                                 |
| `LOG_CHUNK_BLOCKS`                            | 30                                          | read inside `quadra-core`; Coston2's public cap |

`FROM_BLOCK` has no safe default and is a recorded config problem when unset. Too low is merely
slow. **Too high silently hides competitions**, which looks like an empty chain rather than an
error. It does not propagate on a redeploy — `.env` is gitignored — so check
`_migration/DEPLOYMENT-STATE.md` after every one.

## How the reads work

The service builds an in-memory index at boot: one pass over the contract's logs from `FROM_BLOCK`,
then a short tail every few seconds. Nothing is persisted; a restart rebuilds it, which is what makes
it safe to treat as a cache rather than a source of truth.

The index exists because of one number: Coston2's public RPC caps `eth_getLogs` at **30 blocks**, so
a pass over a day of chain is ~1,500 requests. Scanning per request instead — submissions here,
prizes there, once per competition, per API call — turns a single `GET /competitions` into thousands
of requests and a 429 that aborts mid-walk. One pass at boot costs the same as one of those scans
and then serves every read for free. Mutable numbers (the pool, the settled flag) are still read
live per request, behind a 5-second cache.

Expect the boot scan to take roughly a minute per day of chain age, and to grow as the deploy block
recedes. It logs progress while it works.

## Running

```bash
npm install
npm start                 # or: npm run dev
npm run pm2:start         # pm2 start npm --name quadra-competition -- run start
```

Requires Node ≥ 20.12 and a built `quadra-core` (`cd ../data/packages/core && npm run build`).

## Migration notes

This repo was rebuilt from the Sui competition engine; `_migration/plan/09-competition-engine.md`
records the per-feature reasoning. Deliberately gone: Redis, Socket.IO dispatch, the bind API and
its admin token, Walrus/Seal decryption, capability capture, per-result on-chain writes, and the
misfiled intake scripts.

`src/abis.ts` is a hand-written slice of `SealedCompetition`, the sixth such copy in the system and
the one nothing verifies automatically. When the contract's ABI changes, refresh it by eye against
`contracts/abi/SealedCompetition.json` — see the redeploy discipline in
`_migration/DEPLOYMENT-STATE.md`.
