/**
 * dotenv.ts — a tiny, dependency-free .env loader.
 *
 * Values already present in the environment WIN over the file. That precedence is the opposite of
 * Node's `process.loadEnvFile`, which the Sui version of this service used: a key exported by pm2
 * or a container could be silently overwritten by a stale file on disk. Here that would mean an
 * operator CLI signing a `create` with a wallet the operator did not intend, against a competition
 * id derived from that same wallet — an id nobody can reproduce afterwards.
 *
 * A deliberate COPY of `intake-engine/src/dotenv.ts` rather than a shared import, for the reason
 * stated there: it is a leaf file reader with no protocol content, and `quadra-core` refuses to
 * carry filesystem access in its pure entry point.
 */

import { existsSync, readFileSync } from 'node:fs';

export function loadDotEnv(paths: readonly string[]): void {
    for (const path of paths) {
        if (!existsSync(path)) continue;

        let text: string;
        try {
            text = readFileSync(path, 'utf8');
        } catch {
            continue;
        }

        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (line.length === 0 || line.startsWith('#')) continue;

            const eq = line.indexOf('=');
            if (eq <= 0) continue;

            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim();
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }

            const existing = process.env[key];
            if (existing === undefined || existing.length === 0) process.env[key] = value;
        }
    }
}
