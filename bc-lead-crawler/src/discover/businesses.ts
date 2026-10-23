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

/** Trade and design-firm words: a name containing one is a business, not a person. */
const TRADE_RE =
    /\b(?:designs?|designers?|architect\w*|engineer\w*|structural|studio|interiors?|landscap\w*|permit\w*|consult\w*|solutions|services|restoration\w*|remodel\w*|roof\w*|plumbing|electric\w*|mechanical|concrete|paving|demolition|excavation|masonry|assoc\.?|dba|works|build\w*|contract\w*|engineering|expedit\w*)\b/i;
/** The property owner did the work themselves: not a business. */
const OWNER_SELF_RE = /^(?:home|property\s+)?owner(?:[\s/-]*builder)?$|^(?:self|n\/?a|none|tbd|same|unknown)$/i;
/** Professional credential after a personal name, e.g. "A. Gordon Atkinson AIA". */
const CREDENTIAL_SUFFIX_RE = /\b(?:aia|p\.?e|s\.?e|r\.?a|esq)\.?$/i;

export function normalizeRole(role: string | undefined): BusinessRole {
    const r = (role ?? '').toLowerCase();
    if (/contractor|builder/.test(r)) return 'contractor';
    if (/owner|developer|lessee/.test(r)) return 'owner_business';
    if (/architect|designer/.test(r)) return 'architect';
    if (/engineer/.test(r)) return 'engineer';
    if (/agent|expedit|applicant|consultant/.test(r)) return 'agent';
    return 'other';
}

/**
 * True when a published name looks like a company. Names that look like people ("Doug Lee") are dropped even when a
 * permit lists them as a firm, so personal names are never stored.
 */
export function isCompanyName(name: string): boolean {
    const n = name.replace(/\s+/g, ' ').trim();
    if (!n || OWNER_SELF_RE.test(n) || PERSONAL_RE.test(n) || CREDENTIAL_SUFFIX_RE.test(n)) return false;
    if (ENTITY_RE.test(n) || TRADE_RE.test(n) || /[&+]/.test(n)) return true;
    // A single word ("Rmw", "Revel") is a brand or acronym, not a first + last name.
    return !n.includes(' ');
}

/** True when a name is clearly a business entity (not a person or a family trust). */
export function isBusinessEntity(name: string): boolean {
    return ENTITY_RE.test(name) && !PERSONAL_RE.test(name);
}

/**
 * Converts permit contacts into businesses.
 * - Only the firm name is used; first/last-name fields are never requested from the source.
 * - The firm name must look like a company (see isCompanyName): "Owner Builder" and personal names are dropped.
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
        if (!isCompanyName(name)) continue;
        if ((role === 'owner_business' || role === 'other') && !isBusinessEntity(name)) continue;
        const key = `${role}:${name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ role, name, ...(c.license?.trim() ? { license: c.license.trim() } : {}), source_url: sourceUrl });
    }
    return out;
}
