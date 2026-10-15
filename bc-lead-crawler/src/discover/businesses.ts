import type { Business, BusinessRole } from './types.js';

/** Raw contact as published by a permit source. Only these fields are ever requested. */
export interface PermitContact {
    permitNumber: string;
    role?: string;
    firmName?: string;
    license?: string;
}

const ENTITY_RE =
    /\b(?:llc|l\.l\.c\.?|inc\.?|incorporated|corp\.?|corporation|co\.|company|l\.?p\.?|llp|ltd\.?|partners(?:hip)?|properties|property|development|developers?|holdings?|investments?|realty|real estate|group|associates|builders?|construction|contractors?|homes|housing|apartments|management|ventures|capital|reit|fund|authority|district|agency|city and county|county of|city of|state of|university|school)\b/i;
const PERSONAL_RE = /\b(?:living trust|family trust|revocable|irrevocable|trustees?|estate of|survivor'?s? trust|et al|et ux)\b/i;

export function normalizeRole(role: string | undefined): BusinessRole {
    const r = (role ?? '').toLowerCase();
    if (/contractor|builder/.test(r)) return 'contractor';
    if (/owner|developer|lessee/.test(r)) return 'owner_business';
    if (/architect|designer/.test(r)) return 'architect';
    if (/engineer/.test(r)) return 'engineer';
    if (/agent|expedit|applicant|consultant/.test(r)) return 'agent';
    return 'other';
}

/** True when a name is clearly a business entity (not a person or a family trust). */
export function isBusinessEntity(name: string): boolean {
    return ENTITY_RE.test(name) && !PERSONAL_RE.test(name);
}

/**
 * Converts permit contacts into businesses.
 * - Only the firm name is used; first/last-name fields are never requested from the source.
 * - Contractors, architects, engineers and agents are licensed businesses when a firm name is published.
 * - Owners are kept only when the owner is clearly a business entity (LLC, developer, agency, ...);
 *   individual homeowners and family trusts are dropped.
 */
export function toBusinesses(contacts: PermitContact[], sourceUrl: string): Business[] {
    const out: Business[] = [];
    const seen = new Set<string>();
    for (const c of contacts) {
        const name = c.firmName?.replace(/\s+/g, ' ').trim();
        if (!name) continue;
        const role = normalizeRole(c.role);
        if (role === 'owner_business' || role === 'other' ? !isBusinessEntity(name) : PERSONAL_RE.test(name)) continue;
        const key = `${role}:${name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ role, name, ...(c.license?.trim() ? { license: c.license.trim() } : {}), source_url: sourceUrl });
    }
    return out;
}
