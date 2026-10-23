import type { ApolloClient } from '../enrich/apollo.js';
import { executePlans } from '../enrich/execute.js';
import { estimate } from '../enrich/plan.js';
import { recordEnrichment } from '../leads/contacts.js';
import { planContactBatch } from '../leads/pipeline.js';
import type { Workspace } from '../leads/workspace.js';

export interface AutoEnrichResult {
    companies: number;
    credits: number;
    contactsDiscovered: number;
    skipped: string[];
}

/**
 * FIND DECISION MAKER for approved buyers, automatically, within the standing limits: at most
 * autoEnrich.maxCreditsPerRun per run and never past the monthly cap (checked again before every paid call). Only
 * approved buyers with qualified leads that were never looked up are included; cached results are never re-bought.
 */
export async function autoEnrich(ws: Workspace, client: ApolloClient, now: Date, log: (m: string) => void): Promise<AutoEnrichResult> {
    const out: AutoEnrichResult = { companies: 0, credits: 0, contactsDiscovered: 0, skipped: [] };
    if (!ws.config.autoEnrich.enabled) {
        out.skipped.push('Automatic contact lookup is off (autoEnrich.enabled = false): use "Prepare contacts" to approve a batch.');
        return out;
    }
    const batch = await planContactBatch(ws.db, ws.registry, ws.settings, ws.config, ws.apolloCache, ws.researchCache, now);
    const capLeft = Math.max(0, batch.estimate.monthlyCreditCap - ws.ledger.creditsThisMonth(now));
    const budget = Math.min(ws.config.autoEnrich.maxCreditsPerRun, capLeft);
    let planned = 0;
    const chosen = batch.plans.filter((p) => {
        if (planned + p.creditsMax > budget) {
            out.skipped.push(`${p.account.displayName}: waits for the next run (credit limit for this run: ${budget})`);
            return false;
        }
        planned += p.creditsMax;
        return true;
    });
    if (!chosen.length) return out;
    const est = estimate(chosen, ws.config, now);
    const results = await executePlans(chosen, ws.config, client, ws.apolloCache, ws.ledger, {
        planId: est.planId,
        approvedCredits: est.creditsMax,
        monthlyCreditCap: est.monthlyCreditCap,
        now,
        log,
    });
    const found = recordEnrichment(results, chosen, ws.db, ws.contacts, est.planId, now);
    out.companies = chosen.length;
    out.credits = results.reduce((s, r) => s + r.creditsSpent, 0);
    out.contactsDiscovered = found.filter((c) => c.verified).length;
    for (const r of results.filter((x) => x.status === 'stopped_auth' || x.status === 'error')) out.skipped.push(`${r.accountId}: ${r.status}${r.note ? ` (${r.note})` : ''} — kept for retry`);
    return out;
}
