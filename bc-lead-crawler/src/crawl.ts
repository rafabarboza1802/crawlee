import { CheerioCrawler, Configuration, log } from 'crawlee';

import { extractPage, looksLikeChallenge } from './extract.js';
import type { SiteState } from './merge.js';
import { mergeSite, prospectIdFor } from './merge.js';
import type { PageRecord, Prospect, Seed } from './schema.js';

export interface CrawlSettings {
    /** Sent on every request so site owners can see who we are and how to reach us. */
    userAgent: string;
    /** Product token matched against robots.txt `User-agent:` groups. */
    robotsUserAgent: string;
    /** Home page + up to (maxPagesPerSite - 1) contact/about/services pages. */
    maxPagesPerSite: number;
    /** Global request budget across all sites. */
    maxRequestsPerMinute: number;
    /** Minimum gap between two requests to the same domain. */
    sameDomainDelaySecs: number;
    maxConcurrency: number;
}

export const DEFAULT_SETTINGS: CrawlSettings = {
    userAgent: 'BestConstructionBot/0.1 (+https://bestconstruction.pro)',
    robotsUserAgent: 'BestConstructionBot',
    maxPagesPerSite: 8,
    maxRequestsPerMinute: 30,
    sameDomainDelaySecs: 4,
    maxConcurrency: 4,
};

/** Only follow links to pages that typically hold public business contact / profile info. */
const SUBPAGE_PATTERN =
    /\/(?:contact|contact-us|about|about-us|company|who-we-are|team|our-team|leadership|staff|services|what-we-do|properties|communities|portfolio|projects|locations|service-areas?)(?:[/?#.-]|$)/i;
const EXCLUDED_LINKS = [/\.(?:pdf|jpe?g|png|gif|zip|docx?|xlsx?)(?:[?#]|$)/i, /\/(?:login|signin|sign-in|account|portal|wp-admin|cart)(?:[/?#]|$)/i];

/** Status codes that mean "go away" — we record them and never retry or work around them. */
const BLOCKED_STATUS_CODES = new Set([401, 403, 407, 429, 451]);

interface UserData {
    prospectId: string;
}

export async function crawlSites(seeds: Seed[], settings: CrawlSettings = DEFAULT_SETTINGS): Promise<Prospect[]> {
    const sites = new Map<string, SiteState>();
    for (const seed of seeds) {
        const prospectId = prospectIdFor(seed.website);
        if (!sites.has(prospectId)) sites.set(prospectId, { seed, prospectId, pages: [], findings: [], skipped: [] });
    }

    const siteFor = (url: string, userData?: Partial<UserData>): SiteState | undefined => {
        if (userData?.prospectId) return sites.get(userData.prospectId);
        const host = prospectIdFor(url);
        return sites.get(host) ?? [...sites.values()].find((s) => host.endsWith(`.${s.prospectId}`));
    };
    const recordPage = (url: string, userData: UserData, page: Omit<PageRecord, 'url' | 'fetched_at'>) =>
        siteFor(url, userData)?.pages.push({ url, fetched_at: new Date().toISOString(), ...page });

    const crawler = new CheerioCrawler(
        {
            // --- compliance -----------------------------------------------------------------------
            respectRobotsTxtFile: { userAgent: settings.robotsUserAgent },
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
            sameDomainDelaySecs: settings.sameDomainDelaySecs,
            maxConcurrency: settings.maxConcurrency,
            maxCrawlDepth: 1,
            maxRequestsPerCrawl: sites.size * settings.maxPagesPerSite,
            requestHandlerTimeoutSecs: 30,
            navigationTimeoutSecs: 30,

            onSkippedRequest: ({ url, reason }) => {
                siteFor(url)?.skipped.push({ url, reason });
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
                siteFor(url, userData)?.findings.push(extractPage(html, url));

                if (request.label === 'HOME') {
                    await enqueueLinks({
                        strategy: 'same-domain',
                        regexps: [SUBPAGE_PATTERN],
                        exclude: EXCLUDED_LINKS,
                        limit: settings.maxPagesPerSite - 1,
                        label: 'SUBPAGE',
                        userData,
                    });
                }
            },

            failedRequestHandler({ request }, error) {
                recordPage(request.url, request.userData as UserData, { status: 'error', note: error.message.slice(0, 300) });
            },
        },
        // In-memory storage: results are written by main.ts, nothing is persisted under ./storage.
        new Configuration({ persistStorage: false }),
    );

    log.info(`Crawling ${sites.size} site(s)…`);
    await crawler.run(
        [...sites.values()].map((s) => ({
            url: s.seed.website,
            label: 'HOME',
            userData: { prospectId: s.prospectId } satisfies UserData,
        })),
    );

    const crawledAt = new Date();
    return [...sites.values()].map((state) => mergeSite(state, crawledAt));
}
