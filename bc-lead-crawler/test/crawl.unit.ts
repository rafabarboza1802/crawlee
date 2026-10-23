import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { crawlSites, DEFAULT_SETTINGS, effectiveSameDomainDelaySecs } from '../src/crawl.js';
import type { Prospect } from '../src/schema.js';

const page = (body: string) => `<!doctype html><html><head><title>Test Co</title></head><body>${body}</body></html>`;
const FAST = { ...DEFAULT_SETTINGS, sameDomainDelaySecs: 0, maxRequestsPerMinute: 600 };

interface Hit {
    path: string;
    userAgent?: string;
}

/** Starts a throwaway local website. */
async function startSite(routes: Record<string, [number, string]>) {
    const hits: Hit[] = [];
    const server: Server = createServer((req, res) => {
        const path = new URL(req.url!, 'http://x').pathname;
        hits.push({ path, userAgent: req.headers['user-agent'] });
        const [status, body] = routes[path] ?? [404, page('Not found')];
        res.writeHead(status, { 'content-type': path === '/robots.txt' ? 'text/plain' : 'text/html' });
        res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    return {
        origin,
        hits,
        pageHits: () => hits.filter((h) => h.path !== '/robots.txt'),
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

describe('crawlSites guardrails', () => {
    let site: Awaited<ReturnType<typeof startSite>>;
    let prospect: Prospect;

    beforeAll(async () => {
        site = await startSite({
            '/robots.txt': [200, 'User-agent: *\nDisallow: /team\n'],
            '/': [
                200,
                page(`
                    <a href="/contact">Contact</a>
                    <a href="/team">Our team</a>
                    <a href="/services">Services</a>
                    <a href="/blog/post-1">Blog</a>
                    <a href="/login">Owner portal login</a>
                    <a href="/about.pdf">About (PDF)</a>
                    <p>We manage 300 units in Berkeley.</p>`),
            ],
            '/contact': [200, page('<p>Call (510) 555-0100 or email info@test.example</p>')],
            '/team': [200, page('<p>Director of Construction</p>')],
            '/services': [403, page('Forbidden')],
        });
        [prospect] = (await crawlSites([{ website: `${site.origin}/`, segment_hint: 'property_manager', source: 'test' }], FAST)) as [Prospect];
    });

    afterAll(() => site.close());

    test('never requests pages disallowed by robots.txt and records the skip', () => {
        expect(site.hits.map((r) => r.path)).not.toContain('/team');
        expect(prospect.skipped).toContainEqual({ url: `${site.origin}/team`, reason: 'robotsTxt' });
        expect(prospect.public_roles).toEqual([]);
    });

    test('records each skipped URL once', () => {
        const urls = prospect.skipped.map((s) => s.url);
        expect(urls).toEqual([...new Set(urls)]);
    });

    test('only follows contact/about/services-type links', () => {
        const paths = site.hits.map((r) => r.path);
        expect(paths).not.toContain('/blog/post-1');
        expect(paths).not.toContain('/login');
        expect(paths).not.toContain('/about.pdf');
    });

    test('records 403 as blocked without retrying it', () => {
        expect(site.hits.filter((r) => r.path === '/services')).toHaveLength(1);
        expect(prospect.pages).toContainEqual(expect.objectContaining({ url: `${site.origin}/services`, status: 'blocked', http_status: 403 }));
        expect(prospect.crawl_status).toBe('partial');
    });

    test('identifies itself with the configured user agent', () => {
        expect(site.pageHits().length).toBeGreaterThan(0);
        for (const r of site.hits) expect(r.userAgent).toBe(DEFAULT_SETTINGS.userAgent);
    });

    test('merges findings from all crawled pages into one prospect', () => {
        expect(prospect).toMatchObject({
            prospect_id: 'localhost',
            company_name: 'Test Co',
            company_name_source: 'title',
            segment_hint: 'property_manager',
            segment_group: 'property_management',
        });
        expect(prospect.phones.map((p) => p.value)).toEqual(['+15105550100']);
        expect(prospect.phones[0]!.source_url).toBe(`${site.origin}/contact`);
        expect(prospect.business_emails.map((e) => e.value)).toEqual(['info@test.example']);
        expect(prospect.service_area_mentions.map((e) => e.value)).toEqual(['Berkeley']);
        expect(prospect.signals.map((s) => s.keyword)).toContain('300 units');
    });
});

describe('crawlSites robots.txt edge cases', () => {
    test('treats a robots.txt server error as "disallow everything" (RFC 9309)', async () => {
        const site = await startSite({ '/robots.txt': [503, 'down'], '/': [200, page('<a href="/contact">Contact</a>')] });
        const [p] = await crawlSites([{ website: `${site.origin}/`, segment_hint: 'unknown', source: 'test' }], FAST);
        await site.close();
        expect(site.pageHits()).toEqual([]);
        expect(p!.crawl_status).toBe('robots_unavailable');
    });

    test('treats a missing robots.txt (404) as "allow everything"', async () => {
        const site = await startSite({ '/': [200, page('<a href="/contact">Contact</a>')], '/contact': [200, page('hi')] });
        const [p] = await crawlSites([{ website: `${site.origin}/`, segment_hint: 'unknown', source: 'test' }], FAST);
        await site.close();
        expect(site.pageHits().map((h) => h.path)).toEqual(['/', '/contact']);
        expect(p!.crawl_status).toBe('ok');
    });

    test('crawls only the home page when Crawl-delay is longer than we accept', async () => {
        const site = await startSite({
            '/robots.txt': [200, 'User-agent: *\nCrawl-delay: 60\n'],
            '/': [200, page('<a href="/contact">Contact</a>')],
            '/contact': [200, page('c')],
        });
        const [p] = await crawlSites([{ website: `${site.origin}/`, segment_hint: 'unknown', source: 'test' }], FAST);
        await site.close();
        expect(site.pageHits().map((h) => h.path)).toEqual(['/']);
        expect(p!.skipped).toContainEqual({ url: `${site.origin}/robots.txt`, reason: 'crawlDelayTooLong' });
    });
});

describe('effectiveSameDomainDelaySecs', () => {
    const settings = { ...DEFAULT_SETTINGS, sameDomainDelaySecs: 4, maxCrawlDelaySecs: 20 };

    test('raises the per-domain delay to the strictest accepted Crawl-delay', () => {
        expect(effectiveSameDomainDelaySecs(settings, [undefined, 2, 10])).toBe(10);
    });

    test('never goes below the configured delay and ignores Crawl-delays we do not accept', () => {
        expect(effectiveSameDomainDelaySecs(settings, [])).toBe(4);
        expect(effectiveSameDomainDelaySecs(settings, [1, 60])).toBe(4);
    });
});
