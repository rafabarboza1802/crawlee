import type { Business, Opportunity } from '../../src/discover/types.js';
import { BuyerRegistrySchema } from '../../src/enrich/buyers.js';
import type { PermitHistory } from '../../src/enrich/research.js';

export const NOW = new Date('2026-10-23T12:00:00Z');

let n = 0;
/** A qualified-looking SF opportunity; override anything. */
export function opp(overrides: Partial<Opportunity> & { contractor?: string; license?: string; businesses?: Business[] } = {}): Opportunity {
    n++;
    const { contractor, license, ...rest } = overrides;
    const businesses: Business[] =
        overrides.businesses ?? (contractor ? [{ role: 'contractor', name: contractor, license, source_url: 'https://data.sf.gov/x' }] : []);
    return {
        schema_version: 1,
        opportunity_id: `sf-dbi:test/${n}`,
        source: { id: 'sf-dbi', name: 'SF', dataset_url: 'https://data.sf.gov/d/i98e-djp9', record_url: `https://data.sf.gov/resource/i98e-djp9.json?permit_number=${n}` },
        jurisdiction: { city: 'San Francisco', county: 'San Francisco', state: 'CA' },
        location: { address: `${n} Example St` },
        permit: { number: String(n), type: 'new construction', status: 'filed', stage: 'pre_construction', status_date: '2026-10-15' },
        project_description: 'to erect 6 stories, 120 units, excavation and site work',
        estimated_value: 40_000_000,
        value_basis: 'estimated_cost',
        proposed_units: 120,
        services: [
            { service: 'site_work', evidence: ['site work'] },
            { service: 'excavation', evidence: ['excavation'] },
            { service: 'general_construction', evidence: ['erect'] },
        ],
        lead_segment: 'general_contractor',
        segment_reason: '',
        contact_policy: 'approach_named_businesses',
        score: 90,
        score_band: 'high',
        score_reasons: [],
        score_summary: '90/100 (high): matches site work',
        related_permits: [],
        is_new: true,
        first_seen_at: NOW.toISOString(),
        discovered_at: NOW.toISOString(),
        ...rest,
        businesses,
    };
}

export const registry = BuyerRegistrySchema.parse({
    version: 1,
    companies: [
        { name: 'Cahill Contractors', classification: 'buyer', reason: 'Trade portal; bids out sitework.', scope: 'site demolition, excavation', evidence: ['trade portal'] },
        { name: 'Nibbi Brothers', classification: 'buyer', aliases: ['nibbi brothers'], reason: 'Solicits sitework sub bids.', evidence: ['bid notice'] },
        { name: 'Bay Cities Paving & Grading', classification: 'competitor', aliases: ['bay cities paving'], reason: 'Self-performs paving.' },
    ],
    jointVentures: [{ name: 'Cahill Guzman Construction Group JV', aliases: ['cahill guzman'], managingGc: 'Cahill Contractors' }],
    competitorRiskPatterns: ['paving', 'demolition', 'grading'],
});

export const history = (overrides: Partial<PermitHistory> = {}): PermitHistory => ({
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
