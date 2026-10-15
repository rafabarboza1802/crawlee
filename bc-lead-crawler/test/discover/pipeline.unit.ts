import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { DEFAULT_SETTINGS } from '../../src/crawl.js';
import { discover, type DiscoverResult } from '../../src/discover/discover.js';
import { SF_SOURCE } from '../../src/discover/sources/sf.js';
import type { SourceContext } from '../../src/discover/sources/source.js';
import { updateState } from '../../src/discover/state.js';
import type { Opportunity } from '../../src/discover/types.js';
import { startFakeSocrata } from './fake-socrata.js';
import { NOW, SF_CONTACT_ROWS, SF_PERMIT_ROWS } from './fixtures/sf.js';

let site: Awaited<ReturnType<typeof startFakeSocrata>>;
let ctx: SourceContext;
let result: DiscoverResult;
const byPermit = (n: string) => result.opportunities.find((o) => o.permit.number === n || o.related_permits.some((r) => r.permit_number === n));

beforeAll(async () => {
    site = await startFakeSocrata({ datasets: { 'i98e-djp9': SF_PERMIT_ROWS, '3pee-9qhc': SF_CONTACT_ROWS } });
    ctx = { userAgent: DEFAULT_SETTINGS.userAgent, robotsToken: 'BestConstructionBot', appToken: 'test-token', baseUrl: site.baseUrl, log: () => {} };
    result = await discover({ source: SF_SOURCE, ctx, days: 30, now: NOW, minScore: 0 });
});

afterAll(() => site.close());

describe('SF discovery pipeline (fake DataSF server)', () => {
    test('queries the permits dataset for the look-back window, identifying itself', () => {
        const permitQuery = site.requests.find((r) => r.path === '/resource/i98e-djp9.json')!;
        expect(permitQuery.params.get('$where')).toBe("filed_date >= '2026-09-15T12:00:00' OR status_date >= '2026-09-15T12:00:00'");
        expect(permitQuery.headers['user-agent']).toBe(DEFAULT_SETTINGS.userAgent);
        expect(permitQuery.headers['x-app-token']).toBe('test-token');
        expect(site.requests[0]!.path).toBe('/robots.txt');
    });

    test('requests only firm/role/license contact fields, never personal names', () => {
        const contactQueries = site.requests.filter((r) => r.path === '/resource/3pee-9qhc.json');
        expect(contactQueries.length).toBeGreaterThan(0);
        for (const q of contactQueries) expect(q.params.get('$select')).toBe('permit_number,role,firm_name,license1');
    });

    test('drops duplicates, inactive permits, other trades and sign permits', () => {
        expect(result.stats).toMatchObject({ fetched: 12, duplicates: 1, inactive: 1, relevant: 7 });
        expect(result.stats.excluded).toEqual({ 'no Best Construction service mentioned': 1, 'other trade': 1, 'sign permit': 1 });
        for (const n of ['202610010008', '202610010009', '202610010010', '202610010011']) expect(byPermit(n)).toBeUndefined();
    });

    test('groups the demolition and new-building permits on the same parcel into one developer opportunity', () => {
        const o = byPermit('202610010001')!;
        expect(o.opportunity_id).toBe('sf-dbi:9901/001');
        expect([o.permit.number, ...o.related_permits.map((r) => r.permit_number)].sort()).toEqual(['202610010001', '202610010002']);
        expect(o.lead_segment).toBe('developer_home_builder');
        expect(o.services.map((s) => s.service)).toEqual(
            expect.arrayContaining(['demolition', 'hauling_debris', 'excavation', 'retaining_walls', 'general_construction', 'site_work']),
        );
        expect(o.estimated_value).toBe(2_650_000);
        expect(o.value_basis).toBe('revised_cost');
        expect(o.businesses.map((b) => `${b.role}:${b.name}`)).toEqual(
            expect.arrayContaining(['contractor:Example Builders Inc', 'owner_business:9001 Example Street LLC', 'architect:Sample Design Studio']),
        );
        expect(o.score_band).toBe('high');
        expect(o.score_reasons).toContainEqual(expect.objectContaining({ factor: 'adjustment', detail: '2 related permits on this property' }));
    });

    test('classifies each lead segment', () => {
        expect(byPermit('202610010003')!.lead_segment).toBe('property_management');
        expect(byPermit('202610010004')!.lead_segment).toBe('commercial_real_estate');
        expect(byPermit('202610010005')!.lead_segment).toBe('general_contractor');
        expect(byPermit('202610010006')!.lead_segment).toBe('residential');
        expect(byPermit('202610010007')!.lead_segment).toBe('public_construction');
    });

    test('never targets homeowners: family trusts are dropped and homeowner-only projects are signal only', () => {
        expect(byPermit('202610010003')!.businesses).toEqual([]);
        const adu = byPermit('202610010005')!;
        expect(adu.businesses.map((b) => b.name)).toEqual(['Bay ADU Builders Inc']);
        expect(adu.contact_policy).toBe('approach_named_businesses');
        const wall = byPermit('202610010006')!;
        expect(wall.contact_policy).toBe('no_direct_contact');
        expect(wall.services.map((s) => s.service)).toEqual(expect.arrayContaining(['retaining_walls', 'drainage']));
    });

    test('every opportunity has a public source URL, a score whose reasons add up, and a summary', () => {
        for (const o of result.opportunities) {
            expect(o.source.record_url).toMatch(new RegExp(`^${site.baseUrl}/resource/i98e-djp9\\.json\\?permit_number=\\d+$`));
            expect(o.score_reasons.reduce((s, f) => s + f.points, 0)).toBe(o.score);
            expect(o.score).toBeGreaterThanOrEqual(0);
            expect(o.score).toBeLessThanOrEqual(100);
            expect(o.score_summary).toMatch(/^\d+\/100 \((high|medium|low)\): /);
        }
    });

    test('sorts by score, best first', () => {
        const scores = result.opportunities.map((o) => o.score);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });

    test('flags opportunities as new only the first time they are seen', async () => {
        expect(result.opportunities.every((o) => o.is_new)).toBe(true);
        const state = updateState({ version: 1, seen: {} }, result.opportunities);
        const later = new Date(NOW.getTime() + 86_400_000);
        const second = await discover({ source: SF_SOURCE, ctx, days: 30, now: later, minScore: 0, state });
        expect(second.opportunities.every((o: Opportunity) => !o.is_new)).toBe(true);
        expect(second.stats.newOpportunities).toBe(0);
        expect(second.opportunities[0]!.first_seen_at).toBe(NOW.toISOString());
    });

    test('warns when the row limit cut the results short', async () => {
        const capped = await discover({ source: SF_SOURCE, ctx, days: 30, now: NOW, minScore: 0, maxRows: 5 });
        expect(capped.stats.fetched).toBe(5);
        expect(capped.warnings).toContainEqual(expect.stringMatching(/Stopped at the 5-row limit/));
        expect(result.warnings).toEqual([]);
    });

    test('min score filters low-value opportunities', async () => {
        const filtered = await discover({ source: SF_SOURCE, ctx, days: 30, now: NOW, minScore: 70 });
        expect(filtered.opportunities.every((o) => o.score >= 70)).toBe(true);
        expect(filtered.stats.belowMinScore).toBeGreaterThan(0);
    });
});
