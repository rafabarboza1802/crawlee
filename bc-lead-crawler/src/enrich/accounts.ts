import type { SegmentGroup } from '../schema.js';
import type { Business, Opportunity } from '../discover/types.js';
import type { BuyerDecision } from './buyers.js';
import { type AccountKind, accountKindFor } from './roles.js';

/** A company to research, with every qualified opportunity it is named on. */
export interface Account {
    /** Normalized company key used for dedupe and caching. */
    accountId: string;
    /** Name as published on the permit, cleaned of notes. */
    displayName: string;
    /** Name sent to the organization search (legal suffix and DataSF-truncated last word removed). */
    searchName: string;
    license?: string;
    role: 'contractor' | 'owner_business';
    kind: AccountKind;
    segment: SegmentGroup;
    opportunities: Opportunity[];
    bestScore: number;
    /** Buyer gate decision; only accounts classified "buyer" may reach Apollo. */
    buyer?: BuyerDecision;
}

export interface Exclusion {
    opportunity: Opportunity;
    reason: string;
}

const LEGAL_SUFFIX = /[,\s]+(?:inc|incorporated|llc|l\.l\.c|co|corp|corporation|company|ltd|lp|llp)\.?$/i;
/** DataSF truncates firm names at 40 characters. */
const DATASF_NAME_LIMIT = 40;

export function cleanCompanyName(name: string): string {
    return name.replace(/\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
}

export function searchNameFor(name: string): string {
    let n = cleanCompanyName(name);
    if (name.trim().length >= DATASF_NAME_LIMIT && n.includes(' ')) n = n.slice(0, n.lastIndexOf(' '));
    while (LEGAL_SUFFIX.test(n)) n = n.replace(LEGAL_SUFFIX, '');
    return n.trim();
}

export function accountIdFor(name: string): string {
    return searchNameFor(name)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

/** The company Best Construction should approach for an opportunity: the contractor first, else a business owner. */
function targetBusiness(o: Opportunity): Business | undefined {
    return o.businesses.find((b) => b.role === 'contractor') ?? o.businesses.find((b) => b.role === 'owner_business');
}

/**
 * Selects qualified opportunities (score ≥ min, business contacts allowed, not a public agency) and groups them by
 * company. Homeowner-only and public projects never become accounts.
 */
export function buildAccounts(opportunities: Opportunity[], minScore: number, suppressed: Set<string> = new Set()) {
    const accounts = new Map<string, Account>();
    const excluded: Exclusion[] = [];
    const sorted = [...opportunities].sort((a, b) => b.score - a.score);

    for (const o of sorted) {
        if (o.score < minScore) continue;
        if (o.contact_policy === 'no_direct_contact' || o.lead_segment === 'residential') {
            excluded.push({ opportunity: o, reason: 'Homeowner project: no direct contact, never enriched' });
            continue;
        }
        if (o.lead_segment === 'public_construction') {
            excluded.push({ opportunity: o, reason: 'Public agency: use the procurement contact on the bid notice, no people search' });
            continue;
        }
        const business = targetBusiness(o);
        if (!business || (business.role !== 'contractor' && business.role !== 'owner_business')) {
            excluded.push({ opportunity: o, reason: 'No contractor or business owner named on the permit yet: watch for a contractor' });
            continue;
        }
        const accountId = accountIdFor(business.name);
        if (suppressed.has(accountId)) {
            excluded.push({ opportunity: o, reason: `Company is on the do-not-contact list (${business.name})` });
            continue;
        }
        const existing = accounts.get(accountId);
        if (existing) {
            existing.opportunities.push(o);
            continue;
        }
        accounts.set(accountId, {
            accountId,
            displayName: cleanCompanyName(business.name),
            searchName: searchNameFor(business.name),
            license: business.license,
            role: business.role,
            kind: accountKindFor(business.role, o.lead_segment),
            segment: o.lead_segment,
            opportunities: [o],
            bestScore: o.score,
        });
    }
    return { accounts: [...accounts.values()], excluded };
}
