import { CheerioCrawler, Configuration, log } from 'crawlee';

import { extractPage, looksLikeChallenge } from './extract.js';
import type { SiteState } from './merge.js';
import { mergeSite, prospectIdFor } from './merge.js';
import type { RobotsPolicy } from './robots.js';
import { fetchRobotsPolicy } from './robots.js';
import type { PageRecord, Prospect, Seed } from './schema.js';

export interface CrawlSettings {
    /** Sent on every request (pages and robots.txt) so site owners can see who we are and how to reach us. */
    userAgent: string;
    /** Product token matched against robots.txt `User-agent:` groups. */
    robotsUserAgent: string;
    /** Home page + up to (maxPagesPerSite - 1) contact/about/services pages. */
    maxPagesPerSite: number;
    /** Global request budget across all sites. */
    maxRequestsPerMinute: number;
    /** Minimum gap between two requests to the same domain. Raised automatically to honor robots.txt Crawl-delay. */
    sameDomainDelaySecs: number;
    /** Sites asking for a longer Crawl-delay than this get only their home page crawled. */
    maxCrawlDelaySecs: number;
    maxConcurrency: number;
}

export const DEFAULT_SETTINGS: CrawlSettings = {
    userAgent: 'BestConstructionBot/0.1 (+https://bestconstruction.pro)',
    robotsUserAgent: 'BestConstructionBot',
    maxPagesPerSite: 8,
    maxRequestsPerMinute: 30,
    sameDomainDelaySecs: 4,
    maxCrawlDelaySecs: 20,
    maxConcurrency: 4,
};

/** Only follow links to pages that typically hold public business contact / profile info for our segments. */
export const SUBPAGE_PATTERN = new RegExp(
    `/(?:${[
        // all segments
        'contact',
        'contact-us',
        'about',
        'about-us',
        'company',
        'who-we-are',
        'team',
        'our-team',
        'leadership',
        'staff',
        'services',
        'what-we-do',
        'locations',
        'service-areas?',
        // property management / HOA / multifamily, commercial real estate
        'properties',
        'communities',
        'portfolio',
        'leasing',
        'listings',
        // general contractors
        'projects',
        'subcontractors',
        'trade-partners',
        'prequalification',
        // developers / home builders
        'developments',
        'new-homes',
        // public construction
        'bids',
        'bid-opportunities',
        'rfps?',
        'procurement',
        'purchasing',
        'public-works',
        'capital-projects',
        // residential
        'outdoor-living',
    ].join('|')})(?:[/?#.-]|$)`,
    'i',
);
const EXCLUDED_LINKS = [/\.(?:pdf|jpe?g|png|gif|zip|docx?|xlsx?)(?:[?#]|$)/i, /\/(?:login|signin|sign-in|account|portal|wp-admin|cart)(?:[/?#]|$)/i];

/** Status codes that mean "go away" — we record them and never retry or work around them. */
const BLOCKED_STATUS_CODES = new Set([401, 403, 407, 429, 451]);

interface UserData {
    prospectId: string;
}

/**
 * Crawlee's per-domain delay is a single value, so use the strictest robots.txt Crawl-delay we accept.
 * Note: Crawlee applies it per registrable domain (e.g. acme.com); hosts without one (IPs, localhost) are not delayed.
 */
export function effectiveSameDomainDelaySecs(settings: CrawlSettings, crawlDelays: (number | undefined)[]): number {
    const accepted = crawlDelays.filter((d): d is number => d !== undefined && d <= settings.maxCrawlDelaySecs);
    return Math.max(settings.sameDomainDelaySecs, ...accepted);
}

export async function crawlSites(seeds: Seed[], settings: CrawlSettings = DEFAULT_SETTINGS): Promise<Prospect[]> {
    const sites = new Map<string, SiteState>();
    for (const seed of seeds) {
        const prospectId = prospectIdFor(seed.website);
        if (!sites.has(prospectId)) sites.set(prospectId, { seed, prospectId, pages: [], findings: [], skipped: [] });
    }

    // robots.txt is fetched by us (with our User-Agent) rather than by Crawlee, so that RFC 9309 semantics apply:
    // 5xx/unreachable means "disallow everything", and Crawl-delay is honored.
    const robotsByOrigin = new Map<string, Promise<RobotsPolicy>>();
    const robotsFor = (url: string) => {
        const origin = new URL(url).origin;
        if (!robotsByOrigin.has(origin)) {
            robotsByOrigin.set(origin, fetchRobotsPolicy(url, { userAgent: settings.userAgent, robotsToken: settings.robotsUserAgent }));
        }
        return robotsByOrigin.get(origin)!;
    };

    const siteFor = (url: string, userData?: Partial<UserData>): SiteState | undefined => {
        if (userData?.prospectId) return sites.get(userData.prospectId);
        const host = prospectIdFor(url);
        return sites.get(host) ?? [...sites.values()].find((s) => host.endsWith(`.${s.prospectId}`));
    };
    const recordPage = (url: string, userData: UserData, page: Omit<PageRecord, 'url' | 'fetched_at'>) =>
        siteFor(url, userData)?.pages.push({ url, fetched_at: new Date().toISOString(), ...page });

    // Pre-flight: check each home page against robots.txt before anything is fetched.
    const startUrls: string[] = [];
    const crawlDelays: (number | undefined)[] = [];
    await Promise.all(
        [...sites.values()].map(async (site) => {
            const home = site.seed.website;
            const policy = await robotsFor(home);
            if (policy.status === 'unavailable') {
                site.skipped.push({ url: policy.robotsUrl, reason: 'robotsUnavailable' });
            } else if (!policy.isAllowed(home)) {
                site.skipped.push({ url: home, reason: 'robotsTxt' });
            } else {
                startUrls.push(home);
                crawlDelays.push(policy.crawlDelaySecs);
            }
        }),
    );
    const sameDomainDelaySecs = effectiveSameDomainDelaySecs(settings, crawlDelays);

    const crawler = new CheerioCrawler(
        {
            // --- compliance -----------------------------------------------------------------------
            // robots.txt is enforced above and in `transformRequestFunction` below.
            respectRobotsTxtFile: false,
            // No session rotation, cookie persistence, proxies or retry-on-block: a block is final.
            useSessionPool: false,
            persistCookiesPerSession: false,
            retryOnBlocked: false,
            maxRequestRetries: 1,
            // Let the handler see 4xx responses so they can be recorded instead of thrown.
            ignoreHttpErrorStatusCodes: [...BLOCKED_STATUS_CODES],
            preNavigationHooks: [
                (_ctx, gotOptions) => {
                    // Identify honestly instead of sending generated browser fingerprint headers.
                    gotOptions.useHeaderGenerator = false;
                    gotOptions.headers = { ...gotOptions.headers, 'user-agent': settings.userAgent };
                },
            ],
            // --- politeness -----------------------------------------------------------------------
            maxRequestsPerMinute: settings.maxRequestsPerMinute,
            sameDomainDelaySecs,
            maxConcurrency: settings.maxConcurrency,
            maxCrawlDepth: 1,
            maxRequestsPerCrawl: sites.size * settings.maxPagesPerSite,
            requestHandlerTimeoutSecs: 60,
            navigationTimeoutSecs: 30,

            onSkippedRequest: ({ url, reason }) => {
                // URLs we reject ourselves (robots.txt) are also reported by Crawlee as "filters"; keep the first reason.
                const site = siteFor(url);
                if (site && !site.skipped.some((s) => s.url === url)) site.skipped.push({ url, reason });
            },

            async requestHandler({ request, response, body, enqueueLinks }) {
                const userData = request.userData as UserData;
                const url = request.loadedUrl ?? request.url;
                const status = response.statusCode ?? 0;
                const html = body.toString();

                if (BLOCKED_STATUS_CODES.has(status) || looksLikeChallenge(html)) {
                    recordPage(url, userData, { status: 'blocked', http_status: status, note: 'Blocked or bot challenge; not retried.' });
                    return;
                }
                if (status >= 400) {
                    recordPage(url, userData, { status: 'not_found', http_status: status });
                    return;
                }

                recordPage(url, userData, { status: 'ok', http_status: status });
                const site = siteFor(url, userData);
                site?.findings.push(extractPage(html, url));

                if (request.label !== 'HOME' || !site) return;

                // The home page may have redirected to another host (e.g. www.), which has its own robots.txt.
                const policy = await robotsFor(url);
                if (policy.status === 'unavailable') {
                    site.skipped.push({ url: policy.robotsUrl, reason: 'robotsUnavailable' });
                    return;
                }
                if ((policy.crawlDelaySecs ?? 0) > sameDomainDelaySecs) {
                    site.skipped.push({ url: policy.robotsUrl, reason: 'crawlDelayTooLong' });
                    return;
                }

                await enqueueLinks({
                    // Same host only: subdomains are often resident/owner portals.
                    strategy: 'same-hostname',
                    regexps: [SUBPAGE_PATTERN],
                    exclude: EXCLUDED_LINKS,
                    limit: settings.maxPagesPerSite - 1,
                    label: 'SUBPAGE',
                    userData,
                    transformRequestFunction: (req) => {
                        if (policy.isAllowed(req.url)) return req;
                        site.skipped.push({ url: req.url, reason: 'robotsTxt' });
                        return false;
                    },
                });
            },

            failedRequestHandler({ request }, error) {
                recordPage(request.url, request.userData as UserData, { status: 'error', note: error.message.slice(0, 300) });
            },
        },
        // In-memory storage: results are written by main.ts, nothing is persisted under ./storage.
        new Configuration({ persistStorage: false }),
    );

    log.info(`Crawling ${startUrls.length} of ${sites.size} site(s) (per-domain delay ${sameDomainDelaySecs}s)…`);
    if (startUrls.length > 0) {
        await crawler.run(startUrls.map((url) => ({ url, label: 'HOME', userData: { prospectId: prospectIdFor(url) } satisfies UserData })));
    }

    const crawledAt = new Date();
    return [...sites.values()].map((state) => mergeSite(state, crawledAt));
}
