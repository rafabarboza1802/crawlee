import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { crawlSites, DEFAULT_SETTINGS } from './crawl.js';
import type { Prospect } from './schema.js';
import { loadSeeds } from './seeds.js';

const { values } = parseArgs({
    options: {
        seeds: { type: 'string', default: 'seeds/seeds.csv' },
        out: { type: 'string', default: 'output' },
        'max-pages': { type: 'string' },
    },
});

const seeds = await loadSeeds(values.seeds);
if (seeds.length === 0) {
    console.error(`No seeds found in ${values.seeds}.`);
    process.exit(1);
}

const prospects = await crawlSites(seeds, {
    ...DEFAULT_SETTINGS,
    ...(values['max-pages'] ? { maxPagesPerSite: Number(values['max-pages']) } : {}),
});

const stamp = new Date().toISOString().slice(0, 10);
await mkdir(values.out, { recursive: true });
const jsonlPath = join(values.out, `prospects-${stamp}.jsonl`);
const csvPath = join(values.out, `prospects-${stamp}.csv`);
await writeFile(jsonlPath, prospects.map((p) => JSON.stringify(p)).join('\n') + '\n');
await writeFile(csvPath, toCsv(prospects));

const byStatus = Object.groupBy(prospects, (p) => p.crawl_status);
console.log(`\nWrote ${prospects.length} prospect(s) to ${jsonlPath} (review copy: ${csvPath})`);
for (const [status, list] of Object.entries(byStatus)) console.log(`  ${status}: ${list?.length ?? 0}`);

/** Flat, human-review CSV. The JSONL file is the full contract for agency-agents. */
function toCsv(rows: Prospect[]): string {
    const columns: [string, (p: Prospect) => string][] = [
        ['prospect_id', (p) => p.prospect_id],
        ['company_name', (p) => p.company_name ?? ''],
        ['website', (p) => p.website],
        ['segment_hint', (p) => p.segment_hint],
        ['crawl_status', (p) => p.crawl_status],
        ['phones', (p) => p.phones.map((e) => e.value).join(' ')],
        ['business_emails', (p) => p.business_emails.map((e) => e.value).join(' ')],
        ['contact_page', (p) => p.contact_page_urls[0] ?? ''],
        ['city', (p) => p.address?.city ?? ''],
        ['service_area', (p) => p.service_area_mentions.map((e) => e.value).join('; ')],
        ['public_roles', (p) => p.public_roles.map((e) => e.value).join('; ')],
        ['signals', (p) => p.signals.map((s) => `${s.category}:${s.keyword}`).join('; ')],
    ];
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return [columns.map(([h]) => h).join(','), ...rows.map((p) => columns.map(([, get]) => cell(get(p))).join(','))].join('\n') + '\n';
}
