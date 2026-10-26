import { guardedFetch } from './linkedin.js';

export class ApolloAuthError extends Error {}

export interface ApolloOrg {
    id: string;
    name: string;
    website?: string;
    domain?: string;
    phone?: string;
    linkedinUrl?: string;
    state?: string;
    city?: string;
}

export interface ApolloPerson {
    id: string;
    name: string;
    title?: string;
    linkedinUrl?: string;
    city?: string;
    state?: string;
    email?: string;
    emailStatus?: string;
    /** From the free people search: whether Apollo holds an email for this person (false = never pay for them). */
    hasEmail?: boolean;
}

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal Apollo REST client. The key is read from APOLLO_API_KEY and sent only in the `x-api-key` header (Apollo's
 * documented method); it is never logged or written to disk. All requests go through the LinkedIn guard.
 */
export class ApolloClient {
    constructor(
        private readonly apiKey: string,
        private readonly baseUrl = 'https://api.apollo.io/api/v1',
        private readonly maxAttempts = 3,
    ) {}

    async post(path: string, body: Json): Promise<{ status: number; json: Json }> {
        for (let attempt = 1; ; attempt++) {
            const response = await guardedFetch(`${this.baseUrl}/${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': this.apiKey },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });
            if (response.status === 401 || response.status === 403) {
                throw new ApolloAuthError(`Apollo refused the API key (HTTP ${response.status}) on ${path}; stopping. Check the key and that your plan allows this endpoint.`);
            }
            if (response.status === 429 && attempt < this.maxAttempts) {
                const retryAfter = Number(response.headers.get('retry-after'));
                await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * attempt);
                continue;
            }
            const json = (await response.json().catch(() => ({}))) as Json;
            if (!response.ok) throw new Error(`Apollo HTTP ${response.status} on ${path}: ${JSON.stringify(json).slice(0, 300)}`);
            return { status: response.status, json };
        }
    }
}

export function parseOrganizations(json: Json): ApolloOrg[] {
    const list = [...((json.organizations as Json[] | undefined) ?? []), ...((json.accounts as Json[] | undefined) ?? [])];
    return list
        .map((o) => {
            const phone = o.primary_phone as Json | undefined;
            return {
                id: str(o.organization_id) ?? str(o.id) ?? '',
                name: str(o.name) ?? '',
                website: str(o.website_url),
                domain: str(o.primary_domain) ?? str(o.domain),
                phone: str(phone?.sanitized_number) ?? str(phone?.number) ?? str(o.sanitized_phone) ?? str(o.phone),
                linkedinUrl: str(o.linkedin_url),
                state: str(o.state) ?? str(o.organization_state),
                city: str(o.city) ?? str(o.organization_city),
            };
        })
        .filter((o) => o.id && o.name);
}

function parsePersonJson(p: Json): ApolloPerson | undefined {
    const id = str(p.id);
    const name = str(p.name) ?? [str(p.first_name), str(p.last_name) ?? str(p.last_name_obfuscated)].filter(Boolean).join(' ');
    if (!id || !name) return undefined;
    return {
        id,
        name,
        title: str(p.title),
        linkedinUrl: str(p.linkedin_url),
        city: str(p.city),
        state: str(p.state),
        email: str(p.email),
        emailStatus: str(p.email_status),
        ...(typeof p.has_email === 'boolean' ? { hasEmail: p.has_email } : {}),
    };
}

export function parsePeople(json: Json): ApolloPerson[] {
    return ((json.people as Json[] | undefined) ?? []).map(parsePersonJson).filter((p): p is ApolloPerson => !!p);
}

export function parseMatchedPerson(json: Json): ApolloPerson | undefined {
    return json.person ? parsePersonJson(json.person as Json) : undefined;
}

const LEGAL = /\b(?:inc|incorporated|llc|co|corp|corporation|company|ltd|lp|llp|the|and)\b/g;
const SYNONYMS: Record<string, string> = { bros: 'brothers', constr: 'construction', const: 'construction', contractor: 'contractors', builder: 'builders', gc: 'contractors' };
const tokens = (s: string) =>
    new Set(
        s
            .toLowerCase()
            .replace(/&/g, ' and ')
            .replace(/[^a-z0-9 ]+/g, ' ')
            .replace(LEGAL, ' ')
            .split(/\s+/)
            .filter(Boolean)
            .map((t) => SYNONYMS[t] ?? t),
    );

/**
 * Similarity of two company names (0–1): Dice over name tokens, ignoring legal suffixes and common abbreviations.
 * When one name is the other plus descriptive words ("Nibbi Brothers" / "Nibbi Brothers General Contractors") and the
 * shorter has at least two words, it counts as 0.9.
 */
export function nameSimilarity(a: string, b: string): number {
    const ta = tokens(a);
    const tb = tokens(b);
    if (!ta.size || !tb.size) return 0;
    const shared = [...ta].filter((t) => tb.has(t)).length;
    const dice = (2 * shared) / (ta.size + tb.size);
    const smaller = Math.min(ta.size, tb.size);
    return smaller >= 2 && shared === smaller ? Math.max(dice, 0.9) : dice;
}

/** "https://www.cahill-sf.com/about" → "cahill-sf.com" */
export function domainFromUrl(url: string | undefined): string | undefined {
    const host = url?.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#:]/)[0]?.replace(/^www\./, '');
    return host && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : undefined;
}

const FREE_MAIL = /@(?:gmail|yahoo|hotmail|outlook|aol|icloud|me|comcast|sbcglobal|att|msn|live|protonmail)\./i;

/** A business email only: verified by Apollo and not on a consumer mail domain. */
export function isVerifiedBusinessEmail(person: ApolloPerson): boolean {
    return !!person.email && person.emailStatus === 'verified' && !FREE_MAIL.test(person.email);
}
