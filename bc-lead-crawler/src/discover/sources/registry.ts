import { SF_SOURCE } from './sf.js';
import type { PermitSource } from './source.js';

export interface Jurisdiction {
    id: string;
    county: string;
    status: 'active' | 'planned';
    source?: PermitSource;
    /** What to verify before implementing a planned jurisdiction. */
    notes?: string;
}

const PLANNED_NOTES =
    'Find the official building-permit dataset (city/county open-data portal: Socrata, ArcGIS Hub or CKAN). Only use public, ' +
    'unauthenticated endpoints. For Socrata, copy sources/sf.ts and adjust the dataset IDs and field mapping; run --probe first. ' +
    'Accela/eTRAKiT permit portals without an open-data export are out of scope (no scraping behind search forms or logins).';

/**
 * Jurisdictions in Best Construction's service area. Only verified sources are active; dataset IDs for planned
 * jurisdictions are intentionally not guessed.
 */
export const JURISDICTIONS: Jurisdiction[] = [
    { id: SF_SOURCE.id, county: 'San Francisco', status: 'active', source: SF_SOURCE },
    { id: 'contra-costa', county: 'Contra Costa', status: 'planned', notes: PLANNED_NOTES },
    { id: 'alameda', county: 'Alameda', status: 'planned', notes: PLANNED_NOTES },
    { id: 'san-mateo', county: 'San Mateo', status: 'planned', notes: PLANNED_NOTES },
    { id: 'santa-clara', county: 'Santa Clara', status: 'planned', notes: PLANNED_NOTES },
    { id: 'marin', county: 'Marin', status: 'planned', notes: PLANNED_NOTES },
    { id: 'solano', county: 'Solano', status: 'planned', notes: PLANNED_NOTES },
    { id: 'sonoma', county: 'Sonoma', status: 'planned', notes: PLANNED_NOTES },
    { id: 'napa', county: 'Napa', status: 'planned', notes: PLANNED_NOTES },
];

export function getSource(id: string): PermitSource {
    const j = JURISDICTIONS.find((x) => x.id === id);
    if (!j) throw new Error(`Unknown source "${id}". Known: ${JURISDICTIONS.map((x) => x.id).join(', ')}`);
    if (!j.source) throw new Error(`Source "${id}" (${j.county} County) is planned but not implemented yet. ${j.notes ?? ''}`);
    return j.source;
}
