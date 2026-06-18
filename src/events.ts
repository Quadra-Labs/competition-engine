import type { SuiJsonRpcClient, EventId, SuiEvent } from '@mysten/sui/jsonRpc';

import type { Store } from './store.js';

/** Decoded `quadra::competition::AgentJoined`. */
export interface AgentJoinedEvent {
    competition_id: string;
    agent_id: string;
}

/** Decoded `quadra::competition::CompetitionCreated`. */
export interface CompetitionCreatedEvent {
    competition_id: string;
    kind: number;
    end_time_ms: number;
}

export type EventHandler<T> = (event: T) => Promise<void>;

/**
 * Polls the chain for one Move event type, persisting a cursor in Redis (per `cursorName`) so
 * restarts neither miss nor replay. Polling, not the gRPC stream, is used on purpose: this
 * process also submits transactions, which can kill a long-lived stream (the same reasoning as
 * the intake engine's JobPaidWatcher).
 */
export class EventWatcher<T> {
    #sui: SuiJsonRpcClient;
    #store: Store;
    #eventType: string;
    #cursorName: string;
    #pollMs: number;
    #decode: (ev: SuiEvent) => T;
    #handler: EventHandler<T>;
    #timer: ReturnType<typeof setInterval> | undefined;
    #running = false;
    #busy = false;

    constructor(opts: {
        sui: SuiJsonRpcClient;
        store: Store;
        eventType: string;
        cursorName: string;
        pollMs: number;
        decode: (ev: SuiEvent) => T;
        handler: EventHandler<T>;
    }) {
        this.#sui = opts.sui;
        this.#store = opts.store;
        this.#eventType = opts.eventType;
        this.#cursorName = opts.cursorName;
        this.#pollMs = opts.pollMs;
        this.#decode = opts.decode;
        this.#handler = opts.handler;
    }

    start(): void {
        if (this.#running) return;
        this.#running = true;
        this.#timer = setInterval(() => void this.#poll(), this.#pollMs);
        void this.#poll();
    }

    stop(): void {
        this.#running = false;
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = undefined;
    }

    async #poll(): Promise<void> {
        if (this.#busy) return;
        this.#busy = true;
        try {
            let cursor = await this.#ensureCursor();
            for (;;) {
                const page = await this.#sui.queryEvents({
                    query: { MoveEventType: this.#eventType },
                    cursor,
                    order: 'ascending',
                    limit: 50,
                });
                for (const ev of page.data) await this.#handler(this.#decode(ev));
                if (page.data.length > 0 && page.nextCursor) {
                    cursor = page.nextCursor;
                    await this.#store.setCursor(this.#cursorName, JSON.stringify(cursor));
                }
                if (!page.hasNextPage) break;
            }
        } catch (error) {
            console.error(
                `[competition] ${this.#cursorName} poll failed:`,
                error instanceof Error ? error.message : error,
            );
        } finally {
            this.#busy = false;
        }
    }

    /** Resume from the saved cursor, or seed from the latest event on first run (so we never
     * replay the chain's whole history). */
    async #ensureCursor(): Promise<EventId | null> {
        const stored = await this.#store.getCursor(this.#cursorName);
        if (stored) return JSON.parse(stored) as EventId;
        const latest = await this.#sui.queryEvents({
            query: { MoveEventType: this.#eventType },
            order: 'descending',
            limit: 1,
        });
        const seed = latest.data[0]?.id ?? null;
        if (seed) await this.#store.setCursor(this.#cursorName, JSON.stringify(seed));
        return seed;
    }
}

export function decodeAgentJoined(ev: SuiEvent): AgentJoinedEvent {
    const p = ev.parsedJson as Record<string, string>;
    return { competition_id: p.competition_id ?? '', agent_id: p.agent_id ?? '' };
}

export function decodeCompetitionCreated(ev: SuiEvent): CompetitionCreatedEvent {
    const p = ev.parsedJson as Record<string, string>;
    return {
        competition_id: p.competition_id ?? '',
        kind: Number(p.kind ?? 0),
        end_time_ms: Number(p.end_time_ms ?? 0),
    };
}
