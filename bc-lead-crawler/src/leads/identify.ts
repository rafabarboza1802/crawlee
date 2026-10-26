import type { ProjectSponsor } from '../discover/sources/sf-pipeline.js';
import { toBlklot } from '../discover/sources/sf-pipeline.js';
import type { Business, Opportunity } from '../discover/types.js';

/**
 * Who is behind a project, from public records only. Permit agents and pipeline "sponsors" are often the developer,
 * but just as often a land-use law firm, permit expediter, architect or engineer — those are never treated as buyers.
 */
const NOT_A_DEVELOPER =
    /design|architect|\barch\b|studio|engineer|structural|permit|expedit|consult|\bllp\b|\blaw\b|attorney|reuben|assoc|assco|construction|builders|contract|plumbing|electric|mechanical|\bsfdpw\b|\bdpw\b|city and county|department/i;

/** Abbreviations such as "RJR", "Ars", "Asd" cannot be identified reliably. */
const tooShort = (name: string) => name.replace(/[^a-z0-9]/gi, '').length <= 4;

export function isLikelyDeveloper(name: string): boolean {
    return !NOT_A_DEVELOPER.test(name) && !tooShort(name);
}

/** Single-purpose project LLCs ("560 Brannan Street, LLC", "Fillmore St Llc"): the developer behind them is unknown. */
export function isSinglePurposeEntity(name: string): boolean {
    return /\b(?:llc|l\.l\.c|lp|l\.p)\b/i.test(name) && (/\d/.test(name) || /\b(?:st|street|ave|avenue|blvd|boulevard|rd|road|way|owner|propco|venture)\b/i.test(name));
}

export interface IdentifiedCompany {
    role: 'general_contractor' | 'developer' | 'owner' | 'architect' | 'engineer' | 'applicant';
    name: string;
    source: string;
}

/** Every business named for the project (GC first), for the lead record and reports. */
export function companiesFor(o: Opportunity): IdentifiedCompany[] {
    const order: [Business['role'], IdentifiedCompany['role']][] = [
        ['contractor', 'general_contractor'],
        ['owner_business', 'owner'],
        ['agent', 'applicant'],
        ['architect', 'architect'],
        ['engineer', 'engineer'],
    ];
    const out: IdentifiedCompany[] = [];
    for (const [from, to] of order) {
        for (const b of o.businesses.filter((x) => x.role === from)) {
            const role = from === 'owner_business' && /pipeline|6jgi-cpb4/.test(b.source_url) ? 'developer' : to;
            if (!out.some((c) => c.name.toLowerCase() === b.name.toLowerCase())) out.push({ role, name: b.name, source: b.source_url });
        }
    }
    return out;
}

/**
 * When the permit names no GC and no business owner, adds the most likely developer from public information: the
 * Development Pipeline sponsor, else a developer-like permit agent. Returns the added business, if any.
 */
export function addLikelyDeveloper(o: Opportunity, sponsors: Map<string, ProjectSponsor>): Business | undefined {
    if (o.businesses.some((b) => b.role === 'contractor' || b.role === 'owner_business')) return undefined;
    const sponsor = o.location.parcel ? sponsors.get(toBlklot(o.location.parcel)) : undefined;
    let developer: Business | undefined;
    if (sponsor && isLikelyDeveloper(sponsor.sponsor)) developer = { role: 'owner_business', name: sponsor.sponsor, source_url: sponsor.sourceUrl };
    else {
        const otherRoles = new Set(o.businesses.filter((b) => b.role !== 'agent').map((b) => b.name.toLowerCase()));
        const agent = o.businesses.find((b) => b.role === 'agent' && !otherRoles.has(b.name.toLowerCase()) && isLikelyDeveloper(b.name));
        if (agent) developer = { role: 'owner_business', name: agent.name, source_url: agent.source_url };
    }
    if (developer && !isSinglePurposeEntity(developer.name)) {
        o.businesses.push(developer);
        return developer;
    }
    return undefined;
}
