import { DEFAULT_SETTINGS } from '../crawl.js';
import { type ApolloClient, domainFromUrl } from '../enrich/apollo.js';
import { publicCompanyContacts, type PublicCompanyInfo } from '../enrich/fallback.js';
import { buyerStatus } from '../leads/pipeline.js';
import { executePlans } from '../enrich/execute.js';
import { estimate } from '../enrich/plan.js';
import { recordEnrichment } from '../leads/contacts.js';
import { planContactBatch } from '../leads/pipeline.js';
import type { Workspace } from '../leads/workspace.js';

export interface AutoEnrichResult {
    companies: number;
    credits: number;
    /** Decision makers identified (with or without a verified email). */
    contactsDiscovered: number;
    verifiedEmails: number;
    /** Companies looked up that ended without a verified email, with the reason. */
    notEnriched: string[];
    /** Bid/estimating mailboxes found on company websites when Apollo had no verified email. */
    bidMailboxes: number;
    skipped: string[];
}

/**
 * FIND DECISION MAKER for approved buyers, automatically, within the standing limits: at most
 * autoEnrich.maxCreditsPerRun per run and never past the monthly cap (checked again before every paid call). Only
 * approved buyers with qualified leads that were never looked up are included; cached results are never re-bought.
 */
export async function autoEnrich(ws: Workspace, client: ApolloClient, now: Date, log: (m: string) => void): Promise<AutoEnrichResult> {
    const out: AutoEnrichResult = { companies: 0, credits: 0, contactsDiscovered: 0, verifiedEmails: 0, notEnriched: [], bidMailboxes: 0, skipped: [] };
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
    out.contactsDiscovered = found.length;
    out.verifiedEmails = found.filter((c) => c.verified).length;
    for (const r of results.filter((x) => x.status !== 'enriched')) {
        const account = chosen.find((p) => p.account.accountId === r.accountId)?.account;
        const name = account?.buyer?.resolvedName ?? account?.displayName ?? r.accountId;
        // FALLBACK: the company's own website, for a published bids/estimating mailbox (free, cached 90 days).
        const website = account?.buyer?.website ?? r.org?.website ?? (r.org?.domain ? `https://${r.org.domain}` : undefined);
        let fallback = '';
        if (account && website && domainFromUrl(website) && !['stopped_budget', 'stopped_auth'].includes(r.status)) {
            const key = `website:${domainFromUrl(website)}`;
            let info = ws.apolloCache.get<PublicCompanyInfo>(key);
            if (!info) {
                info = await publicCompanyContacts(website, { userAgent: DEFAULT_SETTINGS.userAgent, robotsToken: DEFAULT_SETTINGS.robotsUserAgent }).catch(
                    (e: Error): PublicCompanyInfo => ({ website, emails: [], phones: [], pagesChecked: 0, note: e.message }),
                );
                await ws.apolloCache.set(key, info, now);
            }
            const bid = info.emails.find((e) => e.kind === 'bid');
            if (bid) {
                ws.contacts.upsert({
                    id: `site:${bid.email}`,
                    company_id: account.accountId,
                    company_name: name,
                    name: `${name} estimating team`,
                    title: 'Published bids/estimating mailbox',
                    role_category: 'bid_mailbox',
                    business_email: bid.email,
                    email_status: 'published',
                    verified: true,
                    verify_notes: [`Published by the company on ${bid.sourceUrl}`],
                    linkedin_url: null,
                    company_phone: r.org?.phone ?? info.phones[0] ?? null,
                    company_website: website,
                    found_at: now.toISOString(),
                    plan_id: est.planId,
                });
                const company = ws.db.company(account.accountId);
                if (company?.enrichment) {
                    company.enrichment = { ...company.enrichment, verified_contacts: company.enrichment.verified_contacts + 1, contact_ids: [...company.enrichment.contact_ids, `site:${bid.email}`] };
                    const [status, reason] = buyerStatus(company);
                    for (const o of account.opportunities) ws.db.setStatus(o.opportunity_id, status, `${reason} (bids mailbox from the company website)`, 'system', now);
                }
                out.bidMailboxes++;
                continue;
            }
            fallback = info.note ? ` — website: ${info.note}` : ` — website checked (${info.pagesChecked} page(s)), no published bids mailbox${info.phones[0] ? `; main phone ${info.phones[0]}` : ''}`;
        }
        out.notEnriched.push(`${name}: ${r.status.replace(/_/g, ' ')}${r.note ? ` (${r.note})` : ''}${fallback}`);
    }
    for (const r of results.filter((x) => x.status === 'stopped_auth' || x.status === 'error')) out.skipped.push(`${r.accountId}: ${r.status}${r.note ? ` (${r.note})` : ''} — kept for retry`);
    return out;
}
