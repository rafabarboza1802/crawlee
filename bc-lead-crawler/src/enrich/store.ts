import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Previously paid lookups. Results are reused (never re-bought) until they are older than the TTL. */
export interface LookupCache {
    has(key: string): boolean;
}

interface CacheFile {
    version: 1;
    entries: Record<string, { retrieved_at: string; value: unknown }>;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
        throw error;
    }
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

/** Lookup cache stored as JSON. Negative results ("no match") are cached too, so they are never paid for twice. */
export class FileCache implements LookupCache {
    private constructor(
        private readonly path: string,
        private readonly file: CacheFile,
        private readonly cutoff: number,
    ) {}

    static async load(path: string, ttlDays: number, now: Date): Promise<FileCache> {
        const file = await readJson<CacheFile>(path, { version: 1, entries: {} });
        return new FileCache(path, file, now.getTime() - ttlDays * 86_400_000);
    }

    has(key: string): boolean {
        return Date.parse(this.file.entries[key]?.retrieved_at ?? '') >= this.cutoff;
    }

    get<T>(key: string): T | undefined {
        return this.has(key) ? (this.file.entries[key]!.value as T) : undefined;
    }

    async set(key: string, value: unknown, now: Date): Promise<void> {
        this.file.entries[key] = { retrieved_at: now.toISOString(), value };
        await writeJson(this.path, this.file);
    }
}

export async function loadCache(path: string, ttlDays: number, now: Date): Promise<FileCache> {
    return FileCache.load(path, ttlDays, now);
}

export interface LedgerEntry {
    at: string;
    plan_id: string;
    account_id: string;
    endpoint: string;
    credits: number;
    status: number;
}

/** Every paid call, so monthly spend can be checked before each run. Never contains keys or response data. */
export class Ledger {
    private constructor(
        private readonly path: string,
        private readonly entries: LedgerEntry[],
    ) {}

    static async load(path: string): Promise<Ledger> {
        return new Ledger(path, await readJson<LedgerEntry[]>(path, []));
    }

    all(): LedgerEntry[] {
        return [...this.entries];
    }

    creditsThisMonth(now: Date): number {
        const month = now.toISOString().slice(0, 7);
        return this.entries.filter((e) => e.at.startsWith(month)).reduce((s, e) => s + e.credits, 0);
    }

    async record(entry: LedgerEntry): Promise<void> {
        this.entries.push(entry);
        await writeJson(this.path, this.entries);
    }
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
