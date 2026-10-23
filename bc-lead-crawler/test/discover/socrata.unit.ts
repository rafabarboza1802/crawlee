import { describe, expect, test } from 'vitest';

import { SchemaError, SocrataClient, SourceAccessError } from '../../src/discover/sources/socrata.js';
import type { SourceContext } from '../../src/discover/sources/source.js';
import { startFakeSocrata } from './fake-socrata.js';

const ctx = (baseUrl: string): SourceContext => ({ userAgent: 'BestConstructionBot/test', robotsToken: 'BestConstructionBot', baseUrl, log: () => {} });
const rows = Array.from({ length: 25 }, (_, i) => ({ permit_number: String(i) }));

describe('SocrataClient', () => {
    test('paginates with $limit/$offset and stops at maxRows', async () => {
        const site = await startFakeSocrata({ datasets: { ds: rows } });
        const client = new SocrataClient(site.baseUrl, ctx(site.baseUrl), { pageSize: 10, pageDelayMs: 0 });
        expect(await client.query('ds', {})).toHaveLength(25);
        expect(await client.query('ds', {}, 12)).toHaveLength(12);
        const offsets = site.requests.filter((r) => r.path === '/resource/ds.json').map((r) => r.params.get('$offset'));
        expect(offsets).toEqual(['0', '10', '20', '0', '10']);
        await site.close();
    });

    test('refuses to query when robots.txt disallows the API or cannot be read', async () => {
        const blocked = await startFakeSocrata({ datasets: { ds: rows }, robots: [200, 'User-agent: *\nDisallow: /resource/\n'] });
        await expect(new SocrataClient(blocked.baseUrl, ctx(blocked.baseUrl)).query('ds', {})).rejects.toThrow(SourceAccessError);
        expect(blocked.requests.some((r) => r.path.startsWith('/resource'))).toBe(false);
        await blocked.close();

        const down = await startFakeSocrata({ datasets: { ds: rows }, robots: [503, 'down'] });
        await expect(new SocrataClient(down.baseUrl, ctx(down.baseUrl)).query('ds', {})).rejects.toThrow(/robots\.txt returned HTTP 503/);
        await down.close();
    });

    test('backs off on 429 using Retry-After, then succeeds', async () => {
        const site = await startFakeSocrata({ datasets: { ds: rows.slice(0, 3) }, failFirst: [{ status: 429, retryAfter: '1' }] });
        const started = Date.now();
        expect(await new SocrataClient(site.baseUrl, ctx(site.baseUrl), { pageDelayMs: 0 }).query('ds', {})).toHaveLength(3);
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
        await site.close();
    });

    test('reports unknown columns as a schema error and 403 as access denied (no retry)', async () => {
        const schema = await startFakeSocrata({ datasets: { ds: rows }, failFirst: [{ status: 400, body: '{"errorCode":"query.soql.no-such-column","message":"No such column: firm_name"}' }] });
        await expect(new SocrataClient(schema.baseUrl, ctx(schema.baseUrl)).query('ds', {})).rejects.toThrow(SchemaError);
        await schema.close();

        const denied = await startFakeSocrata({ datasets: { ds: rows }, failFirst: [{ status: 403 }, { status: 403 }] });
        await expect(new SocrataClient(denied.baseUrl, ctx(denied.baseUrl)).query('ds', {})).rejects.toThrow(SourceAccessError);
        expect(denied.requests.filter((r) => r.path === '/resource/ds.json')).toHaveLength(1);
        await denied.close();
    });

    test('lists columns from dataset metadata without downloading rows', async () => {
        const site = await startFakeSocrata({ datasets: {}, columns: { ds: ['permit_number', 'firm_name', ':id'] } });
        expect(await new SocrataClient(site.baseUrl, ctx(site.baseUrl)).columns('ds')).toEqual(['permit_number', 'firm_name']);
        expect(site.requests.some((r) => r.path.startsWith('/resource'))).toBe(false);
        await site.close();
    });
});
