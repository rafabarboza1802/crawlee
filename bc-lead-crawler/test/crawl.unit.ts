import type { AddressInfo } from 'node:net';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { crawlSites, DEFAULT_SETTINGS } from '../src/crawl.js';
import type { Prospect } from '../src/schema.js';

const page = (body: string) => `<!doctype html><html><head><title>Test Co</title></head><body>${body}</body></html>`;

const ROUTES: Record<string, [number, string]> = {
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
};

let server: Server;
let origin: string;
const requested: { path: string; userAgent?: string }[] = [];

beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
        const path = new URL(req.url!, 'http://x').pathname;
        requested.push({ path, userAgent: req.headers['user-agent'] });
        const [status, body] = ROUTES[path] ?? [404, page('Not found')];
        res.writeHead(status, { 'content-type': path === '/robots.txt' ? 'text/plain' : 'text/html' });
        res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('crawlSites', () => {
    let prospect: Prospect;

    beforeAll(async () => {
        [prospect] = (await crawlSites([{ website: `${origin}/`, segment_hint: 'property_manager', source: 'test' }], {
            ...DEFAULT_SETTINGS,
            sameDomainDelaySecs: 0,
            maxRequestsPerMinute: 600,
        })) as [Prospect];
    });

    test('never requests pages disallowed by robots.txt and records the skip', () => {
        expect(requested.map((r) => r.path)).not.toContain('/team');
        expect(prospect.skipped).toContainEqual({ url: `${origin}/team`, reason: 'robotsTxt' });
        expect(prospect.public_roles).toEqual([]);
    });

    test('only follows contact/about/services-type links', () => {
        const paths = requested.map((r) => r.path);
        expect(paths).not.toContain('/blog/post-1');
        expect(paths).not.toContain('/login');
        expect(paths).not.toContain('/about.pdf');
    });

    test('records 403 as blocked without retrying it', () => {
        expect(requested.filter((r) => r.path === '/services')).toHaveLength(1);
        expect(prospect.pages).toContainEqual(expect.objectContaining({ url: `${origin}/services`, status: 'blocked', http_status: 403 }));
        expect(prospect.crawl_status).toBe('partial');
    });

    test('identifies itself with the configured user agent', () => {
        const pageRequests = requested.filter((r) => r.path !== '/robots.txt');
        expect(pageRequests.length).toBeGreaterThan(0);
        for (const r of pageRequests) expect(r.userAgent).toBe(DEFAULT_SETTINGS.userAgent);
    });

    test('merges findings from all crawled pages into one prospect', () => {
        expect(prospect).toMatchObject({
            prospect_id: 'localhost',
            company_name: 'Test Co',
            company_name_source: 'title',
            segment_hint: 'property_manager',
        });
        expect(prospect.phones.map((p) => p.value)).toEqual(['+15105550100']);
        expect(prospect.phones[0]!.source_url).toBe(`${origin}/contact`);
        expect(prospect.business_emails.map((e) => e.value)).toEqual(['info@test.example']);
        expect(prospect.service_area_mentions.map((e) => e.value)).toEqual(['Berkeley']);
        expect(prospect.signals.map((s) => s.keyword)).toContain('300 units');
    });
});
