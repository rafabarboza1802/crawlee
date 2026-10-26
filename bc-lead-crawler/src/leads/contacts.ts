import type { Account } from '../enrich/accounts.js';
import { isVerifiedBusinessEmail, type ApolloOrg } from '../enrich/apollo.js';
import type { AccountResult, RankedPerson } from '../enrich/execute.js';
import type { AccountPlan } from '../enrich/plan.js';
import type { ContactStore, LeadDatabase } from './db.js';
import { buyerStatus, ENRICHMENT_STRATEGY } from './pipeline.js';
import type { ContactRecord } from './types.js';

const domainOf = (value?: string) =>
    value
        ?.toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .split(/[/?#]/)[0];

/**
 * VERIFY CONTACT: a contact is verified only with an Apollo-verified business email on the company's own domain and a
 * decision-making title. Anything else is kept as "found" with the reason.
 */
export function verifyContact(person: RankedPerson, org: ApolloOrg | undefined): { verified: boolean; notes: string[] } {
    const notes: string[] = [];
    if (!person.email) notes.push('No business email');
    else if (!isVerifiedBusinessEmail(person)) notes.push(`Email not verified (${person.emailStatus ?? 'unknown'}) or not a business address`);
    const companyDomain = domainOf(org?.domain ?? org?.website);
    const emailDomain = person.email?.split('@')[1]?.toLowerCase();
    if (person.email && companyDomain && emailDomain && !emailDomain.endsWith(companyDomain)) notes.push(`Email domain ${emailDomain} differs from company domain ${companyDomain}`);
    if (person.roleCategory === 'leadership') notes.push('Generic leadership contact: no estimator/precon/PM found');
    return { verified: notes.length === 0 || (notes.length === 1 && notes[0]!.startsWith('Generic')), notes };
}

/** Records an approved run in the database (public facts only) and the private contact store, then updates lead statuses. */
export function recordEnrichment(results: AccountResult[], plans: AccountPlan[], db: LeadDatabase, contacts: ContactStore, planId: string, now: Date): ContactRecord[] {
    const accounts = new Map<string, Account>(plans.map((p) => [p.account.accountId, p.account]));
    const found: ContactRecord[] = [];
    for (const r of results) {
        const account = accounts.get(r.accountId);
        if (!account) continue;
        const people = [r.primary, ...r.backups].filter((p): p is RankedPerson => !!p);
        const records = people.map((p): ContactRecord => {
            const check = p === r.primary ? verifyContact(p, r.org) : { verified: false, notes: ['Backup contact: email not purchased'] };
            return {
                id: p.id,
                company_id: account.accountId,
                company_name: account.buyer?.resolvedName ?? account.displayName,
                name: p.name,
                title: p.title ?? null,
                role_category: p.roleCategory,
                business_email: p === r.primary ? (p.email ?? null) : null,
                email_status: p === r.primary ? (p.email ? 'verified' : (p.emailStatus ?? null)) : null,
                verified: check.verified,
                verify_notes: check.notes,
                linkedin_url: p.linkedinUrl ?? null,
                company_phone: r.org?.phone ?? null,
                company_website: r.org?.website ?? (r.org?.domain ? `https://${r.org.domain}` : null),
                found_at: now.toISOString(),
                plan_id: planId,
            };
        });
        for (const c of records) contacts.upsert(c);
        found.push(...records);
        db.setEnrichment(account.accountId, {
            status: r.status,
            at: now.toISOString(),
            plan_id: planId,
            credits: r.creditsSpent,
            contact_ids: records.map((c) => c.id),
            verified_contacts: records.filter((c) => c.verified).length,
            people_found: records.length,
            strategy: ENRICHMENT_STRATEGY,
            ...(r.org?.website ? { company_website: r.org.website } : {}),
            ...(r.org?.phone ? { company_phone: r.org.phone } : {}),
            ...(r.note ? { note: r.note } : {}),
        });
        const [status, reason] = buyerStatus(db.company(account.accountId));
        for (const o of account.opportunities) db.setStatus(o.opportunity_id, status, reason, 'system', now);
    }
    return found;
}
