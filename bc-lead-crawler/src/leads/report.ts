import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { csvCell } from '../output.js';
import { accountIdFor } from '../enrich/accounts.js';
import type { BuyerRegistry } from '../enrich/buyers.js';
import type { LedgerEntry } from '../enrich/store.js';
import type { LeadDatabase } from './db.js';
import type { ContactBatch } from './pipeline.js';
import { isActive, rankLeads } from './pipeline.js';
import type { CompanyRecord, ContactRecord, LeadRecord } from './types.js';
import { STATUS_MEANING } from './types.js';

type Column<T> = [string, (row: T) => string | number | null | undefined];

function toCsv<T>(rows: T[], columns: Column<T>[]): string {
    const lines = rows.map((r) => columns.map(([, get]) => csvCell(String(get(r) ?? ''))).join(','));
    return [columns.map(([h]) => h).join(','), ...lines].join('\n') + '\n';
}

export const money = (v: number | null | undefined) => (v == null ? '' : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`);

const LEAD_COLUMNS: Column<LeadRecord>[] = [
    ['status', (l) => l.status],
    ['score', (l) => l.project.score],
    ['project_name', (l) => l.project.name],
    ['project_address', (l) => l.project.address],
    ['city', (l) => l.project.city],
    ['county', (l) => l.project.county],
    ['priority_area', (l) => (l.project.priority_area ? 'yes' : 'no')],
    ['project_type', (l) => l.project.project_type],
    ['estimated_value', (l) => l.project.estimated_value],
    ['permit_number', (l) => l.project.permit_number],
    ['permit_status', (l) => l.project.permit_status],
    ['project_stage', (l) => l.project.project_stage],
    ['bid_timing', (l) => l.project.bid_timing],
    ['target_scope', (l) => l.project.target_scopes.join('; ')],
    ['general_contractor', (l) => l.project.general_contractor],
    ['gc_license', (l) => l.project.gc_license],
    ['developer_owner', (l) => l.project.developer_owner],
    ['why_it_qualifies', (l) => l.project.qualifies_because],
    ['status_reason', (l) => l.status_reason],
    ['evidence_url', (l) => l.project.evidence_url],
    ['description', (l) => l.project.description.slice(0, 300)],
    ['first_seen', (l) => l.first_seen_at.slice(0, 10)],
    ['last_seen', (l) => l.last_seen_at.slice(0, 10)],
    ['lead_id', (l) => l.lead_id],
];

const companyLeads = (db: LeadDatabase, c: CompanyRecord) => rankLeads(db.leads.filter((l) => l.company_id === c.company_id));

function companyColumns(db: LeadDatabase): Column<CompanyRecord>[] {
    return [
        ['company', (c) => c.name],
        ['classification', (c) => c.classification],
        ['license', (c) => c.license],
        ['reason', (c) => c.reason],
        ['evidence', (c) => c.evidence.join(' | ')],
        ['decided_by', (c) => c.source],
        ['competitor_risk_word', (c) => c.risk_signal],
        ['best_score', (c) => companyLeads(db, c)[0]?.project.score],
        ['best_project', (c) => companyLeads(db, c)[0]?.project.name],
        ['best_project_value', (c) => companyLeads(db, c)[0]?.project.estimated_value],
        ['leads', (c) => companyLeads(db, c).length],
        ['last_classified', (c) => c.last_classified_at.slice(0, 10)],
    ];
}

export interface ReportInput {
    db: LeadDatabase;
    registry: BuyerRegistry;
    batch: ContactBatch;
    ledger: LedgerEntry[];
    creditsThisMonth: number;
    now: Date;
    summary: string;
}

/** Writes the standard reports (public business data only) and returns their paths. */
export async function writeReports(dir: string, input: ReportInput): Promise<string[]> {
    const { db, registry, batch, now } = input;
    await mkdir(dir, { recursive: true });
    const files: [string, string][] = [];
    const active = rankLeads(db.leads.filter(isActive));

    files.push(['qualified-opportunities.csv', toCsv(active, LEAD_COLUMNS)]);

    // Approved buyers: every registry buyer, plus their leads and lookup status.
    const buyerRows = registry.companies
        .filter((c) => c.classification === 'buyer')
        .map((c) => {
            const record = db.company(accountIdFor(c.name));
            const leads = record ? companyLeads(db, record).filter(isActive) : [];
            return { c, record, leads };
        });
    files.push([
        'approved-buyers.csv',
        toCsv(buyerRows, [
            ['company', (r) => r.c.name],
            ['website', (r) => r.c.website],
            ['why_approved', (r) => r.c.reason],
            ['best_scope_for_best_construction', (r) => r.c.scope],
            ['evidence', (r) => r.c.evidence.join(' | ')],
            ['open_leads', (r) => r.leads.length],
            ['best_current_project', (r) => r.leads[0]?.project.name],
            ['best_project_value', (r) => r.leads[0]?.project.estimated_value],
            ['contact_lookup', (r) => (r.record?.enrichment ? `${r.record.enrichment.status} ${r.record.enrichment.at.slice(0, 10)}` : 'not done')],
            ['decided', (r) => r.c.decided],
        ]),
    ]);

    files.push([
        'contacts-awaiting-enrichment.csv',
        toCsv(
            [...batch.plans.map((p) => ({ p, deferred: false })), ...batch.deferred.map((p) => ({ p, deferred: true }))],
            [
                ['company', (r) => r.p.account.displayName],
                ['apollo_search_name', (r) => r.p.account.searchName],
                ['leads', (r) => r.p.account.opportunities.length],
                ['best_score', (r) => r.p.account.bestScore],
                ['best_project', (r) => r.p.account.opportunities[0]?.location.address],
                ['titles_to_find', (r) => r.p.calls.find((c) => c.step === 2)?.body.person_titles?.toString().replace(/,/g, '; ')],
                ['credits_expected', (r) => r.p.creditsExpected],
                ['credits_max', (r) => r.p.creditsMax],
                ['in_this_batch', (r) => (r.deferred ? 'next batch (run cap)' : 'yes')],
            ],
        ),
    ]);

    const cols = companyColumns(db);
    const blocked = db.companies.filter((c) => ['competitor', 'not_target', 'do_not_enrich'].includes(c.classification));
    files.push(['rejected-competitors.csv', toCsv(blocked.sort((a, b) => a.classification.localeCompare(b.classification) || a.name.localeCompare(b.name)), cols)]);
    const review = db.companies.filter((c) => c.classification === 'uncertain').sort((a, b) => (companyLeads(db, b)[0]?.project.score ?? 0) - (companyLeads(db, a)[0]?.project.score ?? 0));
    files.push(['manual-review.csv', toCsv(review, cols)]);

    const month = now.toISOString().slice(0, 7);
    files.push([
        'apollo-ledger.csv',
        toCsv(input.ledger, [
            ['at', (e) => e.at],
            ['month', (e) => e.at.slice(0, 7)],
            ['plan_id', (e) => e.plan_id],
            ['company_id', (e) => e.account_id],
            ['endpoint', (e) => e.endpoint],
            ['credits', (e) => e.credits],
            ['http_status', (e) => e.status],
        ]) + `# ${month}: ${input.creditsThisMonth} credits used\n`,
    ]);

    files.push(['summary.md', input.summary]);
    files.push([
        'statuses.md',
        `# Lead statuses\n\n| Status | Meaning |\n|---|---|\n${Object.entries(STATUS_MEANING)
            .map(([s, m]) => `| ${s} | ${m} |`)
            .join('\n')}\n`,
    ]);

    for (const [name, content] of files) await writeFile(join(dir, name), content);
    return files.map(([name]) => join(dir, name));
}

/** Purchased contacts: private folder only (never committed). */
export async function writeContactsReport(dir: string, contacts: ContactRecord[], db: LeadDatabase): Promise<string> {
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'contacts.csv');
    const bestLead = (c: ContactRecord) => rankLeads(db.leads.filter((l) => l.company_id === c.company_id && isActive(l)))[0];
    await writeFile(
        path,
        toCsv(
            [...contacts].sort((a, b) => Number(b.verified) - Number(a.verified)),
            [
                ['verified', (c) => (c.verified ? 'yes' : 'no')],
                ['company', (c) => c.company_name],
                ['name', (c) => c.name],
                ['title', (c) => c.title],
                ['role', (c) => c.role_category],
                ['business_email', (c) => c.business_email],
                ['company_phone', (c) => c.company_phone],
                ['company_website', (c) => c.company_website],
                ['linkedin_url', (c) => c.linkedin_url],
                ['verify_notes', (c) => c.verify_notes.join('; ')],
                ['best_project', (c) => bestLead(c)?.project.name],
                ['best_project_score', (c) => bestLead(c)?.project.score],
                ['found_at', (c) => c.found_at.slice(0, 10)],
            ],
        ),
    );
    return path;
}
