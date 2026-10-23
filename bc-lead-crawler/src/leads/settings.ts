import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

/** Business settings for the lead pipeline. Optional file `leads.config.json`; every value has a safe default. */
export const LeadSettingsSchema = z.object({
    /** Permits filed or updated within this many days are discovered on each run. */
    lookbackDays: z.number().int().min(1).max(365).default(30),
    /** Opportunities below this score are never qualified (and never reach Apollo). */
    minScore: z.number().min(0).max(100).default(70),
    /** Opportunities below this score are not stored at all. */
    storeMinScore: z.number().min(0).max(100).default(40),
    /** Projects with a known value below this are too small for the target buyers. */
    minProjectValue: z.number().min(0).default(100_000),
    /** Bay Area priority (owner, 2026-10-23); other California counties are kept but ranked lower. */
    priorityCounties: z.array(z.string()).default(['San Francisco', 'Contra Costa', 'Alameda', 'Santa Clara', 'Sonoma', 'San Mateo']),
    /** Permit sources to run (see `npm run discover -- --list-sources` and sources.config.json). */
    sources: z.array(z.string()).default(['sf-dbi']),
    maxRowsPerSource: z.number().int().positive().default(10_000),
    /** How many leads the run summary shows. */
    topLeads: z.number().int().positive().default(15),
});
export type LeadSettings = z.infer<typeof LeadSettingsSchema>;

export async function loadLeadSettings(path: string): Promise<LeadSettings> {
    try {
        return LeadSettingsSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return LeadSettingsSchema.parse({});
        throw error;
    }
}

/**
 * Where everything lives. `data/` is committed so the master database, spending ledger and research survive new
 * sessions; `data/private/` (purchased contacts, Apollo responses) is git-ignored because the repository is public.
 */
export function dataPaths(dataDir = 'data') {
    const priv = join(dataDir, 'private');
    return {
        dataDir,
        db: join(dataDir, 'lead-db.json'),
        ledger: join(dataDir, 'apollo-ledger.json'),
        researchCache: join(dataDir, 'research-cache.json'),
        discoveryState: join(dataDir, 'discovery-state.json'),
        reports: join(dataDir, 'reports'),
        privateDir: priv,
        contacts: join(priv, 'contacts.json'),
        apolloCache: join(priv, 'apollo-cache.json'),
        privateReports: join(priv, 'reports'),
        lastOpportunities: join(priv, 'last-opportunities.jsonl'),
        estimates: join(priv, 'estimates'),
    };
}
export type DataPaths = ReturnType<typeof dataPaths>;
