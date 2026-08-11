/**
 * abis.ts — the slice of `SealedCompetition` this repo touches.
 *
 * Human-readable signatures rather than the JSON artifact, matching `data/src/chain/abis.ts`,
 * `data/packages/verify/src/abis.ts`, `agent/app/src/chain/abis.ts`,
 * `evaluation-engine/src/chain/abis.ts` and `scheduler/src/abis.ts` so all of them can be compared
 * by eye. This is the SIXTH hand-written copy in the system; `contracts/script/abi.sh --check`
 * proves `contracts/abi/*.json` still matches the Solidity and proves nothing about these
 * fragments, so every one below was transcribed from `contracts/src/SealedCompetition.sol` and the
 * writes carry a line reference.
 *
 * DELIBERATELY PARTIAL. `join`, `submitSealed`, `settleFromTee`, `setOperator` and the Passport
 * surface are absent rather than commented out. Joining and submitting are the agent's, the FCC
 * entrypoint is the relayer's, and ownership is the deployer's — an ABI that named them would make
 * calling one a matter of autocomplete rather than intent.
 */

import { parseAbi } from 'viem';

export const sealedCompetitionAbi = parseAbi([
    // --- reads ---
    // FIFTEEN fields, positional. Existence is `exists`, never `resolveAt != 0`: the Flare
    // prototype used that sentinel and read a funded competition as nonexistent. `lifetimeSecs`
    // and `params` are APPENDED after `creator` (the auto-getter omits the dynamic `splitPct`), so
    // every index that already existed still points at the same field. Pinned on the contract side
    // by `test_theCompetitionGetterKeepsItsExistingIndices`.
    'function competitions(bytes32) view returns (string evaluatorId, bytes32 category, uint8 kind, uint256 stake, uint256 seedPrize, uint256 stakedTotal, uint256 prizePool, uint64 resolveAt, uint64 threshold, bool exists, bool settled, bool cancelled, address creator, uint32 lifetimeSecs, bytes params)',
    // The winner split is a dynamic array, so the struct's auto-getter leaves it out entirely and
    // it costs its own call. Its LENGTH is the number of winner slots, which is what the Sui event
    // used to carry as `winners`.
    'function getSplit(bytes32) view returns (uint16[])',
    'function submissions(bytes32, address) view returns (bytes32)',
    'function joined(bytes32, address) view returns (bool)',
    'function staked(bytes32, address) view returns (uint256)',
    'function owed(address) view returns (uint256)',
    'function settledReceiptHash(bytes32) view returns (bytes32)',
    'function token() view returns (address)',
    // A public constant, so it has an auto-getter. Read live rather than trusted from the copy
    // below whenever a cancel is about to be attempted.
    'function CANCEL_WINDOW() view returns (uint256)',

    // --- writes ---
    //
    // `create` — SealedCompetition.sol:318. Operator-gated: `operators[msg.sender]` must be true,
    // and the QUADRA prize is pulled with `transferFrom`, so the caller must `approve` first.
    'function create(bytes32 competitionId, string evaluatorId, uint8 kind, uint256 stake, uint64 resolveAt, uint64 threshold, uint16[] splitPct, uint256 prize, uint32 lifetimeSecs, bytes params)',
    //
    // `settle` — SealedCompetition.sol:480. PERMISSIONLESS: authority is the TEE signature inside
    // `signature`, never `msg.sender`. NOTE `proofs` is NOT adjacent to `groundTruthValues` —
    // `entries` and `signature` sit between them. That is the detail a hand-built tuple gets wrong,
    // which is why the tuple is rebuilt in exactly one place (`evalClient.ts`) from the order in
    // `evaluation-engine/src/settlement.ts::competitionSettleArgs`.
    'function settle(bytes32 competitionId, bytes32 receiptHash, bytes21[] feedIds, uint256[] groundTruthValues, EntryInput[] entries, bytes signature, FeedDataWithProof[] proofs, bytes receipt)',
    // Permissionless once `resolveAt + CANCEL_WINDOW` has passed. Refunds the seed to the creator
    // and frees every stake for `withdrawStake`.
    'function cancel(bytes32 competitionId)',
    // Creator-only, after settlement: the dust left when a slot lapsed or a share rounded down.
    'function withdrawRemaining(bytes32 competitionId)',

    // --- events ---
    // `resolveAt` and the scored window are carried IN the event, so the registry can index a
    // competition from the log with no follow-up read.
    'event CompetitionCreated(bytes32 indexed competitionId, string evaluatorId, uint8 kind, uint256 stake, uint256 seedPrize, uint64 resolveAt, uint64 threshold, address indexed creator, uint32 lifetimeSecs, bytes params)',
    'event Joined(bytes32 indexed competitionId, address indexed agent, uint256 stake)',
    'event Submitted(bytes32 indexed competitionId, address indexed agent, bytes32 ciphertextHash)',
    'event Settled(bytes32 indexed competitionId, bytes32 receiptHash, uint256 winners, uint256 totalPaid)',
    'event PrizeAwarded(bytes32 indexed competitionId, address indexed agent, uint256 rank, uint256 amount)',
    // The full audit body, emitted verbatim at settlement. The only place a competition's scores
    // exist off the settle calldata — there is no per-score event.
    'event ReceiptPublished(bytes32 indexed competitionId, bytes receipt)',
    'event Cancelled(bytes32 indexed competitionId, uint256 seedReturned)',
    'event StakeWithdrawn(bytes32 indexed competitionId, address indexed agent, uint256 amount)',
    'event RemainingWithdrawn(bytes32 indexed competitionId, address indexed to, uint256 amount)',

    // --- struct definitions used by the writes above ---
    'struct FeedData { uint32 votingRoundId; bytes21 id; int32 value; uint16 turnoutBPS; int8 decimals; }',
    'struct FeedDataWithProof { bytes32[] proof; FeedData body; }',
    // `score` is uint64 — a performance metric around 1e6, not the uint8 a paid job carries. The
    // width is baked into the EIP-712 `Entry` typehash, so it is not a transcription choice.
    'struct EntryInput { address agent; uint64 score; }',
]);

/** Just enough ERC-20 for the create CLI to fund a prize. */
export const erc20Abi = parseAbi([
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
]);

/** Resolution modes, mirroring the contract's constants. */
export const KIND_SCORING = 0;
export const KIND_PERFORMANCE = 1;

/** Zero-ROI baseline for a performance metric: `metric = PERF_BASE + roi_bps`. */
export const PERF_BASE = 1_000_000n;

/** `SealedCompetition.MAX_WINNER_SLOTS`. A longer split reverts `TooManySlots`. */
export const MAX_WINNER_SLOTS = 16;

/** `SealedCompetition.MAX_PARAMS_BYTES`. A larger scope blob reverts `ParamsTooLong`. */
export const MAX_PARAMS_BYTES = 512;

/**
 * `SealedCompetition.CANCEL_WINDOW`. After `resolveAt + this`, `cancel()` is permissionless.
 *
 * A local copy for printing a countdown before an RPC round trip. The cancel CLI reads the live
 * getter before it sends anything, because this constant being wrong would mean telling an operator
 * a competition is cancellable when the contract disagrees.
 */
export const CANCEL_WINDOW_SECS = 3 * 24 * 60 * 60;
