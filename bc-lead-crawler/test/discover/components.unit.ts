import { describe, expect, test } from 'vitest';

import { isBusinessEntity, normalizeRole, toBusinesses } from '../../src/discover/businesses.js';
import { classify } from '../../src/discover/classify.js';
import { opportunitiesToCsv } from '../../src/discover/output.js';
import { scoreOpportunity } from '../../src/discover/score.js';
import { matchServices, SERVICE_POINTS } from '../../src/discover/services.js';
import { getSource, JURISDICTIONS } from '../../src/discover/sources/registry.js';
import { assertSfSchema, normalizeSfPermit, sfStage } from '../../src/discover/sources/sf.js';
import { SERVICES, type NormalizedPermit, type Opportunity, type Service } from '../../src/discover/types.js';
import { NOW, SF_PERMIT_ROWS } from './fixtures/sf.js';

const services = (description: string, permitType?: string) => matchServices({ description, permitType }).services.map((s) => s.service);

const permit = (overrides: Partial<NormalizedPermit> = {}): NormalizedPermit => ({
    sourceId: 'sf-dbi',
    permitNumber: '1',
    description: '',
    stage: 'pre_construction',
    status: 'filed',
    city: 'San Francisco',
    county: 'San Francisco',
    sourceUrl: 'https://data.sf.gov/resource/i98e-djp9.json?permit_number=1',
    ...overrides,
});

describe('matchServices', () => {
    test.each<[Service, string]>([
        ['demolition', 'Demolish rear shed'],
        ['excavation', 'Excavate for new foundation with shoring'],
        ['grading', 'Rough grading of lot'],
        ['concrete', 'Pour new concrete slab'],
        ['pavers_hardscape', 'New paver patio and walkway'],
        ['paving', 'Replace asphalt driveway'],
        ['drainage', 'Install storm water drainage system'],
        ['retaining_walls', 'Build 6 ft retaining wall'],
        ['site_work', 'Site improvements and new sewer lateral'],
        ['land_clearing', 'Clearing the lot and tree removal'],
        ['hauling_debris', 'Haul off construction debris'],
        ['remodel', 'Kitchen and bathroom remodel'],
        ['adu', 'Convert garage to accessory dwelling unit'],
        ['general_construction', 'Erect new single family dwelling'],
    ])('detects %s', (service, description) => {
        expect(services(description)).toContain(service);
    });

    test('covers every service in the taxonomy', () => {
        expect(Object.keys(SERVICE_POINTS).sort()).toEqual([...SERVICES].sort());
    });

    test('uses DataSF permit types', () => {
        expect(services('See plans', 'demolitions')).toEqual(expect.arrayContaining(['demolition', 'hauling_debris']));
        expect(services('See plans', 'grade or quarry or fill or excavate')).toEqual(expect.arrayContaining(['grading', 'excavation']));
        expect(matchServices({ description: 'Wall sign', permitType: 'sign - erect' }).excludedReason).toMatch(/sign permit/);
    });

    test('soft-story retrofits mean foundation work', () => {
        expect(services('Mandatory soft story seismic retrofit')).toEqual(expect.arrayContaining(['concrete', 'excavation']));
    });

    test('avoids false positives', () => {
        expect(services('Remodel basement bathroom')).not.toContain('excavation');
        expect(services('Replace kitchen sink drain')).not.toContain('drainage');
        expect(services('Upgrade electrical panel')).toEqual([]);
    });

    test('drops other trades but keeps real remodels that mention them', () => {
        expect(matchServices({ description: 'Reroof and install solar panels' }).services).toEqual([]);
        expect(matchServices({ description: 'Alterations: replace windows' }).excludedReason).toMatch(/other trade/);
        expect(services('Kitchen remodel; replace windows')).toContain('remodel');
    });
});

describe('businesses', () => {
    test('keeps business entities, drops people and family trusts', () => {
        expect(isBusinessEntity('9001 Example Street LLC')).toBe(true);
        expect(isBusinessEntity('Housing Authority of the County')).toBe(true);
        expect(isBusinessEntity('Smith Family Trust')).toBe(false);
        expect(isBusinessEntity('Jane Smith')).toBe(false);
    });

    test('normalizes roles', () => {
        expect(normalizeRole('Contractor')).toBe('contractor');
        expect(normalizeRole('OWNER')).toBe('owner_business');
        expect(normalizeRole('Architect')).toBe('architect');
        expect(normalizeRole('Authorized Agent-Others')).toBe('agent');
    });

    test('uses firm names only and drops owners that are not businesses', () => {
        const url = 'https://data.sf.gov/resource/3pee-9qhc.json?permit_number=1';
        expect(
            toBusinesses(
                [
                    { permitNumber: '1', role: 'Contractor', firmName: 'Acme  Builders Inc', license: '123' },
                    { permitNumber: '1', role: 'Contractor', firmName: 'Acme Builders Inc', license: '123' },
                    { permitNumber: '1', role: 'Owner', firmName: 'John Doe' },
                    { permitNumber: '1', role: 'Owner', firmName: 'Doe Revocable Trust' },
                    { permitNumber: '1', role: 'Engineer' },
                ],
                url,
            ),
        ).toEqual([{ role: 'contractor', name: 'Acme Builders Inc', license: '123', source_url: url }]);
    });
});

describe('scoreOpportunity', () => {
    const base = { businesses: [], contactPolicy: 'research_contractor_first' as const, sourcePublishesContacts: true, now: NOW };

    test('reasons always add up to the score, within 0–100', () => {
        for (const stage of ['pre_construction', 'issued', 'stalled', 'unknown', 'inactive'] as const) {
            const r = scoreOpportunity({ ...base, permit: permit({ stage, estimatedCost: 3e6, statusDate: '2026-10-10' }), services: ['demolition', 'excavation', 'grading', 'concrete'] });
            expect(r.factors.reduce((s, f) => s + f.points, 0)).toBe(r.score);
            expect(r.score).toBeGreaterThanOrEqual(0);
            expect(r.score).toBeLessThanOrEqual(100);
        }
    });

    test('a fresh, large, pre-construction demolition with a named contractor scores high', () => {
        const r = scoreOpportunity({
            ...base,
            businesses: [{ role: 'contractor', name: 'Acme Builders Inc', source_url: 'https://x.example/' }],
            contactPolicy: 'approach_named_businesses',
            permit: permit({ estimatedCost: 1.5e6, filedDate: '2026-10-10' }),
            services: ['demolition', 'hauling_debris'],
        });
        expect(r.score).toBe(38 + 17 + 15 + 15 + 10);
        expect(r.band).toBe('high');
        expect(r.summary).toMatch(/^95\/100 \(high\): matches demolition, hauling\/debris removal/);
    });

    test('older, smaller remodel scores low; inactive permits are capped at 10', () => {
        const old = scoreOpportunity({ ...base, permit: permit({ estimatedCost: 20e3, filedDate: '2026-03-01', stage: 'issued' }), services: ['remodel'] });
        expect(old.band).toBe('low');
        const inactive = scoreOpportunity({ ...base, permit: permit({ stage: 'inactive', estimatedCost: 9e6, filedDate: '2026-10-14' }), services: ['demolition'] });
        expect(inactive.score).toBe(10);
    });

    test('missing value and missing contact data are neutral, homeowner-only projects get no approach points', () => {
        const r = scoreOpportunity({ ...base, sourcePublishesContacts: false, permit: permit(), services: ['concrete'] });
        expect(r.factors.find((f) => f.factor === 'project_value')!.points).toBe(6);
        expect(r.factors.find((f) => f.factor === 'approach')!.points).toBe(4);
        const homeowner = scoreOpportunity({ ...base, contactPolicy: 'no_direct_contact', permit: permit(), services: ['concrete'] });
        expect(homeowner.factors.find((f) => f.factor === 'approach')!.points).toBe(0);
    });

    test('homeowner-only projects are market signals: capped at 40 however good the work looks', () => {
        const r = scoreOpportunity({
            ...base,
            contactPolicy: 'no_direct_contact',
            permit: permit({ estimatedCost: 2e6, filedDate: '2026-10-14' }),
            services: ['retaining_walls', 'drainage', 'excavation'],
        });
        expect(r.score).toBe(40);
        expect(r.band).toBe('low');
        expect(r.factors).toContainEqual(expect.objectContaining({ factor: 'adjustment', detail: 'Homeowner project with no business to approach: signal only, capped at 40' }));
        expect(r.factors.reduce((s, f) => s + f.points, 0)).toBe(40);
    });
});

describe('classify', () => {
    test('residential project with a contractor goes to the contractor, never the homeowner', () => {
        const contractor = { role: 'contractor' as const, name: 'Acme Builders Inc', source_url: 'https://x.example/' };
        const p = permit({ existingUse: '1 family dwelling', existingUnits: 1 });
        expect(classify(p, ['pavers_hardscape'], [contractor])).toMatchObject({ segment: 'general_contractor', contactPolicy: 'approach_named_businesses' });
        expect(classify(p, ['pavers_hardscape'], [])).toMatchObject({ segment: 'residential', contactPolicy: 'no_direct_contact' });
    });
});

describe('SF source', () => {
    test('normalizes a DataSF record', () => {
        const p = normalizeSfPermit(SF_PERMIT_ROWS[1]!)!;
        expect(p).toMatchObject({
            permitNumber: '202610010002',
            permitType: 'new construction wood frame',
            stage: 'pre_construction',
            estimatedCost: 2_400_000,
            revisedCost: 2_650_000,
            proposedUnits: 4,
            address: '9001 Example St',
            parcel: '9901/001',
            neighborhood: 'Mission',
            latitude: 37.7599,
            longitude: -122.4194,
            city: 'San Francisco',
            sourceUrl: 'https://data.sf.gov/resource/i98e-djp9.json?permit_number=202610010002',
        });
        expect(p.filedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('maps statuses to stages', () => {
        expect(sfStage('filed')).toBe('pre_construction');
        expect(sfStage('Plancheck')).toBe('pre_construction');
        expect(sfStage('issued')).toBe('issued');
        expect(sfStage('suspend')).toBe('stalled');
        expect(sfStage('complete')).toBe('inactive');
        expect(sfStage('expired')).toBe('inactive');
        expect(sfStage('something new')).toBe('unknown');
    });

    test('fails loudly, listing the real columns, when field names do not match', () => {
        expect(() => assertSfSchema([{ permit_no: '1', descr: 'x' }])).toThrow(/missing expected field\(s\) permit_number, description, status, filed_date\. Columns returned: descr, permit_no/);
    });

    test('registry: San Francisco is active, other counties are planned and refuse to run', () => {
        expect(getSource('sf-dbi').id).toBe('sf-dbi');
        expect(JURISDICTIONS.map((j) => j.county)).toEqual(expect.arrayContaining(['Contra Costa', 'Alameda', 'San Mateo', 'Santa Clara', 'Marin']));
        expect(() => getSource('alameda')).toThrow(/planned but not implemented/);
    });
});

describe('opportunitiesToCsv', () => {
    test('neutralizes spreadsheet formulas from public records', () => {
        const o = { project_description: '=cmd()', businesses: [], services: [], location: {}, jurisdiction: { city: 'SF' }, permit: { number: '1' }, related_permits: [], source: { record_url: 'https://x.example/' }, estimated_value: null } as unknown as Opportunity;
        expect(opportunitiesToCsv([o])).toContain(`'=cmd()`);
    });
});
