import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { crawlSites, DEFAULT_SETTINGS } from './crawl.js';
import { toCsv } from './output.js';
import { loadSeeds } from './seeds.js';

const { values } = parseArgs({
    options: {
        seeds: { type: 'string', default: 'seeds/seeds.csv' },
        out: { type: 'string', default: 'output' },
        'max-pages': { type: 'string' },
    },
});

const seeds = await loadSeeds(values.seeds).catch((error: Error) => {
    console.error(`Could not load seeds from ${values.seeds}: ${error.message}`);
    process.exit(1);
});
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
