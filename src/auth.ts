import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import type { DataLayer } from 'quadra-data';

/** Thrown when a socket handshake fails authentication. */
export class AuthError extends Error {}

/**
 * Verifies agent-signed messages and that the signer is a registered agent — the SAME scheme
 * the intake engine uses (intake-engine/src/auth.ts), reused here for the competition socket.
 *
 * The agent signs the personal message `` `${ts}.${message}` `` with its Sui Ed25519 key and
 * presents `{ ts, sig }` in the socket handshake. The timestamp must be fresh (replay guard),
 * the signature must recover a Sui address, and that address must exist in the on-chain
 * `agents` registry.
 */
export class AuthManager {
    #dl: DataLayer;
    #windowMs: number;

    constructor(dl: DataLayer, windowMs: number) {
        this.#dl = dl;
        this.#windowMs = windowMs;
    }

    async verify(message: string, ts: number, signatureB64: string): Promise<string> {
        if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > this.#windowMs) {
            throw new AuthError('stale or missing timestamp');
        }
        const bytes = new TextEncoder().encode(`${ts}.${message}`);
        let wallet: string;
        try {
            const publicKey = await verifyPersonalMessageSignature(bytes, signatureB64);
            wallet = publicKey.toSuiAddress();
        } catch {
            throw new AuthError('bad signature');
        }
        const agent = await this.#dl.agents.get(wallet);
        if (!agent) throw new AuthError('agent not registered');
        return wallet;
    }
}
