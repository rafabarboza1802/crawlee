import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { DEFAULT_SETTINGS } from '../crawl.js';
import { discover } from './discover.js';
import { opportunitiesToCsv } from './output.js';
import { findSource, JURISDICTIONS } from './sources/registry.js';
import type { SourceContext } from './sources/source.js';
import { loadState, saveState, updateState } from './state.js';
import type { NormalizedPermit } from './types.js';

const { values } = parseArgs({
    options: {
        source: { type: 'string', default: 'sf-dbi' },
        days: { type: 'string', default: '30' },
        'min-score': { type: 'string', default: '40' },
        'max-rows': { type: 'string', default: '5000' },
        out: { type: 'string', default: 'output' },
        state: { type: 'string', default: 'output/discovery-state.json' },
        'include-inactive': { type: 'boolean', default: false },
        'no-contacts': { type: 'boolean', default: false },
        'from-file': { type: 'string' },
        probe: { type: 'boolean', default: false },
        'list-sources': { type: 'boolean', default: false },
    },
});

if (values['list-sources']) {
    for (const j of JURISDICTIONS) console.log(`${j.id.padEnd(14)} ${j.county.padEnd(15)} ${j.status}${j.source ? `  ${j.source.datasetUrl}` : ''}`);
    process.exit(0);
}

const ctx: SourceContext = {
    userAgent: DEFAULT_SETTINGS.userAgent,
    robotsToken: DEFAULT_SETTINGS.robotsUserAgent,
    appToken: process.env.SOCRATA_APP_TOKEN || undefined,
    baseUrl: process.env.DISCOVER_BASE_URL || undefined,
    log: (m) => console.error(m),
};

try {
    const source = await findSource(values.source, 'sources.config.json', values.probe);
    if (values.probe) {
        if (!source.probe) throw new Error(`Source ${source.id} does not support --probe.`);
        for (const { dataset, columns } of await source.probe(ctx)) console.log(`${dataset}: ${columns.join(', ')}`);
        process.exit(0);
    }

    let permits: NormalizedPermit[] | undefined;
    if (values['from-file']) {
        // Offline: a JSON array saved from the source API (e.g. opened in a browser and saved).
        const rows = JSON.parse(await readFile(values['from-file'], 'utf8')) as Record<string, unknown>[];
        if (!Array.isArray(rows)) throw new Error('--from-file must contain a JSON array of records.');
        permits = rows.map((r) => source.normalize(r, ctx)).filter((p): p is NormalizedPermit => !!p);
    }

    const state = await loadState(values.state);
    const result = await discover({
        source,
        ctx,
        days: Number(values.days),
        minScore: Number(values['min-score']),
        maxRows: Number(values['max-rows']),
        includeInactive: values['include-inactive'],
        skipContacts: values['no-contacts'] || !!values['from-file'],
        permits,
        state,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    await mkdir(values.out, { recursive: true });
    const jsonl = join(values.out, `opportunities-${source.id}-${stamp}.jsonl`);
    const csv = join(values.out, `opportunities-${source.id}-${stamp}.csv`);
    await writeFile(jsonl, result.opportunities.map((o) => JSON.stringify(o)).join('\n') + (result.opportunities.length ? '\n' : ''));
    await writeFile(csv, opportunitiesToCsv(result.opportunities));
    await saveState(values.state, updateState(state, result.opportunities));

    const s = result.stats;
    console.log(`\n${source.name}: last ${values.days} day(s)`);
    console.log(`  permits fetched ${s.fetched} · duplicates ${s.duplicates} · inactive ${s.inactive} · relevant ${s.relevant}`);
    for (const [reason, n] of Object.entries(s.excluded)) console.log(`  excluded: ${reason} ${n}`);
    console.log(`  opportunities ${s.opportunities} (${s.newOpportunities} new) · below min score ${s.belowMinScore}`);
    for (const w of result.warnings) console.log(`  WARNING: ${w}`);
    console.log(`\nTop opportunities:`);
    for (const o of result.opportunities.slice(0, 10)) {
        console.log(`  ${String(o.score).padStart(3)} ${o.is_new ? 'NEW ' : '    '}${o.lead_segment.padEnd(22)} ${o.location.address ?? o.permit.number} — ${o.score_summary}`);
    }
    console.log(`\nWrote ${jsonl}\n      ${csv}\nNothing was sent to anyone: review the CSV, then hand the JSONL to agency-agents.`);
} catch (error) {
    console.error(`Discovery failed: ${(error as Error).message}`);
    process.exit(1);
}
