/**
 * Regression tests from the first real DataSF run (7 days to 2026-10-20). Descriptions and business names are quoted
 * from public DataSF records; addresses are not needed for these cases.
 */
import { describe, expect, test } from 'vitest';

import { isCompanyName, toBusinesses } from '../../src/discover/businesses.js';
import { mergeAdjacentProjects } from '../../src/discover/discover.js';
import { matchServices, SERVICE_POINTS } from '../../src/discover/services.js';
import { SF_SOURCE } from '../../src/discover/sources/sf.js';
import type { NormalizedPermit } from '../../src/discover/types.js';

const services = (description: string, permitType?: string) => matchServices({ description, permitType }).services.map((s) => s.service);

describe('interior strip-outs are not building demolition', () => {
    test.each([
        '9/fl- ti 6500sf interior demo and (n) constructoin of interior partitions, doors, finishes, ceilings, lights fixtures, and millwork.',
        'ste 2700: interior tenant improvement: demolition of non-structural partitions, new partitions, finishes fixtures, and lighting.',
        'demo exist ductwork, diffusers, grilles and 4 wshps with associated ductwork and condenser water piping to bldg mains',
        'level 1 - demo full bath, pantry, kitchen & laundry for (n) powder room, laundry and room & kitchen',
        'g/f -exploratory demolition of drywall. approx. 300 sf. commercial space is vacant',
        "unit 102: demo 3'x1' sheetrock in hallway entrance of unit. no frame involved.",
    ])('%s', (description) => {
        const s = services(description);
        expect(s).toContain('interior_demolition');
        expect(s).not.toContain('demolition');
    });

    test.each([
        ['to demolish 1 story office building (marina office building)', 'demolitions'],
        ['demolish a 2 story building,no dwelling unit,no basement-type v.(holocaust center)', 'demolitions'],
        ['front yard resurfacing and driveway renewal. demolish (e) entry patio, iron fence, and driveway. new pavers over concrete pad', 'otc alterations permit'],
        ['demolish existing detached garage', 'additions alterations or repairs'],
    ])('%s', (description, permitType) => {
        expect(services(description, permitType)).toContain('demolition');
    });

    test('interior demolition scores well below building demolition', () => {
        expect(SERVICE_POINTS.interior_demolition).toBeLessThan(SERVICE_POINTS.demolition - 10);
    });
});

describe('hardscape matching', () => {
    test('framed exterior stairs and enclosed patios are not hardscape', () => {
        expect(services('fire repair in kind replacement due to fire damage limited to exterior stairs- structural work required')).not.toContain('pavers_hardscape');
        expect(services('convert part of e garage into conditioned area. enclose/infill patio under e) sunroom into a new sitting room.')).not.toContain('pavers_hardscape');
    });

    test('real hardscape still matches', () => {
        expect(services('new pavers over concrete pad')).toContain('pavers_hardscape');
        expect(services('new concrete steps and brick patio in rear yard')).toContain('pavers_hardscape');
        expect(services('remove existing playhouse and pergola/patio.')).toContain('pavers_hardscape');
    });
});

describe('business names: companies only', () => {
    const url = 'https://data.sf.gov/resource/3pee-9qhc.json?permit_number=1';

    test('"Owner" / "Owner Builder" means the property owner did the work: never a business', () => {
        const contacts = ['Owner', 'Owner Builder', 'owner/builder', 'OWNER-BUILDER', 'Homeowner'].map((firmName) => ({ permitNumber: '1', role: 'Contractor', firmName }));
        expect(toBusinesses(contacts, url)).toEqual([]);
    });

    test.each(['Doug Lee', 'Joyce Mizuhara', 'Levi Abarte', 'Horon Lee', 'Catherine Carr', 'A. Gordon Atkinson Aia'])('person name dropped: %s', (name) => {
        expect(isCompanyName(name)).toBe(false);
    });

    test.each([
        'Bcci Construction Company',
        'Nolan Construction Inc',
        'Power Engineering Contraction Co.',
        'Pristine Construction',
        'Revel Architecture & Design',
        'Love & Interiors',
        'Zfa Structural Engineers',
        'Terra Ferma Landscape Designs',
        'A+G Design+Build',
        'Sf Permitting',
        'Gary Bell & Assoc.',
        'Rmw',
        'Ehdd',
    ])('company kept: %s', (name) => {
        expect(isCompanyName(name)).toBe(true);
    });
});

describe('adjacent parcels filed together are one project', () => {
    const permit = (overrides: Partial<NormalizedPermit>): NormalizedPermit => ({
        sourceId: 'sf-dbi',
        permitNumber: '1',
        description: 'demolish a 2 story building',
        stage: 'pre_construction',
        permitType: 'demolitions',
        statusDate: '2026-10-13',
        city: 'San Francisco',
        county: 'San Francisco',
        sourceUrl: 'https://data.sf.gov/resource/i98e-djp9.json?permit_number=1',
        ...overrides,
    });

    test('same block, same permit type, same day, consecutive permit numbers -> merged', () => {
        const a = permit({ permitNumber: '202610139327', parcel: '1078/021', address: '2245 Post St' });
        const b = permit({ permitNumber: '202610139328', parcel: '1078/020', address: '2255 Post St' });
        const groups = mergeAdjacentProjects(new Map([['sf-dbi:1078/021', [a]], ['sf-dbi:1078/020', [b]]]));
        expect([...groups.values()].map((g) => g.map((p) => p.permitNumber).sort())).toEqual([['202610139327', '202610139328']]);
    });

    test('different blocks, types or days stay separate', () => {
        const a = permit({ permitNumber: '202610139327', parcel: '1078/021' });
        const otherBlock = permit({ permitNumber: '202610139328', parcel: '2000/020' });
        const otherType = permit({ permitNumber: '202610139329', parcel: '1078/019', permitType: 'otc alterations permit' });
        const otherDay = permit({ permitNumber: '202610139330', parcel: '1078/018', statusDate: '2026-09-01' });
        const groups = mergeAdjacentProjects(
            new Map([
                ['k1', [a]],
                ['k2', [otherBlock]],
                ['k3', [otherType]],
                ['k4', [otherDay]],
            ]),
        );
        expect(groups.size).toBe(4);
    });
});

test('San Francisco source uses the new DataSF address', () => {
    expect(SF_SOURCE.datasetUrl).toBe('https://data.sf.gov/d/i98e-djp9');
});
