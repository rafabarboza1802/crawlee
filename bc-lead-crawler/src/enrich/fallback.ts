import { extractPage, looksLikeChallenge } from '../extract.js';
import { fetchRobotsPolicy } from '../robots.js';
import { domainFromUrl } from './apollo.js';

/**
 * Free fallback when Apollo finds no verified decision maker: the company's own public website, read politely
 * (robots.txt obeyed, honest User-Agent, home page plus up to three contact pages, no forms, no logins). Only mailboxes
 * published by the company on its own domain are kept; bid/estimating/procurement mailboxes are the ones meant for
 * subcontractors and are the only ones used for outreach.
 */
export const BID_MAILBOXES = ['bids', 'bidding', 'bid', 'estimating', 'estimates', 'estimate', 'precon', 'preconstruction', 'procurement', 'purchasing', 'subcontractors', 'subs', 'prequal', 'prequalification'];

export interface PublishedContact {
    email: string;
    /** "bid": bid/estimating/procurement mailbox (usable for outreach); "general": info@/contact@ (reference only). */
    kind: 'bid' | 'general';
    sourceUrl: string;
}

export interface PublicCompanyInfo {
    website: string;
    emails: PublishedContact[];
    phones: string[];
    pagesChecked: number;
    note?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function publicCompanyContacts(
    website: string,
    ctx: { userAgent: string; robotsToken: string },
    options: { fetch?: typeof fetch; delayMs?: number; maxPages?: number; domain?: string } = {},
): Promise<PublicCompanyInfo> {
    const doFetch = options.fetch ?? fetch;
    const domain = options.domain ?? domainFromUrl(website);
    const home = new URL(/^https?:/i.test(website) ? website : `https://${website}`);
    const out: PublicCompanyInfo = { website: home.href, emails: [], phones: [], pagesChecked: 0 };
    if (!domain) return { ...out, note: 'No usable website' };

    const robots = await fetchRobotsPolicy(home.origin, ctx);
    if (robots.status !== 'ok') return { ...out, note: `Website skipped: ${robots.reason}` };

    const queue = [home.href, new URL('/contact', home).href, new URL('/contact-us', home).href];
    const seen = new Set<string>();
    while (queue.length && out.pagesChecked < (options.maxPages ?? 4)) {
        const url = queue.shift()!;
        if (seen.has(url) || !robots.isAllowed(url)) continue;
        seen.add(url);
        if (out.pagesChecked > 0) await sleep(options.delayMs ?? 1500);
        let html: string;
        try {
            const res = await doFetch(url, { headers: { 'user-agent': ctx.userAgent, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
            out.pagesChecked++;
            if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) continue;
            html = await res.text();
        } catch {
            continue;
        }
        // A bot challenge means the site does not want automated visits: stop, never work around it.
        if (looksLikeChallenge(html)) return { ...out, note: 'Website shows a bot challenge; stopped' };
        const page = extractPage(html, url);
        for (const e of page.businessEmails) {
            const email = e.value.toLowerCase();
            if (!(email.split('@')[1] ?? '').endsWith(domain) || out.emails.some((x) => x.email === email)) continue;
            const local = email.split('@')[0]!.replace(/[._-]/g, '');
            out.emails.push({ email, kind: BID_MAILBOXES.includes(local) ? 'bid' : 'general', sourceUrl: url });
        }
        for (const p of page.phones) if (!out.phones.includes(p.value)) out.phones.push(p.value);
        for (const c of page.contactPageUrls.slice(0, 3)) if (new URL(c).origin === home.origin) queue.push(c);
    }
    return out;
}
