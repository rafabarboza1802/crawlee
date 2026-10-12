import { describe, expect, test } from 'vitest';

import { SUBPAGE_PATTERN } from '../src/crawl.js';
import { extractPage } from '../src/extract.js';
import { SEGMENT_GROUPS, SEGMENTS, segmentGroupFor } from '../src/schema.js';

const URL_ = 'https://prospect.example/';
const keys = (html: string) => extractPage(`<body>${html}</body>`, URL_).signals.map((s) => `${s.category}:${s.keyword}`);
const roles = (html: string) => extractPage(`<body>${html}</body>`, URL_).publicRoles.map((r) => r.value);

describe('segment groups', () => {
    test('covers the six lead segments', () => {
        expect(Object.keys(SEGMENT_GROUPS).sort()).toEqual(
            [
                'commercial_real_estate',
                'developer_home_builder',
                'general_contractor',
                'property_management',
                'public_construction',
                'residential',
            ].sort(),
        );
    });

    test('every segment hint maps to exactly one group (unknown -> unclassified)', () => {
        for (const segment of SEGMENTS) {
            const groups = Object.entries(SEGMENT_GROUPS).filter(([, members]) => (members as readonly string[]).includes(segment));
            expect(groups.length, segment).toBe(segment === 'unknown' ? 0 : 1);
        }
        expect(segmentGroupFor('hoa_management')).toBe('property_management');
        expect(segmentGroupFor('home_builder')).toBe('developer_home_builder');
        expect(segmentGroupFor('public_agency')).toBe('public_construction');
        expect(segmentGroupFor('unknown')).toBe('unclassified');
    });
});

describe('per-segment extraction', () => {
    test('Property management / HOA / multifamily', () => {
        expect(keys('<p>We manage 1,200 units and 40 HOAs. Common areas, pool deck and parking lot upkeep.</p>')).toEqual(
            expect.arrayContaining(['portfolio:1,200 units', 'portfolio:HOAs', 'hardscape:pool deck', 'paving:parking lot']),
        );
        expect(roles('<p>Community Association Manager</p>')).toContain('Community Association Manager');
    });

    test('General contractors', () => {
        expect(keys('<p>Subcontractors: join our bid list and complete prequalification for upcoming projects.</p>')).toEqual(
            expect.arrayContaining(['sub_bidding:subcontractors', 'sub_bidding:bid list', 'sub_bidding:prequalification']),
        );
        expect(roles('<p>Preconstruction Manager</p><p>Chief Estimator</p>')).toEqual(
            expect.arrayContaining(['Preconstruction Manager', 'Chief Estimator']),
        );
        const f = extractPage('<a href="https://app.buildingconnected.com/public/acme">Bid with us</a>', URL_);
        expect(f.bidPortalLinks.map((l) => l.value)).toEqual(['https://app.buildingconnected.com/public/acme']);
    });

    test('Developers / home builders', () => {
        expect(keys('<p>Now selling new homes. Our next infill townhomes project is under construction.</p>')).toEqual(
            expect.arrayContaining(['project_activity:now selling', 'project_activity:new homes', 'project_activity:townhomes', 'project_activity:under construction']),
        );
        expect(roles('<p>Director of Development</p>')).toContain('Director of Development');
    });

    test('Commercial real estate', () => {
        expect(keys('<p>Our 850,000 square feet portfolio includes a shopping center, a business park and tenant improvements.</p>')).toEqual(
            expect.arrayContaining(['commercial:shopping center', 'commercial:business park', 'remodel:tenant improvements']),
        );
        expect(roles('<p>Asset Manager</p>')).toContain('Asset Manager');
    });

    test('Public construction opportunities', () => {
        expect(keys('<p>Notice Inviting Bids: Request for Proposals for the Capital Improvement Program. Prevailing wage applies.</p>')).toEqual(
            expect.arrayContaining([
                'public_bid:notice inviting bids',
                'public_bid:request for proposals',
                'public_bid:capital improvement program',
                'public_bid:prevailing wage',
            ]),
        );
        expect(roles('<p>Director of Public Works</p>')).toContain('Director of Public Works');
        const f = extractPage('<a href="https://pbsystem.planetbids.com/portal/12345/bo/bo-search">Bid opportunities</a>', URL_);
        expect(f.bidPortalLinks.map((l) => l.value)).toEqual(['https://pbsystem.planetbids.com/portal/12345/bo/bo-search']);
    });

    test('Residential / homeowner', () => {
        expect(keys('<p>Upgrade your backyard: outdoor living packages, retaining wall and ADU options at our design studio.</p>')).toEqual(
            expect.arrayContaining(['residential:backyard', 'residential:outdoor living', 'residential:retaining wall', 'residential:ADU', 'residential:design studio']),
        );
    });

    test('follows the pages each segment publishes its information on', () => {
        for (const path of [
            '/communities',
            '/subcontractors',
            '/trade-partners',
            '/prequalification',
            '/developments',
            '/new-homes',
            '/leasing',
            '/listings',
            '/bids',
            '/bid-opportunities',
            '/rfps',
            '/procurement',
            '/purchasing',
            '/public-works',
            '/capital-projects',
            '/outdoor-living',
        ]) {
            expect(SUBPAGE_PATTERN.test(`https://prospect.example${path}`), path).toBe(true);
        }
        expect(SUBPAGE_PATTERN.test('https://prospect.example/blog/our-new-hire')).toBe(false);
    });
});
