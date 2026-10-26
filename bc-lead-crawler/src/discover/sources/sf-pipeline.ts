import { SocrataClient, soqlString } from './socrata.js';
import type { SourceContext } from './source.js';

/**
 * San Francisco Development Pipeline (DataSF `6jgi-cpb4`, Planning Department, quarterly): names the project sponsor
 * (usually the developer) per parcel. Only business fields are requested — the `contact` (person) column never is.
 */
const BASE_URL = 'https://data.sf.gov';
const PIPELINE = '6jgi-cpb4';
const BATCH = 50;

export interface ProjectSponsor {
    parcel: string;
    sponsor: string;
    status?: string;
    units?: number;
    sourceUrl: string;
}

/** "1016/002" (permit parcel) → "1016002" (pipeline blklot). */
export const toBlklot = (parcel: string) => parcel.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

export async function sfPipelineSponsors(ctx: SourceContext, parcels: string[]): Promise<Map<string, ProjectSponsor>> {
    const base = ctx.baseUrl ?? BASE_URL;
    const client = new SocrataClient(base, ctx);
    const wanted = [...new Set(parcels.map(toBlklot).filter(Boolean))];
    const out = new Map<string, ProjectSponsor>();
    for (let i = 0; i < wanted.length; i += BATCH) {
        const rows = await client.query(PIPELINE, {
            $select: 'blklot,sponsor,current_status,new_pipeline_units',
            $where: `blklot in (${wanted.slice(i, i + BATCH).map(soqlString).join(',')}) AND sponsor IS NOT NULL`,
        });
        for (const r of rows) {
            const blklot = String(r.blklot ?? '').toUpperCase();
            const sponsor = String(r.sponsor ?? '').trim();
            if (!blklot || !sponsor || out.has(blklot)) continue;
            const url = new URL(`/resource/${PIPELINE}.json`, base);
            url.searchParams.set('blklot', blklot);
            url.searchParams.set('$select', 'blklot,sponsor,current_status,new_pipeline_units');
            out.set(blklot, {
                parcel: blklot,
                sponsor,
                ...(r.current_status ? { status: String(r.current_status) } : {}),
                ...(Number(r.new_pipeline_units) > 0 ? { units: Number(r.new_pipeline_units) } : {}),
                sourceUrl: url.href,
            });
        }
    }
    return out;
}
