import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Opportunity } from './types.js';

/** Remembers opportunities across runs so each run can flag what is new. */
export interface DiscoveryState {
    version: 1;
    seen: Record<string, { first_seen_at: string; last_seen_at: string; last_score: number; permits: string[] }>;
}

export async function loadState(path: string): Promise<DiscoveryState> {
    try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as DiscoveryState;
        if (parsed.version === 1 && parsed.seen) return parsed;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { version: 1, seen: {} };
}

export function updateState(state: DiscoveryState, opportunities: Opportunity[]): DiscoveryState {
    const seen = { ...state.seen };
    for (const o of opportunities) {
        const previous = seen[o.opportunity_id];
        seen[o.opportunity_id] = {
            first_seen_at: previous?.first_seen_at ?? o.first_seen_at,
            last_seen_at: o.discovered_at,
            last_score: o.score,
            permits: [...new Set([...(previous?.permits ?? []), o.permit.number, ...o.related_permits.map((r) => r.permit_number)])],
        };
    }
    return { version: 1, seen };
}

export async function saveState(path: string, state: DiscoveryState): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2) + '\n');
}
