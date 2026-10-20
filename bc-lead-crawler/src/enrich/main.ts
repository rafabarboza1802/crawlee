import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { OpportunitySchema, type Opportunity } from '../discover/types.js';
import { accountIdFor, buildAccounts } from './accounts.js';
import { loadEnrichConfig } from './config.js';
import { accountsSummary, contactPlanToCsv, rowForExclusion, rowsForAccount } from './output.js';
import { estimate, planAccount } from './plan.js';
import { loadCache, loadSuppression } from './store.js';

const { values } = parseArgs({
    options: {
        input: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        approve: { type: 'string' },
        config: { type: 'string', default: 'enrich.config.json' },
        cache: { type: 'string', default: 'output/enrich-cache.json' },
        suppression: { type: 'string', default: 'suppression.txt' },
        out: { type: 'string', default: 'output' },
    },
});

// This build plans paid lookups but cannot execute them: there is no code path that calls Apollo.
if (values.approve !== undefined || !values['dry-run']) {
    console.error(
        'Paid Apollo lookups are not enabled in this build. Run with --dry-run to see the plan and estimated credits.\n' +
            'Executing an approved estimate will be added only after the dry-run plan is reviewed and approved.',
    );
    process.exit(1);
}
if (!values.input) {
    console.error('Usage: npm run enrich -- --dry-run --input output/opportunities-<source>-<date>.jsonl');
    process.exit(1);
}

try {
    const now = new Date();
    const config = await loadEnrichConfig(values.config);
    const opportunities: Opportunity[] = (await readFile(values.input, 'utf8'))
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => OpportunitySchema.parse(JSON.parse(l)));
    const suppressed = await loadSuppression(values.suppression, accountIdFor);
    const cache = await loadCache(values.cache, config.cacheTtlDays, now);

    const { accounts, excluded } = buildAccounts(opportunities, config.minOpportunityScore, suppressed);
    accounts.sort((a, b) => b.bestScore - a.bestScore);
    const inRun = accounts.slice(0, config.maxAccountsPerRun).map((a) => planAccount(a, config, cache));
    const deferred = accounts.slice(config.maxAccountsPerRun).map((a) => planAccount(a, config, cache));
    const est = estimate(inRun, config, now);

    const rows = [
        ...inRun.flatMap((p) => rowsForAccount(p, 'awaiting_approval')),
        ...deferred.flatMap((p) => rowsForAccount(p, 'deferred_run_cap')),
        ...excluded.map(rowForExclusion),
    ].sort((a, b) => b.opportunity_score - a.opportunity_score);

    await mkdir(values.out, { recursive: true });
    const stamp = now.toISOString().slice(0, 10);
    const csvPath = join(values.out, `contact-plan-${stamp}.csv`);
    const jsonlPath = join(values.out, `contact-plan-${stamp}.jsonl`);
    const estimatePath = join(values.out, `enrich-estimate-${est.planId}.json`);
    await writeFile(csvPath, contactPlanToCsv(rows));
    await writeFile(jsonlPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await writeFile(estimatePath, JSON.stringify({ estimate: est, calls: inRun.flatMap((p) => p.calls) }, null, 2) + '\n');

    const qualified = opportunities.filter((o) => o.score >= config.minOpportunityScore).length;
    console.log(`\nDRY RUN — no Apollo calls were made, no credits were used, nobody was contacted.\n`);
    console.log(`Opportunities scoring ≥ ${config.minOpportunityScore}: ${qualified}`);
    console.log(`  companies to look up: ${inRun.length}${deferred.length ? ` (+${deferred.length} deferred by the ${config.maxAccountsPerRun}-company cap)` : ''}`);
    for (const [reason, n] of Object.entries(Object.groupBy(excluded, (e) => e.reason))) console.log(`  excluded (${n?.length}): ${reason}`);
    console.log(`\nCompanies (best opportunity score first):`);
    for (const line of accountsSummary(inRun)) console.log(`  ${line}`);
    console.log(`\nEstimate ${est.planId}: ${est.calls} planned Apollo requests (${est.cachedCalls} cached)`);
    console.log(`  credits: ${est.creditsExpected} expected, ${est.creditsMax} maximum` + (est.usdExpected === null ? '' : ` ($${est.usdExpected}–$${est.usdMax})`));
    console.log(`  monthly cap: ${est.monthlyCreditCap} credits / $${est.monthlyBudgetUsd} → ${est.withinBudget ? 'within budget' : 'OVER BUDGET: would be refused'}`);
    for (const a of est.assumptions) console.log(`  · ${a}`);
    console.log(`\nWrote ${csvPath}\n      ${jsonlPath}\n      ${estimatePath} (every planned request)`);
} catch (error) {
    console.error(`Dry run failed: ${(error as Error).message}`);
    process.exit(1);
}
