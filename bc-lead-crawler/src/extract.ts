import type { CheerioAPI } from 'cheerio';
import { load } from 'cheerio';

import type { Address, Evidence, Signal, SignalCategory } from './schema.js';
import {
    GENERIC_MAILBOXES,
    PORTFOLIO_SCALE_PATTERNS,
    PUBLIC_ROLE_TITLES,
    SERVICE_AREA_PLACES,
    SIGNAL_KEYWORDS,
} from './vocabulary.js';

/** Everything extracted from a single page. Merged into one prospect per site in `merge.ts`. */
export interface PageFindings {
    url: string;
    companyName?: { value: string; source: 'json_ld' | 'og_site_name' | 'title' };
    phones: Evidence[];
    businessEmails: Evidence[];
    contactPageUrls: string[];
    address?: Address;
    serviceAreaMentions: Evidence[];
    publicRoles: Evidence[];
    socialProfiles: Evidence[];
    signals: Signal[];
}

const SNIPPET_RADIUS = 80;
const MAX_SIGNALS_PER_PAGE = 25;

const CAPTCHA_MARKERS = [
    /g-recaptcha/i,
    /h-captcha|hcaptcha\.com/i,
    /cf-challenge|challenges\.cloudflare\.com/i,
    /<title>\s*(?:Just a moment|Attention Required)/i,
];

/** True when the page is a CAPTCHA / bot challenge. We never try to solve or bypass these. */
export function looksLikeChallenge(html: string): boolean {
    return CAPTCHA_MARKERS.some((re) => re.test(html));
}

export function extractPage(html: string, url: string): PageFindings {
    const $ = load(html);
    const jsonLd = readJsonLdOrganizations($);
    const links = $('a[href]')
        .toArray()
        .map((el) => ({ href: $(el).attr('href')!.trim(), text: $(el).text().replace(/\s+/g, ' ').trim() }));

    // Visible text only.
    const $body = $('body').clone();
    $body.find('script, style, noscript, template, svg').remove();
    const text = $body.text().replace(/\s+/g, ' ').trim();

    const ev = (value: string): Evidence => ({ value, source_url: url });

    return {
        url,
        companyName: readCompanyName($, jsonLd),
        phones: uniqueEvidence(
            [
                ...links.filter((l) => /^tel:/i.test(l.href)).map((l) => normalizePhone(decodeSafe(l.href.slice(4)))),
                ...jsonLd.map((o) => (typeof o.telephone === 'string' ? normalizePhone(o.telephone) : undefined)),
                ...phonesFromText(text),
            ]
                .filter((p): p is string => !!p)
                .map(ev),
        ),
        businessEmails: uniqueEvidence(
            [
                ...links.filter((l) => /^mailto:/i.test(l.href)).map((l) => decodeSafe(l.href.slice(7).split('?')[0]!)),
                ...jsonLd.map((o) => (typeof o.email === 'string' ? o.email.replace(/^mailto:/i, '') : undefined)),
                ...(text.match(EMAIL_RE) ?? []),
            ]
                .filter((e): e is string => !!e)
                .map((e) => e.toLowerCase())
                .filter(isGenericBusinessEmail)
                .map(ev),
        ),
        contactPageUrls: unique(
            links
                .filter((l) => /contact|get in touch|request (?:a )?(?:quote|proposal|bid)/i.test(`${l.href} ${l.text}`))
                .map((l) => absolutize(l.href, url))
                .filter((u): u is string => !!u && /^https?:/.test(u)),
        ),
        address: readAddress(jsonLd, url),
        serviceAreaMentions: uniqueEvidence(
            SERVICE_AREA_PLACES.filter((place) => wordRegex(place, true).test(text)).map(ev),
        ),
        publicRoles: uniqueEvidence(PUBLIC_ROLE_TITLES.filter((title) => wordRegex(title, true).test(text)).map(ev)),
        socialProfiles: uniqueEvidence(
            links
                .map((l) => absolutize(l.href, url))
                .filter((u): u is string => !!u && SOCIAL_RE.test(u))
                .map((u) => ev(u.replace(/\/+$/, ''))),
        ),
        signals: findSignals(text, url),
    };
}

// --- company name ---------------------------------------------------------------------------------

function readCompanyName($: CheerioAPI, jsonLd: JsonLdObject[]): PageFindings['companyName'] {
    const fromJsonLd = jsonLd.find((o) => typeof o.name === 'string' && o.name.trim())?.name as string | undefined;
    if (fromJsonLd) return { value: fromJsonLd.trim(), source: 'json_ld' };

    const ogSiteName = $('meta[property="og:site_name"]').attr('content')?.trim();
    if (ogSiteName) return { value: ogSiteName, source: 'og_site_name' };

    // "Acme Property Management | Oakland Apartments" -> "Acme Property Management"
    const title = $('title').first().text().split(/\s[|–—-]\s/)[0]?.trim();
    if (title) return { value: title, source: 'title' };

    return undefined;
}

// --- JSON-LD --------------------------------------------------------------------------------------

type JsonLdObject = Record<string, unknown>;

const NON_ORG_TYPES = new Set([
    'WebSite',
    'WebPage',
    'BreadcrumbList',
    'ListItem',
    'ImageObject',
    'SearchAction',
    'Article',
    'BlogPosting',
    'FAQPage',
    'Question',
    'Answer',
    'Person',
    'Offer',
    'Product',
]);

function readJsonLdOrganizations($: CheerioAPI): JsonLdObject[] {
    const out: JsonLdObject[] = [];
    const visit = (node: unknown) => {
        if (Array.isArray(node)) return node.forEach(visit);
        if (!node || typeof node !== 'object') return;
        const obj = node as JsonLdObject;
        if (obj['@graph']) visit(obj['@graph']);
        const types = ([] as unknown[]).concat(obj['@type'] ?? []).map(String);
        if (types.length && !types.every((t) => NON_ORG_TYPES.has(t)) && (obj.name || obj.telephone || obj.address)) {
            out.push(obj);
        }
    };
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            visit(JSON.parse($(el).text()));
        } catch {
            // Malformed JSON-LD is common; ignore it.
        }
    });
    return out;
}

function readAddress(jsonLd: JsonLdObject[], url: string): Address | undefined {
    for (const org of jsonLd) {
        const raw = ([] as unknown[]).concat(org.address ?? [])[0];
        if (!raw || typeof raw !== 'object') continue;
        const a = raw as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
        const address: Address = {
            street: str(a.streetAddress),
            city: str(a.addressLocality),
            region: str(a.addressRegion),
            postal_code: str(a.postalCode),
            source_url: url,
        };
        if (address.street || address.city) return address;
    }
    return undefined;
}

// --- phones & emails ------------------------------------------------------------------------------

const PHONE_RE = /(?<![\d-])(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?![\d-])/g;

function phonesFromText(text: string): string[] {
    return [...text.matchAll(PHONE_RE)].map((m) => `+1${m[1]}${m[2]}${m[3]}`);
}

/** Normalizes a US phone number to E.164 (+1XXXXXXXXXX); returns undefined for anything else. */
export function normalizePhone(raw: string): string | undefined {
    const digits = raw.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits) ? `+1${digits}` : undefined;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.(?!png|jpe?g|gif|webp|svg)[a-z]{2,}/gi;

export function isGenericBusinessEmail(email: string): boolean {
    const [local, domain] = email.split('@');
    if (!local || !domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return false;
    const normalized = local.replace(/[._-]/g, '');
    return (GENERIC_MAILBOXES as readonly string[]).includes(normalized);
}

// --- signals --------------------------------------------------------------------------------------

function findSignals(text: string, url: string): Signal[] {
    const signals: Signal[] = [];
    for (const [category, keywords] of Object.entries(SIGNAL_KEYWORDS) as [SignalCategory, readonly string[]][]) {
        for (const keyword of keywords) {
            // Acronyms such as "HOA"/"HOAs" are matched case-sensitively to avoid noise.
            const match = wordRegex(keyword, /^[A-Z]{2,}s?$/.test(keyword)).exec(text);
            if (match) signals.push({ category, keyword, snippet: snippetAround(text, match.index, keyword.length), source_url: url });
        }
    }
    for (const re of PORTFOLIO_SCALE_PATTERNS) {
        const match = re.exec(text);
        if (match) {
            signals.push({
                category: 'portfolio',
                keyword: match[0],
                snippet: snippetAround(text, match.index, match[0].length),
                source_url: url,
            });
        }
    }
    return signals.slice(0, MAX_SIGNALS_PER_PAGE);
}

function snippetAround(text: string, index: number, length: number): string {
    const start = Math.max(0, index - SNIPPET_RADIUS);
    const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

// --- helpers --------------------------------------------------------------------------------------

const SOCIAL_RE = /^https?:\/\/(?:www\.)?(?:linkedin\.com\/company|facebook\.com|instagram\.com|youtube\.com|x\.com|twitter\.com)\/[^?#]+/i;

function wordRegex(phrase: string, caseSensitive: boolean): RegExp {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, caseSensitive ? '' : 'i');
}

function absolutize(href: string, base: string): string | undefined {
    try {
        return new URL(href, base).href;
    } catch {
        return undefined;
    }
}

function decodeSafe(s: string): string {
    try {
        return decodeURIComponent(s).trim();
    } catch {
        return s.trim();
    }
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

export function uniqueEvidence(items: Evidence[]): Evidence[] {
    const seen = new Set<string>();
    return items.filter((e) => (seen.has(e.value) ? false : (seen.add(e.value), true)));
}
