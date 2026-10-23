import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import type { Business, Opportunity } from '../../src/discover/types.js';
import { type Account, buildAccounts } from '../../src/enrich/accounts.js';
import { BuyerRegistrySchema, classifyFromHistory, classifyFromRegistry, competitorRiskSignal, isJointVenture, loadBuyerRegistry } from '../../src/enrich/buyers.js';
import { EnrichConfigSchema } from '../../src/enrich/config.js';
import { applyBuyerGate } from '../../src/enrich/gate.js';
import { estimate, planAccount } from '../../src/enrich/plan.js';
import { type PermitHistory, permitHistory } from '../../src/enrich/research.js';
import { loadCache } from '../../src/enrich/store.js';
import { startFakeSocrata } from '../discover/fake-socrata.js';

const NOW = new Date('2026-10-23T12:00:00Z');

const registry = BuyerRegistrySchema.parse({
    version: 1,
    companies: [
        { name: 'Cahill Contractors', classification: 'buyer', aliases: ['cahill contractors'], reason: 'Large SF GC with a trade bid portal.', scope: 'site demolition, excavation', evidence: ['trade portal'] },
        { name: 'Power Engineering Construction Co.', classification: 'competitor', aliases: ['power engineering contraction'], licenses: ['488215'], reason: 'Self-performs heavy civil.' },
        { name: "W.E. O'Neil Construction", classification: 'competitor', aliases: ['we oneil', 'w e oneil'], reason: 'Large GC competitor.' },
        { name: 'BCCI Construction', classification: 'competitor', aliases: ['bcci'], licenses: ['492944'], reason: 'Competitor.' },
        { name: 'Guzman Construction Group', classification: 'do_not_enrich', licenses: ['1010621'], reason: 'Not the bidding contact for the JV.' },
        { name: 'Build Group', classification: 'uncertain', reason: 'Large GC; self-performs concrete; no sitework solicitations found.', evidence: ['own site'] },
    ],
    jointVentures: [{ name: 'Cahill Guzman Construction Group JV', aliases: ['cahill guzman'], licenses: ['1016831'], managingGc: 'Cahill Contractors', evidence: ['Cahill runs trade bidding'] }],
    competitorRiskPatterns: ['paving', 'excavat', 'demolition', 'concrete'],
});

const history = (overrides: Partial<PermitHistory> = {}): PermitHistory => ({
    license: '1',
    since: '2023-10-24',
    permits: 0,
    newBuildings: 0,
    totalValue: 0,
    largestValue: 0,
    specialistPermits: 0,
    examples: [],
    ...overrides,
});

let n = 0;
function opp(name: string, license?: string, score = 90): Opportunity {
    n++;
    return {
        schema_version: 1,
        opportunity_id: `sf-dbi:7/${n}`,
        source: { id: 'sf-dbi', name: 'SF', dataset_url: 'https://data.sf.gov/d/i98e-djp9', record_url: `https://data.sf.gov/resource/i98e-djp9.json?permit_number=${n}` },
        jurisdiction: { city: 'San Francisco', county: 'San Francisco', state: 'CA' },
        location: { address: `${n} Example St` },
        permit: { number: String(n), status: 'issued', stage: 'issued', status_date: '2026-10-15' },
        project_description: 'New 8-story building with excavation',
        estimated_value: 40_000_000,
        value_basis: 'estimated_cost',
        businesses: [{ role: 'contractor', name, license, source_url: 'https://data.sf.gov/x' } as Business],
        services: [{ service: 'excavation', evidence: ['excavation'] }],
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

describe('registry classification', () => {
    test('matches names, aliases and licences regardless of punctuation and legal suffix', () => {
        expect(classifyFromRegistry(registry, "W.E. O'Neil Construction Co. of California")?.classification).toBe('competitor');
        expect(classifyFromRegistry(registry, 'Bcci Construction Company')?.classification).toBe('competitor');
        expect(classifyFromRegistry(registry, 'Power Engineering Contraction Co.')?.classification).toBe('competitor');
        expect(classifyFromRegistry(registry, 'Some Renamed Firm', '488215')?.resolvedName).toBe('Power Engineering Construction Co.');
        expect(classifyFromRegistry(registry, 'Cahill Contractors LLC')).toMatchObject({ classification: 'buyer', source: 'registry', scope: 'site demolition, excavation' });
        // Alias matching is on whole words, not substrings.
        expect(classifyFromRegistry(registry, 'Abcci Builders')).toBeUndefined();
    });

    test('a joint venture resolves to its managing GC; an unknown JV stops for review', () => {
        expect(isJointVenture('Cahill Guzman Construction Group JV')).toBe(true);
        expect(isJointVenture('Joint Venture of A and B')).toBe(true);
        expect(isJointVenture('Jvc Builders')).toBe(false);
        expect(classifyFromRegistry(registry, 'Cahill Guzman Construction Group JV')).toMatchObject({
            classification: 'buyer',
            source: 'joint_venture',
            resolvedName: 'Cahill Contractors',
            jointVenture: 'Cahill Guzman Construction Group JV',
            evidence: ['Cahill runs trade bidding', 'trade portal'],
        });
        expect(classifyFromRegistry(registry, 'Acme Webcor JV')).toMatchObject({ classification: 'uncertain', source: 'joint_venture' });
        expect(classifyFromRegistry(registry, 'Cahill Swinerton JV')?.reason).toMatch(/Partner already approved as a buyer: Cahill Contractors/);
    });

    test('competitor-risk words never decide on their own: the company still needs research', () => {
        expect(classifyFromRegistry(registry, 'Bay Area Paving Co')).toBeUndefined();
        expect(competitorRiskSignal(registry, 'Bay Area Paving Co')).toBe('paving');
        expect(competitorRiskSignal(registry, 'Golden Gate Excavating Inc')).toBe('excavat');
        expect(competitorRiskSignal(registry, 'Mission Builders Inc')).toBeUndefined();
    });

    test('owner decisions and research notes in the registry are kept', () => {
        expect(classifyFromRegistry(registry, 'Guzman Construction Group Inc.')).toMatchObject({ classification: 'do_not_enrich', source: 'registry' });
        expect(classifyFromRegistry(registry, 'Build Group Inc.')).toMatchObject({ classification: 'uncertain', evidence: ['own site'] });
    });

    test('a JV whose managing GC is not in the registry is rejected when loading', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'reg-'));
        const path = join(dir, 'r.json');
        await writeFile(path, JSON.stringify({ version: 1, companies: [], jointVentures: [{ name: 'X JV', managingGc: 'Nobody' }] }));
        await expect(loadBuyerRegistry(path)).rejects.toThrow(/managing GC "Nobody"/);
    });

    test('the shipped registry loads and covers the researched competitors', async () => {
        const shipped = await loadBuyerRegistry(new URL('../../buyer-registry.json', import.meta.url).pathname);
        expect(classifyFromRegistry(shipped, 'Guzman Construction Group Inc.')?.classification).toBe('do_not_enrich');
        expect(classifyFromRegistry(shipped, 'Esquivel Grading & Paving, Inc.')?.classification).toBe('competitor');
        expect(classifyFromRegistry(shipped, 'Build Group Inc.')?.classification).toBe('uncertain');
        for (const name of ['Novo Construction Inc', 'Formline Construction Corp', 'Shorecal Engineering Inc', 'Swinerton Builders', 'DPR Construction', 'Teichert Construction', 'Ghilotti Bros Inc']) {
            expect(classifyFromRegistry(shipped, name)?.classification, name).toBe('competitor');
        }
        expect(classifyFromRegistry(shipped, 'Cahill Guzman Construction Group JV')?.resolvedName).toBe('Cahill Contractors');
    });
});

describe('permit-history research', () => {
    test('never yields buyer: specialists are competitors, small firms are not targets, the rest go to review', () => {
        expect(classifyFromHistory('X', undefined)).toMatchObject({ classification: 'uncertain', reason: expect.stringMatching(/unavailable/) });
        expect(classifyFromHistory('X', history({ permits: 6, specialistPermits: 4 })).classification).toBe('competitor');
        expect(classifyFromHistory('X', history({ permits: 2, specialistPermits: 2 })).classification).toBe('not_target');
        const large = classifyFromHistory('X', history({ permits: 30, newBuildings: 4, totalValue: 90e6, largestValue: 40e6, specialistPermits: 2 }));
        expect(large).toMatchObject({ classification: 'uncertain', reason: expect.stringMatching(/^Large GC by permit history/) });
        expect(classifyFromHistory('X', history({ permits: 3, totalValue: 2e5, largestValue: 1e5 }))).toMatchObject({ classification: 'not_target', reason: expect.stringMatching(/^Small contractor/) });
        expect(classifyFromHistory('X', history({ permits: 20, totalValue: 9e6, largestValue: 1.5e6 })).reason).toMatch(/^Mid-size contractor/);
        // A big current project means a possibly large out-of-town GC: never dismissed as small.
        expect(classifyFromHistory('X', history({ permits: 1, totalValue: 1e5, largestValue: 1e5 }), undefined, 40e6).classification).toBe('uncertain');
    });

    test('summarizes a licence holder’s own recent permits from public data only', async () => {
        const site = await startFakeSocrata({
            datasets: {
                '3pee-9qhc': [
                    { permit_number: 'A', role: 'contractor' },
                    { permit_number: 'B', role: 'Contractor' },
                    { permit_number: 'C', role: 'contractor' },
                    { permit_number: 'D', role: 'architect' },
                ],
                'i98e-djp9': [
                    { permit_number: 'A', permit_type_definition: 'demolitions', estimated_cost: '50000', filed_date: '2025-01-01T00:00:00.000' },
                    { permit_number: 'B', permit_type_definition: 'otc alterations permit', estimated_cost: '20000', description: 'Grading of rear yard', filed_date: '2025-03-01T00:00:00.000' },
                    { permit_number: 'C', permit_type_definition: 'new construction', estimated_cost: '9000000', filed_date: '2019-01-01T00:00:00.000' },
                    { permit_number: 'D', permit_type_definition: 'new construction', estimated_cost: '1', filed_date: '2025-01-01T00:00:00.000' },
                ],
            },
        });
        try {
            const h = await permitHistory('123', { userAgent: 'BestConstructionBot/test', robotsToken: 'BestConstructionBot', baseUrl: site.baseUrl, log: () => {} }, NOW);
            expect(h).toMatchObject({ license: '123', permits: 2, specialistPermits: 2, newBuildings: 0, totalValue: 70000, largestValue: 50000 });
            const contacts = site.requests.find((r) => r.path === '/resource/3pee-9qhc.json')!;
            expect(contacts.params.get('$select')).toBe('permit_number,role');
            expect(contacts.params.get('$where')).toBe("license1='123'");
        } finally {
            await site.close();
        }
    });
});

describe('buyer gate', () => {
    const config = EnrichConfigSchema.parse({});

    async function gate(opps: Opportunity[], lookup = async (_: string): Promise<PermitHistory> => history()) {
        const dir = await mkdtemp(join(tmpdir(), 'gate-'));
        const cache = await loadCache(join(dir, 'c.json'), 30, NOW);
        const { accounts } = buildAccounts(opps, 70);
        return { accounts, cache, result: await applyBuyerGate(accounts, registry, lookup, cache, NOW) };
    }

    test('only buyers pass; a JV and its managing GC merge into one account named after the GC', async () => {
        const { result } = await gate([
            opp('Cahill Guzman Construction Group JV', '1016831', 95),
            opp('Cahill Contractors LLC', '999', 80),
            opp('Power Engineering Contraction Co.', '488215', 94),
            opp('Mission Builders Inc', '555', 90),
            opp('Nameless Firm Inc', undefined, 85),
            opp('Guzman Construction Group Inc.', '1010621', 82),
        ]);
        expect(result.buyers).toHaveLength(1);
        expect(result.buyers[0]).toMatchObject({
            accountId: 'cahill-contractors',
            displayName: 'Cahill Contractors (managing GC of Cahill Guzman Construction Group JV)',
            searchName: 'Cahill Contractors',
            license: undefined,
            bestScore: 95,
        });
        expect(result.buyers[0]!.opportunities).toHaveLength(2);
        expect(result.blocked.map((a) => a.displayName)).toEqual(['Power Engineering Contraction Co.']);
        expect(result.excluded.map((a) => a.displayName)).toEqual(['Guzman Construction Group Inc.']);
        expect(result.review.map((a) => [a.displayName, a.buyer!.source])).toEqual([
            ['Mission Builders Inc', 'permit_research'],
            ['Nameless Firm Inc', 'permit_research'],
        ]);
    });

    test('a risk word in the name is blocked only when research shows the company self-performs those scopes', async () => {
        const generalist = await gate([opp('Bay Area Paving Co', '41')], async () => history({ permits: 8, specialistPermits: 1 }));
        expect(generalist.result.blocked).toEqual([]);
        expect(generalist.result.review[0]!.buyer).toMatchObject({ classification: 'uncertain', riskSignal: 'paving', reason: expect.stringMatching(/Competitor-risk word in name \("paving"\)/) });
        const selfPerformer = await gate([opp('Bay Area Paving Co', '42')], async () => history({ permits: 8, specialistPermits: 6 }));
        expect(selfPerformer.result.blocked[0]!.buyer).toMatchObject({ classification: 'competitor', source: 'permit_research', riskSignal: 'paving' });
    });

    test('research is cached per licence and a failed lookup means manual review, not a pass', async () => {
        let lookups = 0;
        const failing = async () => {
            lookups++;
            throw new Error('offline');
        };
        const first = await gate([opp('Mission Builders Inc', '555')], failing);
        expect(first.result.review[0]!.buyer!.reason).toMatch(/unavailable/);
        const specialist = async () => {
            lookups++;
            return history({ license: '777', permits: 5, specialistPermits: 4 });
        };
        const { cache, accounts } = await gate([opp('Mission Builders Inc', '777')], specialist);
        const again = await applyBuyerGate(accounts, registry, specialist, cache, NOW);
        expect(again.blocked).toHaveLength(1);
        expect(lookups).toBe(2);
    });

    test('the plan id changes when a company’s classification changes', async () => {
        const { result } = await gate([opp('Cahill Contractors', '1')]);
        const cache = { has: () => false };
        const plans = result.buyers.map((a) => planAccount(a, config, cache));
        const other = result.buyers.map((a: Account) => planAccount({ ...a, buyer: { ...a.buyer!, source: 'joint_venture' } }, config, cache));
        expect(estimate(plans, config, NOW).planId).not.toBe(estimate(other, config, NOW).planId);
    });
});
