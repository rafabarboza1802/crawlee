import type { Prospect } from './schema.js';

/** Flat, human-review CSV. The JSONL file is the full contract for agency-agents. */
export function toCsv(rows: Prospect[]): string {
    const columns: [string, (p: Prospect) => string][] = [
        ['prospect_id', (p) => p.prospect_id],
        ['company_name', (p) => p.company_name ?? ''],
        ['website', (p) => p.website],
        ['segment_group', (p) => p.segment_group],
        ['segment_hint', (p) => p.segment_hint],
        ['crawl_status', (p) => p.crawl_status],
        ['phones', (p) => p.phones.map((e) => e.value).join(' ')],
        ['business_emails', (p) => p.business_emails.map((e) => e.value).join(' ')],
        ['contact_page', (p) => p.contact_page_urls[0] ?? ''],
        ['city', (p) => p.address?.city ?? ''],
        ['service_area', (p) => p.service_area_mentions.map((e) => e.value).join('; ')],
        ['public_roles', (p) => p.public_roles.map((e) => e.value).join('; ')],
        ['bid_portals', (p) => p.bid_portal_links.map((e) => e.value).join(' ')],
        ['signals', (p) => p.signals.map((s) => `${s.category}:${s.keyword}`).join('; ')],
    ];
    return [columns.map(([h]) => h).join(','), ...rows.map((p) => columns.map(([, get]) => csvCell(get(p))).join(','))].join('\n') + '\n';
}

/**
 * Quotes a CSV cell and neutralizes values that a spreadsheet would run as a formula
 * (scraped text is untrusted — e.g. a page title of `=HYPERLINK(...)`).
 */
export function csvCell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
