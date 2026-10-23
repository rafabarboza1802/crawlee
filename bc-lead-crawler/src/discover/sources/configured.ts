import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { PermitContact } from '../businesses.js';
import type { NormalizedPermit } from '../types.js';
import { sfStage } from './sf.js';
import { SchemaError, SocrataClient, soqlDate } from './socrata.js';
import type { PermitSource } from './source.js';

/**
 * A Socrata permit dataset described in `sources.config.json`, so a new city or county can be added without code:
 * set the portal, dataset id and the column names, run `npm run discover -- --source <id> --probe` to check them,
 * then set `enabled: true` and add the id to `sources` in leads.config.json.
 */
const Column = z.string().min(1);
export const ConfiguredSourceSchema = z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    city: z.string(),
    county: z.string(),
    enabled: z.boolean().default(false),
    baseUrl: z.url(),
    /** Socrata dataset id ("abcd-1234"). */
    permitsDataset: z.string().regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/),
    /** Date columns used to select recent permits (any of them on/after the look-back date). */
    dateColumns: z.array(Column).min(1),
    fields: z.object({
        permitNumber: Column,
        description: Column,
        status: Column.optional(),
        permitType: Column.optional(),
        filedDate: Column.optional(),
        issuedDate: Column.optional(),
        statusDate: Column.optional(),
        expirationDate: Column.optional(),
        estimatedCost: Column.optional(),
        /** One column, or several joined with spaces (street number, name, suffix). */
        address: z.union([Column, z.array(Column)]).optional(),
        /** For county-wide datasets: the column holding the city. */
        city: Column.optional(),
        zip: Column.optional(),
        parcel: Column.optional(),
        proposedUse: Column.optional(),
        proposedUnits: Column.optional(),
        latitude: Column.optional(),
        longitude: Column.optional(),
        /** Contractor business name and licence, when published in the permit row. Never a person's name. */
        contractorName: Column.optional(),
        contractorLicense: Column.optional(),
    }),
});
export type ConfiguredSource = z.infer<typeof ConfiguredSourceSchema>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,]/g, '')) : NaN;
    return Number.isFinite(n) ? n : undefined;
};
const date = (v: unknown) => str(v)?.slice(0, 10);

export function createConfiguredSource(config: ConfiguredSource): PermitSource {
    const f = config.fields;
    const datasetUrl = new URL(`/d/${config.permitsDataset}`, config.baseUrl).href;
    // Contractors published in the permit rows, remembered from the last fetch for fetchContacts.
    const contractors = new Map<string, PermitContact>();

    const recordUrl = (base: string, permitNumber: string) => {
        const url = new URL(`/resource/${config.permitsDataset}.json`, base);
        url.searchParams.set(f.permitNumber, permitNumber);
        return url.href;
    };

    const normalize = (raw: Record<string, unknown>, base = config.baseUrl): NormalizedPermit | undefined => {
        const permitNumber = str(raw[f.permitNumber]);
        if (!permitNumber) return undefined;
        const at = (column?: string) => (column ? raw[column] : undefined);
        const address = (Array.isArray(f.address) ? f.address : f.address ? [f.address] : []).map((c) => str(raw[c])).filter(Boolean).join(' ') || undefined;
        const status = str(at(f.status));
        return {
            sourceId: config.id,
            permitNumber,
            permitType: str(at(f.permitType)),
            description: str(at(f.description)) ?? '',
            status,
            stage: sfStage(status),
            statusDate: date(at(f.statusDate)),
            filedDate: date(at(f.filedDate)),
            issuedDate: date(at(f.issuedDate)),
            expirationDate: date(at(f.expirationDate)),
            estimatedCost: num(at(f.estimatedCost)),
            proposedUse: str(at(f.proposedUse)),
            proposedUnits: num(at(f.proposedUnits)),
            address,
            city: str(at(f.city)) ?? config.city,
            county: config.county,
            zip: str(at(f.zip)),
            parcel: str(at(f.parcel)),
            latitude: num(at(f.latitude)),
            longitude: num(at(f.longitude)),
            sourceUrl: recordUrl(base, permitNumber),
        };
    };

    return {
        id: config.id,
        name: config.name,
        city: config.city,
        county: config.county,
        datasetUrl,
        publishesContacts: !!f.contractorName,
        normalize: (raw, ctx) => normalize(raw, ctx.baseUrl ?? config.baseUrl),

        async fetchPermits(ctx, { since, maxRows }) {
            const base = ctx.baseUrl ?? config.baseUrl;
            const client = new SocrataClient(base, ctx);
            const where = config.dateColumns.map((c) => `${c} >= ${soqlDate(since)}`).join(' OR ');
            const rows = await client.query(config.permitsDataset, { $where: where, $order: `${config.dateColumns[0]} DESC` }, maxRows);
            if (rows.length) {
                const keys = new Set(rows.flatMap((r) => Object.keys(r)));
                const missing = [f.permitNumber, f.description].filter((c) => !keys.has(c));
                if (missing.length) throw new SchemaError(`${config.name}: column(s) ${missing.join(', ')} not found. Columns returned: ${[...keys].sort().join(', ')}`);
            }
            contractors.clear();
            for (const r of rows) {
                const permitNumber = str(r[f.permitNumber]);
                const firmName = f.contractorName ? str(r[f.contractorName]) : undefined;
                if (permitNumber && firmName) contractors.set(permitNumber, { permitNumber, role: 'contractor', firmName, license: f.contractorLicense ? str(r[f.contractorLicense]) : undefined });
            }
            return rows.map((r) => normalize(r, base)).filter((p): p is NormalizedPermit => !!p);
        },

        async fetchContacts(_ctx, permitNumbers) {
            return permitNumbers.map((n) => contractors.get(n)).filter((c): c is PermitContact => !!c);
        },

        async probe(ctx) {
            const client = new SocrataClient(ctx.baseUrl ?? config.baseUrl, ctx);
            return [{ dataset: config.permitsDataset, columns: await client.columns(config.permitsDataset) }];
        },
    };
}

const SourcesFileSchema = z.object({ sources: z.array(ConfiguredSourceSchema).default([]) });

/** Reads sources.config.json (missing file = no extra sources). */
export async function loadConfiguredSources(path: string): Promise<ConfiguredSource[]> {
    try {
        return SourcesFileSchema.parse(JSON.parse(await readFile(path, 'utf8'))).sources;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}
