import { access, mkdir, readFile, writeFile } from 'node:fs/promises';

import { DEFAULT_SETTINGS } from '../crawl.js';
import { discover } from '../discover/discover.js';
import { findSource } from '../discover/sources/registry.js';
import type { SourceContext } from '../discover/sources/source.js';
import { loadState, saveState, updateState } from '../discover/state.js';
import { type Opportunity, OpportunitySchema } from '../discover/types.js';
import { accountIdFor } from '../enrich/accounts.js';
import { loadBuyerRegistry } from '../enrich/buyers.js';
import { loadEnrichConfig } from '../enrich/config.js';
import { Ledger, loadCache, loadSuppression } from '../enrich/store.js';
import { ContactStore, LeadDatabase } from './db.js';
import { dataPaths, loadLeadSettings } from './settings.js';

export interface WorkspaceOptions {
    dataDir: string;
    settingsPath: string;
    registryPath: string;
    enrichConfigPath: string;
    sourcesPath: string;
    suppressionPath: string;
}

export const DEFAULT_WORKSPACE: WorkspaceOptions = {
    dataDir: 'data',
    settingsPath: 'leads.config.json',
    registryPath: 'buyer-registry.json',
    enrichConfigPath: 'enrich.config.json',
    sourcesPath: 'sources.config.json',
    suppressionPath: 'suppression.txt',
};

export async function exists(path: string) {
    return access(path).then(
        () => true,
        () => false,
    );
}

export const readJsonl = async (path: string): Promise<Opportunity[]> =>
    (await readFile(path, 'utf8'))
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => OpportunitySchema.parse(JSON.parse(l)));

export function sourceContext(log: (m: string) => void = (m) => console.error(m)): SourceContext {
    return {
        userAgent: DEFAULT_SETTINGS.userAgent,
        robotsToken: DEFAULT_SETTINGS.robotsUserAgent,
        appToken: process.env.SOCRATA_APP_TOKEN || undefined,
        baseUrl: process.env.DISCOVER_BASE_URL || undefined,
        log,
    };
}

/** Everything a run reads: settings, registry, master database, caches, ledger. */
export async function loadWorkspace(o: WorkspaceOptions, now: Date) {
    const paths = dataPaths(o.dataDir);
    const settings = await loadLeadSettings(o.settingsPath);
    const config = await loadEnrichConfig(o.enrichConfigPath);
    return {
        paths,
        settings,
        config,
        registry: await loadBuyerRegistry(o.registryPath),
        db: await LeadDatabase.load(paths.db),
        contacts: await ContactStore.load(paths.contacts),
        researchCache: await loadCache(paths.researchCache, 30, now),
        apolloCache: await loadCache(paths.apolloCache, config.cacheTtlDays, now),
        ledger: await Ledger.load(paths.ledger),
        suppressed: await loadSuppression(o.suppressionPath, accountIdFor),
    };
}
export type Workspace = Awaited<ReturnType<typeof loadWorkspace>>;

export interface SourceRun {
    id: string;
    name: string;
    ok: boolean;
    permits: number;
    opportunities: number;
    newOpportunities: number;
    error?: string;
}

/** DISCOVER: every configured public permit source (free). One failing source never stops the others. */
export async function discoverAll(
    ws: Workspace,
    o: { sourcesPath: string; days?: number; input?: string; reuse?: boolean },
    ctx: SourceContext,
    now: Date,
): Promise<{ opportunities: Opportunity[]; sources: SourceRun[]; warnings: string[] }> {
    const warnings: string[] = [];
    if (o.input) return { opportunities: await readJsonl(o.input), sources: [{ id: 'file', name: o.input, ok: true, permits: 0, opportunities: 0, newOpportunities: 0 }], warnings };
    if (o.reuse && (await exists(ws.paths.lastOpportunities))) {
        return { opportunities: await readJsonl(ws.paths.lastOpportunities), sources: [{ id: 'reuse', name: 'last run (no download)', ok: true, permits: 0, opportunities: 0, newOpportunities: 0 }], warnings };
    }
    const state = await loadState(ws.paths.discoveryState);
    const all: Opportunity[] = [];
    const sources: SourceRun[] = [];
    for (const id of ws.settings.sources) {
        try {
            const source = await findSource(id, o.sourcesPath);
            const result = await discover({
                source,
                ctx,
                days: o.days ?? ws.settings.lookbackDays,
                minScore: ws.settings.storeMinScore,
                maxRows: ws.settings.maxRowsPerSource,
                state,
                now,
            });
            const s = result.stats;
            sources.push({ id, name: source.name, ok: true, permits: s.fetched, opportunities: s.opportunities, newOpportunities: s.newOpportunities });
            warnings.push(...result.warnings.map((w) => `${source.name}: ${w}`));
            Object.assign(state, updateState(state, result.opportunities));
            all.push(...result.opportunities);
        } catch (error) {
            sources.push({ id, name: id, ok: false, permits: 0, opportunities: 0, newOpportunities: 0, error: (error as Error).message });
            warnings.push(`Source ${id} failed: ${(error as Error).message}`);
        }
    }
    await saveState(ws.paths.discoveryState, state);
    await mkdir(ws.paths.privateDir, { recursive: true });
    await writeFile(ws.paths.lastOpportunities, all.map((x) => JSON.stringify(x)).join('\n') + (all.length ? '\n' : ''));
    return { opportunities: all, sources, warnings };
}
