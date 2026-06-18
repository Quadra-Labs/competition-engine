import { Transaction } from '@mysten/sui/transactions';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export interface CompetitionChainOptions {
    sui: SuiJsonRpcClient;
    /** Owns `CompetitionCap` and is the `set_competition` Seal reader. */
    keypair: Ed25519Keypair;
    quadraPackageId: string;
    competitionCapId: string;
    agentRegistryId: string;
}

/** Builds and submits the cap-gated competition records and the public prize release. Mirrors
 * the intake engine's Payments class. */
export class CompetitionChain {
    #o: CompetitionChainOptions;

    constructor(options: CompetitionChainOptions) {
        this.#o = options;
    }

    /** `record_score(cap, competition, registry, agent_id, job_id, score)` (SCORING mode). */
    async recordScore(
        competitionId: string,
        agentId: string,
        jobId: string,
        score: number,
    ): Promise<string> {
        const tx = new Transaction();
        tx.moveCall({
            target: `${this.#o.quadraPackageId}::competition::record_score`,
            arguments: [
                tx.object(this.#o.competitionCapId),
                tx.object(competitionId),
                tx.object(this.#o.agentRegistryId),
                tx.pure.address(agentId),
                tx.pure.string(jobId),
                tx.pure.u64(score),
            ],
        });
        return this.#exec(tx);
    }

    /** `record_performance(cap, competition, registry, agent_id, metric)` (PERFORMANCE mode). */
    async recordPerformance(
        competitionId: string,
        agentId: string,
        metric: number,
    ): Promise<string> {
        const tx = new Transaction();
        tx.moveCall({
            target: `${this.#o.quadraPackageId}::competition::record_performance`,
            arguments: [
                tx.object(this.#o.competitionCapId),
                tx.object(competitionId),
                tx.object(this.#o.agentRegistryId),
                tx.pure.address(agentId),
                tx.pure.u64(metric),
            ],
        });
        return this.#exec(tx);
    }

    /** `release_prizes(competition, clock)` — public + time-gated (no cap). */
    async releasePrizes(competitionId: string): Promise<string> {
        const tx = new Transaction();
        tx.moveCall({
            target: `${this.#o.quadraPackageId}::competition::release_prizes`,
            arguments: [tx.object(competitionId), tx.object.clock()],
        });
        return this.#exec(tx);
    }

    async #exec(tx: Transaction): Promise<string> {
        const res = await this.#o.sui.signAndExecuteTransaction({
            signer: this.#o.keypair,
            transaction: tx,
            options: { showEffects: true },
        });
        if (res.effects?.status.status !== 'success') {
            throw new Error(`tx ${res.digest} failed: ${res.effects?.status.error ?? 'unknown'}`);
        }
        return res.digest;
    }
}
