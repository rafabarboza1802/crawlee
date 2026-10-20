import { readFile } from 'node:fs/promises';

/** Previously paid lookups. Results are reused (never re-bought) until they are older than the TTL. */
export interface LookupCache {
    has(key: string): boolean;
}

interface CacheFile {
    version: 1;
    entries: Record<string, { retrieved_at: string }>;
}

export async function loadCache(path: string, ttlDays: number, now: Date): Promise<LookupCache> {
    let file: CacheFile = { version: 1, entries: {} };
    try {
        file = JSON.parse(await readFile(path, 'utf8')) as CacheFile;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const cutoff = now.getTime() - ttlDays * 86_400_000;
    return { has: (key) => Date.parse(file.entries[key]?.retrieved_at ?? '') >= cutoff };
}

/** Do-not-contact list: one company name, domain or email per line (# comments allowed). */
export async function loadSuppression(path: string, normalize: (value: string) => string): Promise<Set<string>> {
    try {
        const lines = (await readFile(path, 'utf8')).split(/\r?\n/).map((l) => l.trim());
        return new Set(lines.filter((l) => l && !l.startsWith('#')).map(normalize));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
        throw error;
    }
}
