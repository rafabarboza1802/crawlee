import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import type { Business, Opportunity } from '../../src/discover/types.js';
import { buildAccounts } from '../../src/enrich/accounts.js';
import { ApolloClient, isVerifiedBusinessEmail, nameSimilarity } from '../../src/enrich/apollo.js';
import { EnrichConfigSchema } from '../../src/enrich/config.js';
import type { BuyerDecision } from '../../src/enrich/buyers.js';
import { executePlans } from '../../src/enrich/execute.js';
import { applyResults, rowsForAccount } from '../../src/enrich/output.js';
import { estimate, planAccount } from '../../src/enrich/plan.js';
import { Ledger, loadCache } from '../../src/enrich/store.js';

const NOW = new Date('2026-10-22T12:00:00Z');

/** Local stand-in for the Apollo REST API. */
async function fakeApollo(handlers: Record<string, (body: Record<string, unknown>) => [number, unknown]>) {
    const calls: { path: string; body: Record<string, unknown>; key?: string }[] = [];
    const server: Server = createServer(async (req: IncomingMessage, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const path = new URL(req.url!, 'http://x').pathname.replace('/api/v1/', '');
        const body = raw ? JSON.parse(raw) : {};
        calls.push({ path, body, key: req.headers['x-api-key'] as string | undefined });
        const [status, json] = handlers[path]?.(body) ?? [404, {}];
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let n = 0;
function opp(name: string, score = 90): Opportunity {
    n++;
    return {
        schema_version: 1,
        opportunity_id: `sf-dbi:1/${n}`,
        source: { id: 'sf-dbi', name: 'SF', dataset_url: 'https://data.sf.gov/d/i98e-djp9', record_url: `https://data.sf.gov/resource/i98e-djp9.json?permit_number=${n}` },
        jurisdiction: { city: 'San Francisco', county: 'San Francisco', state: 'CA' },
        location: { address: `${n} Example St` },
        permit: { number: String(n), status: 'issued', stage: 'issued', status_date: '2026-10-15' },
        project_description: 'Excavate and lower ground floor, new driveway',
        estimated_value: 1_200_000,
        value_basis: 'estimated_cost',
        businesses: [{ role: 'contractor', name, source_url: 'https://data.sf.gov/x' } as Business],
        services: [{ service: 'excavation', evidence: ['excavate'] }],
        lead_segment: 'general_contractor',
        segment_reason: '',
        contact_policy: 'approach_named_businesses',
        score,
        score_band: 'high',
        score_reasons: [],
        score_summary: '',
        related_permits: [],
        is_new: true,
        first_seen_at: NOW.toISOString(),
        discovered_at: NOW.toISOString(),
    };
}

const ORG = { organizations: [{ id: 'org1', name: 'Nolan Construction, Inc.', website_url: 'http://www.nolanconstruction.example', primary_phone: { sanitized_number: '+14155550100' }, linkedin_url: 'http://www.linkedin.com/company/nolan', state: 'California' }] };
const PEOPLE = {
    people: [
        { id: 'p-owner', first_name: 'Pat', last_name_obfuscated: 'Ow***r', title: 'Owner', state: 'California' },
        { id: 'p-est', first_name: 'Sam', last_name_obfuscated: 'Es***r', title: 'Senior Estimator', state: 'California', linkedin_url: 'http://www.linkedin.com/in/sam' },
        { id: 'p-mkt', first_name: 'Lee', title: 'Marketing Coordinator' },
    ],
};
const MATCH = { person: { id: 'p-est', name: 'Sam Estimator', title: 'Senior Estimator', email: 'sam@nolanconstruction.example', email_status: 'verified', linkedin_url: 'http://www.linkedin.com/in/sam' } };

const BUYER: BuyerDecision = { classification: 'buyer', reason: 'test buyer', evidence: [], source: 'registry' };

async function setup(names: string[], handlers: Parameters<typeof fakeApollo>[0], configOverrides = {}) {
    const api = await fakeApollo(handlers);
    const dir = await mkdtemp(join(tmpdir(), 'exec-'));
    const config = EnrichConfigSchema.parse(configOverrides);
    const cache = await loadCache(join(dir, 'cache.json'), 90, NOW);
    const ledger = await Ledger.load(join(dir, 'ledger.json'));
    const { accounts } = buildAccounts(names.map((x) => opp(x)), 70);
    const plans = accounts.map((a) => planAccount({ ...a, buyer: BUYER }, config, cache));
    const est = estimate(plans, config, NOW);
    const go = (approvedCredits = est.creditsMax, cap = est.monthlyCreditCap) =>
        executePlans(plans, config, new ApolloClient('test-key', api.url), cache, ledger, { planId: est.planId, approvedCredits, monthlyCreditCap: cap, now: NOW, log: () => {} });
    return { api, dir, config, cache, ledger, plans, est, go };
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());

describe('approved run against a fake Apollo server', () => {
    test('refuses to run when any company is not a gate-approved buyer, before any call', async () => {
        const s = await setup(['Nolan Construction Inc'], {});
        cleanup = s.api.close;
        for (const buyer of [undefined, { ...BUYER, classification: 'uncertain' as const }, { ...BUYER, classification: 'competitor' as const }]) {
            const plans = s.plans.map((p) => ({ ...p, account: { ...p.account, buyer } }));
            await expect(
                executePlans(plans, s.config, new ApolloClient('test-key', s.api.url), s.cache, s.ledger, { planId: s.est.planId, approvedCredits: 9, monthlyCreditCap: 9, now: NOW, log: () => {} }),
            ).rejects.toThrow(/not classified as a buyer/);
        }
        expect(s.api.calls).toEqual([]);
    });

    test('organization → people → business email for the highest-priority person; key only in x-api-key', async () => {
        const s = await setup(['Nolan Construction Inc'], { 'mixed_companies/search': () => [200, ORG], 'mixed_people/api_search': () => [200, PEOPLE], 'people/match': () => [200, MATCH] });
        cleanup = s.api.close;
        const [r] = await s.go();
        expect(s.api.calls.map((c) => c.path)).toEqual(['mixed_companies/search', 'mixed_people/api_search', 'people/match']);
        expect(s.api.calls.every((c) => c.key === 'test-key' && !JSON.stringify(c.body).includes('test-key'))).toBe(true);
        expect(s.api.calls[2]!.body).toEqual({ id: 'p-est', reveal_personal_emails: false, reveal_phone_number: false });
        expect(r).toMatchObject({ status: 'enriched', creditsSpent: 2, primary: { name: 'Sam Estimator', email: 'sam@nolanconstruction.example', roleCategory: 'estimating_preconstruction' } });
        expect(r!.backups.map((b) => b.title)).toEqual(['Owner']);
        expect(s.ledger.creditsThisMonth(NOW)).toBe(2);

        const [row] = applyResults(rowsForAccount(s.plans[0]!, 'awaiting_approval'), [r!]);
        expect(row).toMatchObject({
            enrichment_status: 'enriched',
            company_website: 'http://www.nolanconstruction.example',
            company_phone: '+14155550100',
            decision_maker_name: 'Sam Estimator',
            decision_maker_title: 'Senior Estimator',
            business_email: 'sam@nolanconstruction.example',
            linkedin_profile_url: 'http://www.linkedin.com/in/sam',
        });
        expect(await readFile(join(s.dir, 'ledger.json'), 'utf8')).not.toContain('test-key');
    });

    test('cached lookups are never paid for twice', async () => {
        const s = await setup(['Nolan Construction Inc'], { 'mixed_companies/search': () => [200, ORG], 'mixed_people/api_search': () => [200, PEOPLE], 'people/match': () => [200, MATCH] });
        cleanup = s.api.close;
        await s.go();
        const second = await s.go();
        expect(s.api.calls).toHaveLength(3);
        expect(second[0]).toMatchObject({ status: 'enriched', creditsSpent: 0 });
    });

    test('no confident company match: stops after the organization search (1 credit)', async () => {
        const s = await setup(['Nolan Construction Inc'], { 'mixed_companies/search': () => [200, { organizations: [{ id: 'x', name: 'Nolan Plumbing Supply', state: 'California' }] }] });
        cleanup = s.api.close;
        const [r] = await s.go();
        expect(r).toMatchObject({ status: 'no_org_match', creditsSpent: 1 });
        expect(s.api.calls).toHaveLength(1);
    });

    test('out-of-state companies are not matched', async () => {
        const s = await setup(['Nolan Construction Inc'], { 'mixed_companies/search': () => [200, { organizations: [{ ...ORG.organizations[0], state: 'Texas' }] }] });
        cleanup = s.api.close;
        expect((await s.go())[0]!.status).toBe('no_org_match');
    });

    test('personal or unverified emails are never kept', async () => {
        const personal = { person: { ...MATCH.person, email: 'sam@gmail.com' } };
        const s = await setup(['Nolan Construction Inc'], { 'mixed_companies/search': () => [200, ORG], 'mixed_people/api_search': () => [200, PEOPLE], 'people/match': () => [200, personal] });
        cleanup = s.api.close;
        const [r] = await s.go();
        expect(r).toMatchObject({ status: 'no_verified_email' });
        expect(r!.primary!.email).toBeUndefined();
        expect(isVerifiedBusinessEmail({ id: '1', name: 'x', email: 'a@acme.com', emailStatus: 'guessed' })).toBe(false);
    });

    test('never exceeds the approved credits: stops before the next paid call', async () => {
        const s = await setup(['Nolan Construction Inc', 'Bravo Builders Inc'], { 'mixed_companies/search': () => [200, ORG], 'mixed_people/api_search': () => [200, PEOPLE], 'people/match': () => [200, MATCH] });
        cleanup = s.api.close;
        const results = await s.go(2);
        expect(results.map((r) => r.status)).toEqual(['enriched', 'stopped_budget']);
        expect(s.ledger.creditsThisMonth(NOW)).toBe(2);
    });

    test('a rejected API key stops the whole run', async () => {
        const s = await setup(['Nolan Construction Inc', 'Bravo Builders Inc'], { 'mixed_companies/search': () => [401, { error: 'invalid key' }] });
        cleanup = s.api.close;
        const results = await s.go();
        expect(results.map((r) => r.status)).toEqual(['error', 'stopped_auth']);
        expect(s.api.calls).toHaveLength(1);
    });
});

test('company name similarity ignores legal suffixes', () => {
    expect(nameSimilarity('Nolan Construction', 'Nolan Construction, Inc.')).toBe(1);
    expect(nameSimilarity('Nolan Construction', 'Nolan Plumbing Supply')).toBeLessThan(0.85);
});
