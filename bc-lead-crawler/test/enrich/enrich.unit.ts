import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import type { Business, Opportunity } from '../../src/discover/types.js';
import { accountIdFor, buildAccounts, searchNameFor } from '../../src/enrich/accounts.js';
import { EnrichConfigSchema } from '../../src/enrich/config.js';
import { assertNotLinkedIn, guardedFetch, LinkedInAccessError, linkedInPeopleSearchUrl } from '../../src/enrich/linkedin.js';
import { rowsForAccount } from '../../src/enrich/output.js';
import { estimate, planAccount } from '../../src/enrich/plan.js';
import { roleTargets, targetTitles } from '../../src/enrich/roles.js';

const run = promisify(execFile);
const NOW = new Date('2026-10-20T12:00:00Z');
const noCache = { has: () => false };
const config = EnrichConfigSchema.parse({});

let n = 0;
function opp(score: number, businesses: Partial<Business>[], overrides: Partial<Opportunity> = {}): Opportunity {
    n++;
    return {
        schema_version: 1,
        opportunity_id: `sf-dbi:9900/${n}`,
        source: { id: 'sf-dbi', name: 'SF', dataset_url: 'https://data.sf.gov/d/i98e-djp9', record_url: `https://data.sf.gov/resource/i98e-djp9.json?permit_number=${n}` },
        jurisdiction: { city: 'San Francisco', county: 'San Francisco', state: 'CA' },
        location: { address: `${n} Example St` },
        permit: { number: String(n), status: 'issued', stage: 'issued', status_date: '2026-10-15' },
        project_description: 'Excavate and lower ground floor, new driveway',
        estimated_value: 1_200_000,
        value_basis: 'estimated_cost',
        businesses: businesses.map((b) => ({ role: 'contractor', name: 'Acme Builders Inc', source_url: 'https://data.sf.gov/x', ...b }) as Business),
        services: [
            { service: 'excavation', evidence: ['excavate'] },
            { service: 'paving', evidence: ['driveway'] },
            { service: 'remodel', evidence: ['remodel'] },
        ],
        lead_segment: 'general_contractor',
        segment_reason: '',
        contact_policy: 'approach_named_businesses',
        score,
        score_band: score >= 70 ? 'high' : 'medium',
        score_reasons: [],
        score_summary: '',
        related_permits: [],
        is_new: true,
        first_seen_at: NOW.toISOString(),
        discovered_at: NOW.toISOString(),
        ...overrides,
    };
}

describe('account selection', () => {
    test('only score ≥ 70, business contacts allowed, grouped per company, best score first', () => {
        const { accounts, excluded } = buildAccounts(
            [
                opp(65, [{}]),
                opp(80, [{ name: 'Acme Builders Inc', license: '1000001' }]),
                opp(93, [{ name: 'ACME BUILDERS, INC.' }]),
                opp(90, [], { contact_policy: 'no_direct_contact', lead_segment: 'residential' }),
                opp(88, [{ role: 'architect', name: 'Sample Design Studio' }]),
                opp(85, [{ role: 'owner_business', name: '9001 Example LLC' }], { lead_segment: 'public_construction' }),
            ],
            70,
        );
        expect(accounts).toHaveLength(1);
        expect(accounts[0]).toMatchObject({ accountId: 'acme-builders', bestScore: 93, kind: 'contractor' });
        expect(accounts[0]!.opportunities.map((o) => o.score)).toEqual([93, 80]);
        expect(excluded.map((e) => e.reason)).toEqual([
            'Homeowner project: no direct contact, never enriched',
            'No contractor or business owner named on the permit yet: watch for a contractor',
            'Public agency: use the procurement contact on the bid notice, no people search',
        ]);
    });

    test('prefers the contractor; owner businesses map to developer or property-manager targets', () => {
        const both = buildAccounts([opp(90, [{ role: 'owner_business', name: 'Owner LLC' }, { role: 'contractor', name: 'Builder Co.' }])], 70);
        expect(both.accounts[0]!.displayName).toBe('Builder Co.');
        const dev = buildAccounts([opp(90, [{ role: 'owner_business', name: 'Dev Partners LLC' }], { lead_segment: 'developer_home_builder' })], 70);
        expect(dev.accounts[0]!.kind).toBe('developer');
        const pm = buildAccounts([opp(90, [{ role: 'owner_business', name: 'Bay Apartments LLC' }], { lead_segment: 'property_management' })], 70);
        expect(pm.accounts[0]!.kind).toBe('property_owner_manager');
    });

    test('do-not-contact list is honored', () => {
        const { accounts, excluded } = buildAccounts([opp(90, [{ name: 'Acme Builders Inc' }])], 70, new Set([accountIdFor('Acme Builders')]));
        expect(accounts).toEqual([]);
        expect(excluded[0]!.reason).toMatch(/do-not-contact/);
    });

    test('search names: notes, legal suffixes and DataSF 40-character truncation removed', () => {
        expect(searchNameFor('Edri Construction Inc *See Notes*')).toBe('Edri Construction');
        expect(searchNameFor('Pinnacle Construction And Development In')).toBe('Pinnacle Construction And Development');
        expect(searchNameFor('Nk Construction & Real Estate Developmen')).toBe('Nk Construction & Real Estate');
        expect(searchNameFor('Sandbank Construction, Inc')).toBe('Sandbank Construction');
    });
});

describe('role targets (owner priority list)', () => {
    test('construction companies: estimating/precon first, then procurement, project leadership, CM/field, leadership last', () => {
        expect(roleTargets('contractor').map((r) => r.category)).toEqual([
            'estimating_preconstruction',
            'procurement',
            'project_leadership',
            'construction_management',
            'business_development',
            'leadership',
        ]);
        expect(targetTitles('contractor')).toEqual(
            expect.arrayContaining(['Chief Estimator', 'Senior Estimator', 'Estimator', 'Director of Preconstruction', 'Preconstruction Manager', 'Project Executive', 'Project Manager', 'Procurement Manager', 'Subcontractor Manager', 'Vendor Manager']),
        );
    });

    test('property owners/managers and developers', () => {
        expect(targetTitles('property_owner_manager')).toEqual(
            expect.arrayContaining(['Property Manager', 'Regional Property Manager', 'Director of Facilities', 'Facilities Manager', 'Community Manager', 'HOA Manager', 'Asset Manager']),
        );
        expect(targetTitles('developer')).toEqual(expect.arrayContaining(['Director of Construction', 'Development Manager', 'Construction Manager', 'Purchasing Manager']));
    });
});

describe('LinkedIn: compliant use only', () => {
    test('code refuses to request LinkedIn, before any network access', async () => {
        expect(() => assertNotLinkedIn('https://www.linkedin.com/in/someone')).toThrow(LinkedInAccessError);
        expect(() => assertNotLinkedIn('https://lnkd.in/abc')).toThrow(LinkedInAccessError);
        expect(() => assertNotLinkedIn('https://api.apollo.io/api/v1/people/match')).not.toThrow();
        await expect(guardedFetch('https://www.linkedin.com/search/results/people/')).rejects.toThrow(LinkedInAccessError);
    });

    test('manual search links only', () => {
        expect(linkedInPeopleSearchUrl('Nolan Construction', 'Estimator')).toBe(
            'https://www.linkedin.com/search/results/people/?keywords=%22Nolan+Construction%22+Estimator',
        );
    });

    test('no enrichment module other than the guard calls fetch', async () => {
        const dir = new URL('../../src/enrich/', import.meta.url);
        for (const file of await readdir(dir)) {
            if (file === 'linkedin.ts') continue;
            expect(await readFile(new URL(file, dir), 'utf8'), file).not.toMatch(/\bfetch\s*\(/);
        }
    });
});

describe('plan and estimate', () => {
    const account = buildAccounts([opp(93, [{ name: 'Nolan Construction Inc' }])], 70).accounts[0]!;

    test('per company: organization search, free people search, then the primary contact only', () => {
        const plan = planAccount(account, config, noCache);
        expect(plan.calls.map((c) => [c.step, c.endpoint.split('/v1/')[1], c.credits])).toEqual([
            [1, 'mixed_companies/search', 1],
            [2, 'mixed_people/api_search', 0],
            [3, 'people/match', 1],
        ]);
        expect(plan.calls[0]!.body).toMatchObject({ q_organization_name: 'Nolan Construction' });
        expect(plan.calls[2]!.body).toMatchObject({ reveal_personal_emails: false, reveal_phone_number: false });
        expect([plan.creditsExpected, plan.creditsMax]).toEqual([2, 2]);
    });

    test('backup contacts raise the maximum, cached lookups cost nothing', () => {
        const three = planAccount(account, EnrichConfigSchema.parse({ maxEnrichedPerAccount: 3 }), noCache);
        expect([three.creditsExpected, three.creditsMax]).toEqual([2, 4]);
        const cached = planAccount(account, config, { has: (k) => k.startsWith('apollo:org-search') });
        expect(cached.calls[0]).toMatchObject({ cached: true, credits: 0 });
        expect(cached.creditsExpected).toBe(1);
    });

    test('budget: within cap, USD when the price per credit is known, refused when over', () => {
        const plans = [planAccount(account, config, noCache)];
        expect(estimate(plans, config, NOW)).toMatchObject({ creditsExpected: 2, creditsMax: 2, usdExpected: null, withinBudget: true });
        const priced = EnrichConfigSchema.parse({ usdPerCredit: 0.02 });
        expect(estimate(plans, priced, NOW)).toMatchObject({ usdExpected: 0.04, monthlyCreditCap: 500 });
        expect(estimate(plans, EnrichConfigSchema.parse({ monthlyCreditCap: 1 }), NOW).withinBudget).toBe(false);
    });

    test('the plan id changes whenever what would be sent or paid changes', () => {
        const a = estimate([planAccount(account, config, noCache)], config, NOW).planId;
        const b = estimate([planAccount(account, EnrichConfigSchema.parse({ maxEnrichedPerAccount: 2 }), noCache)], config, NOW).planId;
        expect(a).not.toBe(b);
        expect(estimate([planAccount(account, config, noCache)], config, NOW).planId).toBe(a);
    });

    test('contact plan rows: requested fields, person data pending, manual LinkedIn link, reason and pitch', () => {
        const [row] = rowsForAccount(planAccount(account, config, noCache), 'awaiting_approval');
        expect(row).toMatchObject({
            opportunity_score: 93,
            estimated_value: 1_200_000,
            company_name: 'Nolan Construction Inc',
            company_website: null,
            decision_maker_name: null,
            business_email: null,
            linkedin_profile_url: null,
        });
        expect(row!.linkedin_manual_search_url).toContain('linkedin.com/search/results/people/');
        expect(row!.reason_to_contact).toMatch(/^Named contractor on permit \d+ at .+ \(issued 2026-10-15, \$1\.2M\): Excavate/);
        expect(row!.recommended_pitch).toBe('Sub bid for excavation, paving/driveways: line-item bid, CalGreen haul-off included, photo-documented; ask to be on their bid list.');
    });
});

describe('CLI', () => {
    // Tests never use the real key or reach api.apollo.io.
    const env = { ...process.env, APOLLO_API_KEY: 'test-key', APOLLO_BASE_URL: 'http://127.0.0.1:9/api/v1' };
    const cli = (args: string[]) => run('npx', ['tsx', 'src/enrich/main.ts', ...args], { cwd: new URL('../..', import.meta.url).pathname, env });

    test('requires exactly one of --dry-run or --approve', async () => {
        await expect(cli([])).rejects.toMatchObject({ stderr: expect.stringMatching(/Usage:/) });
        await expect(cli(['--dry-run', '--approve', 'x', '--input', 'x'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Usage:/) });
    });

    test('dry run writes the plan and the estimate; approval of a different plan id is refused before any call', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'enrich-'));
        const input = join(dir, 'opps.jsonl');
        await writeFile(
            input,
            [opp(93, [{ name: 'Nolan Construction Inc' }]), opp(91, [{ name: 'Bay Cities Paving & Grading Inc' }]), opp(90, [{ name: 'Unknown Builders Inc' }]), opp(40, [{}])]
                .map((o) => JSON.stringify(o))
                .join('\n'),
        );
        const registry = join(dir, 'registry.json');
        await writeFile(
            registry,
            JSON.stringify({
                version: 1,
                companies: [
                    { name: 'Nolan Construction', classification: 'buyer', reason: 'Large GC that bids sitework out', evidence: ['bid portal'] },
                    { name: 'Bay Cities Paving', classification: 'competitor', reason: 'Self-performs paving', evidence: ['own site'] },
                ],
                competitorRiskPatterns: ['paving'],
            }),
        );
        const common = ['--input', input, '--out', dir, '--config', join(dir, 'none.json'), '--cache', join(dir, 'cache.json'), '--ledger', join(dir, 'ledger.json')];
        common.push('--registry', registry, '--research-cache', join(dir, 'research.json'));
        const { stdout } = await cli(['--dry-run', ...common]);
        expect(stdout).toMatch(/DRY RUN — no Apollo calls were made, no credits were used/);
        expect(stdout).toMatch(/Buyer gate \(3 companies\): 1 buyer, 1 blocked, 0 do-not-enrich, 1 manual review/);
        expect(stdout).toMatch(/why: Large GC that bids sitework out/);
        expect(stdout).toMatch(/BLOCKED[^]*Bay Cities Paving/);
        expect(stdout).toMatch(/MANUAL REVIEW[^]*Unknown Builders/);
        expect(stdout).toMatch(/credits: 2 expected, 2 maximum/);
        expect(stdout).toMatch(/npm run enrich -- --approve [0-9a-f]{12}/);
        const files = await readdir(dir);
        expect(files.some((f) => f.startsWith('contact-plan-') && f.endsWith('.csv'))).toBe(true);
        expect(files.some((f) => f.startsWith('enrich-estimate-'))).toBe(true);
        expect(files.some((f) => f.startsWith('buyer-review-'))).toBe(true);
        await expect(cli(['--approve', '000000000000', ...common])).rejects.toMatchObject({ stderr: expect.stringMatching(/plan changed/) });
        expect(await readdir(dir)).not.toContain('ledger.json');
    });
});
