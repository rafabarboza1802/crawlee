import type { PermitContact } from '../businesses.js';
import type { NormalizedPermit, PermitStage } from '../types.js';
import { SchemaError, SocrataClient, soqlDate, soqlString } from './socrata.js';
import type { PermitSource, SourceContext } from './source.js';

/**
 * San Francisco Department of Building Inspection permits, published on DataSF (public domain, ODC-PDDL):
 * - Building Permits `i98e-djp9` — one row per permit, no people's names.
 * - Building Permits Contacts `3pee-9qhc` — contacts per permit; we request only permit_number, role,
 *   firm_name and license1, so personal name and address columns are never downloaded.
 */
/** DataSF moved from data.sfgov.org (which now redirects) to data.sf.gov in 2026. */
const BASE_URL = 'https://data.sf.gov';
const PERMITS = 'i98e-djp9';
const CONTACTS = '3pee-9qhc';
const CONTACT_FIELDS = ['permit_number', 'role', 'firm_name', 'license1'] as const;
/** Fields the normalizer cannot work without; checked on the first page of results. */
const REQUIRED_FIELDS = ['permit_number', 'description', 'status', 'filed_date'] as const;
const CONTACT_BATCH = 50;
const CONTACT_BATCH_DELAY_MS = 300;

const STAGES: [RegExp, PermitStage][] = [
    [/^(?:filed|filing|plan ?check|approved|triage)$/i, 'pre_construction'],
    [/^(?:issued|issuing|reinstated)$/i, 'issued'],
    [/^(?:suspend\w*|appeal|incomplete|on ?hold)$/i, 'stalled'],
    [/^(?:complete\w*|expired|cancel+ed|withdrawn|revoked|disapproved|denied|closed)$/i, 'inactive'],
];

export function sfStage(status: string | undefined): PermitStage {
    const s = (status ?? '').trim();
    return STAGES.find(([re]) => re.test(s))?.[1] ?? 'unknown';
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,]/g, '')) : NaN;
    return Number.isFinite(n) ? n : undefined;
};
const date = (v: unknown) => str(v)?.slice(0, 10);
const flag = (v: unknown) => v === true || (typeof v === 'string' && /^(?:y|yes|true|x)$/i.test(v.trim()));

function point(v: unknown): { latitude?: number; longitude?: number } {
    if (!v || typeof v !== 'object') return {};
    const o = v as { coordinates?: unknown[]; latitude?: unknown; longitude?: unknown };
    if (Array.isArray(o.coordinates)) return { longitude: num(o.coordinates[0]), latitude: num(o.coordinates[1]) };
    return { latitude: num(o.latitude), longitude: num(o.longitude) };
}

function permitUrl(baseUrl: string, permitNumber: string): string {
    const url = new URL(`/resource/${PERMITS}.json`, baseUrl);
    url.searchParams.set('permit_number', permitNumber);
    return url.href;
}

export function normalizeSfPermit(raw: Record<string, unknown>, baseUrl = BASE_URL): NormalizedPermit | undefined {
    const permitNumber = str(raw.permit_number);
    if (!permitNumber) return undefined;
    // Street address only: unit numbers are left out on purpose.
    const address = [raw.street_number, raw.street_number_suffix, raw.street_name, raw.street_suffix].map(str).filter(Boolean).join(' ') || undefined;
    const block = str(raw.block);
    const lot = str(raw.lot);
    return {
        sourceId: SF_SOURCE.id,
        permitNumber,
        permitType: str(raw.permit_type_definition),
        permitTypeCode: str(raw.permit_type),
        description: str(raw.description) ?? '',
        status: str(raw.status),
        stage: sfStage(str(raw.status)),
        statusDate: date(raw.status_date),
        filedDate: date(raw.filed_date),
        issuedDate: date(raw.issued_date),
        completedDate: date(raw.completed_date),
        expirationDate: date(raw.permit_expiration_date),
        estimatedCost: num(raw.estimated_cost),
        revisedCost: num(raw.revised_cost),
        existingUse: str(raw.existing_use),
        proposedUse: str(raw.proposed_use),
        existingUnits: num(raw.existing_units),
        proposedUnits: num(raw.proposed_units),
        proposedStories: num(raw.number_of_proposed_stories),
        address,
        city: SF_SOURCE.city,
        county: SF_SOURCE.county,
        zip: str(raw.zipcode),
        parcel: block && lot ? `${block}/${lot}` : undefined,
        neighborhood: str(raw.neighborhoods_analysis_boundaries),
        ...point(raw.location),
        softStoryRetrofit: flag(raw.voluntary_soft_story_retrofit) || undefined,
        sourceUrl: permitUrl(baseUrl, permitNumber),
    };
}

/** Throws a SchemaError listing the actual columns when required fields are missing. */
export function assertSfSchema(rows: Record<string, unknown>[]): void {
    if (rows.length === 0) return;
    const keys = new Set(rows.flatMap((r) => Object.keys(r)));
    const missing = REQUIRED_FIELDS.filter((f) => !keys.has(f));
    if (missing.length) {
        throw new SchemaError(`DataSF ${PERMITS} is missing expected field(s) ${missing.join(', ')}. Columns returned: ${[...keys].sort().join(', ')}`);
    }
}

export const SF_SOURCE: PermitSource = {
    id: 'sf-dbi',
    name: 'San Francisco DBI Building Permits (DataSF)',
    city: 'San Francisco',
    county: 'San Francisco',
    datasetUrl: `${BASE_URL}/d/${PERMITS}`,
    publishesContacts: true,

    normalize: (raw, ctx) => normalizeSfPermit(raw, ctx.baseUrl ?? BASE_URL),

    async fetchPermits(ctx, { since, maxRows }) {
        const client = new SocrataClient(ctx.baseUrl ?? BASE_URL, ctx);
        const rows = await client.query(
            PERMITS,
            {
                $where: `filed_date >= ${soqlDate(since)} OR status_date >= ${soqlDate(since)}`,
                $order: 'status_date DESC, permit_number ASC',
            },
            maxRows,
        );
        assertSfSchema(rows);
        return rows.map((r) => normalizeSfPermit(r, ctx.baseUrl ?? BASE_URL)).filter((p): p is NormalizedPermit => !!p);
    },

    async fetchContacts(ctx, permitNumbers) {
        const client = new SocrataClient(ctx.baseUrl ?? BASE_URL, ctx);
        const contacts: PermitContact[] = [];
        for (let i = 0; i < permitNumbers.length; i += CONTACT_BATCH) {
            if (i > 0) await new Promise((resolve) => setTimeout(resolve, CONTACT_BATCH_DELAY_MS));
            const batch = permitNumbers.slice(i, i + CONTACT_BATCH);
            const rows = await client.query(CONTACTS, {
                $select: CONTACT_FIELDS.join(','),
                $where: `permit_number in (${batch.map(soqlString).join(',')})`,
            });
            for (const r of rows) {
                const permitNumber = str(r.permit_number);
                if (permitNumber) contacts.push({ permitNumber, role: str(r.role), firmName: str(r.firm_name), license: str(r.license1) });
            }
        }
        return contacts;
    },

    contactsUrl(ctx: SourceContext, permitNumber: string) {
        const url = new URL(`/resource/${CONTACTS}.json`, ctx.baseUrl ?? BASE_URL);
        url.searchParams.set('$select', CONTACT_FIELDS.join(','));
        url.searchParams.set('permit_number', permitNumber);
        return url.href;
    },

    async probe(ctx) {
        const client = new SocrataClient(ctx.baseUrl ?? BASE_URL, ctx);
        return [
            { dataset: PERMITS, columns: await client.columns(PERMITS) },
            { dataset: CONTACTS, columns: await client.columns(CONTACTS) },
        ];
    },
};
