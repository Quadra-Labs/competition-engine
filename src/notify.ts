/**
 * Socket.IO notifications to agents (the competition engine's side of competitionSocket.ts).
 *
 * When an enrolled agent has a free competition job, the engine pushes a `competition_job`
 * event to that agent's room. Agents authenticate the socket with the SAME Sui-signature scheme
 * as the intake engine (reusing AuthManager): they sign the personal message
 * `` `${ts}.${SOCKET_AUTH_MESSAGE}` `` and pass `{ ts, sig }` in the connection `auth`. On
 * success the socket joins a room named by its wallet, and the engine emits only to that room.
 */
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';

import type { AuthManager } from './auth.js';

/** Pushed to an agent when it has a free competition job to do. NO cost, NO escrow. */
export interface CompetitionJobNotice {
    competition_id: string;
    job_id: string;
    template_id: string;
    /** The raw data-layer JobTemplate (the agent re-parses it into an IntakeTemplate). */
    template: Record<string, unknown>;
    /** Pre-collected parameter values for the job. */
    params: Record<string, string>;
    lifetime: string;
    started_at_ms: number;
    deadline_ms: number;
    /** Resolution mode: 0 = scoring, 1 = performance. */
    kind: number;
    /** PERFORMANCE mode only: the starting portfolio (asset -> USD units). */
    portfolio?: Record<string, number>;
}

/** How the engine pushes notifications; decoupled from the transport. */
export interface AgentNotifier {
    competitionJob(agentWallet: string, notice: CompetitionJobNotice): void;
}

/** The fixed message body an agent signs to open a socket (domain separator). MUST match the
 * agent's competitionSocket.ts SOCKET_AUTH_MESSAGE. */
export const SOCKET_AUTH_MESSAGE = 'quadra-competition/socket';

/** A notifier backed by a live Socket.IO server, plus `close()` for shutdown. */
export interface SocketNotifier extends AgentNotifier {
    io: Server;
    close(): Promise<void>;
}

/**
 * Attach a Socket.IO server to `httpServer` that authenticates agents with `auth` and lets the
 * engine push `competition_job` events to per-agent rooms. Mirrors intake-engine/src/notify.ts.
 */
export function createNotifier(httpServer: HttpServer, auth: AuthManager): SocketNotifier {
    const io = new Server(httpServer, { serveClient: false });

    io.use((socket, next) => {
        const handshake = socket.handshake.auth as { ts?: number | string; sig?: string };
        const ts = Number(handshake?.ts);
        const sig = handshake?.sig;
        if (!sig || !Number.isFinite(ts)) {
            next(new Error('missing ts/sig'));
            return;
        }
        auth.verify(SOCKET_AUTH_MESSAGE, ts, sig)
            .then((wallet) => {
                socket.data.agentWallet = wallet;
                void socket.join(wallet);
                next();
            })
            .catch((err: unknown) => next(err instanceof Error ? err : new Error('unauthorized')));
    });

    io.on('connection', (socket: Socket) => {
        const wallet = socket.data.agentWallet as string;
        socket.emit('ready', { agent_wallet: wallet });
        console.log(`[competition] agent connected via socket: ${wallet}`);
        socket.on('disconnect', () => console.log(`[competition] agent disconnected: ${wallet}`));
    });

    return {
        io,
        competitionJob(agentWallet: string, notice: CompetitionJobNotice): void {
            io.to(agentWallet).emit('competition_job', notice);
        },
        async close(): Promise<void> {
            await new Promise<void>((resolve, reject) =>
                io.close((err) => (err ? reject(err) : resolve())),
            );
        },
    };
}
