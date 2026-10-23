import { SocrataClient, soqlString } from '../discover/sources/socrata.js';
import type { SourceContext } from '../discover/sources/source.js';
import { RESEARCH_RULES } from './buyers.js';

/** A company's own San Francisco permits (public DataSF records), summarized for buyer classification. */
export interface PermitHistory {
    license: string;
    since: string;
    permits: number;
    newBuildings: number;
    totalValue: number;
    largestValue: number;
    /** Stand-alone demolition / grading / excavation / paving permits. */
    specialistPermits: number;
    examples: string[];
}

const PERMITS = 'i98e-djp9';
const CONTACTS = '3pee-9qhc';
const SPECIALIST_TYPE = /demolition|grade or quarry|excavate/i;
const SPECIALIST_DESC = /^\W*(?:to\s+)?(?:demo\w*|grading|excavat\w*|paving|repave|shoring|site\s?work)\b/i;

const num = (v: unknown) => {
    const n = Number(String(v ?? '').replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : 0;
};

/**
 * Looks up permits where the licence holder is the contractor. Requests only permit numbers, roles and permit facts —
 * no personal fields. Free (public data); never touches Apollo.
 */
export async function permitHistory(license: string, ctx: SourceContext, now: Date): Promise<PermitHistory> {
    const client = new SocrataClient(ctx.baseUrl ?? 'https://data.sf.gov', ctx, { pageDelayMs: 300 });
    const contacts = await client.query(CONTACTS, { $select: 'permit_number,role', $where: `license1=${soqlString(license)}` }, 2000);
    const numbers = [...new Set(contacts.filter((c) => /contractor/i.test(String(c.role ?? ''))).map((c) => String(c.permit_number)))];
    const since = new Date(now.getTime() - RESEARCH_RULES.years * 365 * 86_400_000).toISOString().slice(0, 10);

    const permits = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < numbers.length && i < 500; i += 50) {
        const batch = numbers.slice(i, i + 50);
        const rows = await client.query(PERMITS, {
            $select: 'permit_number,permit_type_definition,estimated_cost,revised_cost,filed_date,description',
            $where: `permit_number in (${batch.map(soqlString).join(',')})`,
        });
        for (const r of rows) if (String(r.filed_date ?? '') >= since) permits.set(String(r.permit_number), r);
    }

    const list = [...permits.values()];
    const value = (r: Record<string, unknown>) => Math.max(num(r.revised_cost), num(r.estimated_cost));
    const specialist = list.filter((r) => SPECIALIST_TYPE.test(String(r.permit_type_definition ?? '')) || SPECIALIST_DESC.test(String(r.description ?? '')));
    const largest = [...list].sort((a, b) => value(b) - value(a));
    return {
        license,
        since,
        permits: list.length,
        newBuildings: list.filter((r) => /new construction/i.test(String(r.permit_type_definition ?? ''))).length,
        totalValue: list.reduce((s, r) => s + value(r), 0),
        largestValue: largest[0] ? value(largest[0]) : 0,
        specialistPermits: specialist.length,
        examples: [...largest.slice(0, 2), ...specialist.slice(0, 2)].map(
            (r) => `${r.permit_number} ${r.permit_type_definition ?? ''} $${Math.round(value(r)).toLocaleString('en-US')}: ${String(r.description ?? '').slice(0, 90)}`,
        ),
    };
}
