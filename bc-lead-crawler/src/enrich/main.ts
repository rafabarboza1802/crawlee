import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { DEFAULT_SETTINGS } from '../crawl.js';
import { OpportunitySchema, type Opportunity } from '../discover/types.js';
import { accountIdFor, buildAccounts } from './accounts.js';
import { loadBuyerRegistry } from './buyers.js';
import { applyBuyerGate } from './gate.js';
import { permitHistory } from './research.js';
import { ApolloClient } from './apollo.js';
import { loadEnrichConfig } from './config.js';
import { executePlans } from './execute.js';
import { accountsSummary, applyResults, contactPlanToCsv, type ContactPlanRow, rowForExclusion, rowsForAccount } from './output.js';
import { estimate, planAccount } from './plan.js';
import { Ledger, loadCache, loadSuppression } from './store.js';

const { values } = parseArgs({
    options: {
        input: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        approve: { type: 'string' },
        limit: { type: 'string' },
        config: { type: 'string', default: 'enrich.config.json' },
        cache: { type: 'string', default: 'data/private/apollo-cache.json' },
        ledger: { type: 'string', default: 'data/apollo-ledger.json' },
        suppression: { type: 'string', default: 'suppression.txt' },
        registry: { type: 'string', default: 'buyer-registry.json' },
        'research-cache': { type: 'string', default: 'data/research-cache.json' },
        out: { type: 'string', default: 'output' },
    },
});

const usage =
    'Usage:\n' +
    '  npm run enrich -- --dry-run --input <opportunities.jsonl> [--limit N]     plan and estimate, no Apollo calls\n' +
    '  npm run enrich -- --approve <planId> --input <same file> [--limit N]      run exactly that plan (uses credits)';

if (!values.input || values['dry-run'] === (values.approve !== undefined)) {
    console.error(usage);
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
    const ledger = await Ledger.load(values.ledger);

    const { accounts, excluded } = buildAccounts(opportunities, config.minOpportunityScore, suppressed);

    // Buyer gate: classify every company before anything can reach Apollo (free public research only).
    const registry = await loadBuyerRegistry(values.registry);
    const researchCache = await loadCache(values['research-cache'], 30, now);
    const researchCtx = {
        userAgent: DEFAULT_SETTINGS.userAgent,
        robotsToken: DEFAULT_SETTINGS.robotsUserAgent,
        baseUrl: process.env.DISCOVER_BASE_URL || undefined,
        log: () => {},
    };
    const gate = await applyBuyerGate(accounts, registry, (license) => permitHistory(license, researchCtx, now), researchCache, now);
    gate.buyers.sort((a, b) => b.bestScore - a.bestScore);
    const perRun = Math.min(config.maxAccountsPerRun, values.limit ? Number(values.limit) : Infinity);
    const inRun = gate.buyers.slice(0, perRun).map((a) => planAccount(a, config, cache));
    const deferred = gate.buyers.slice(perRun).map((a) => planAccount(a, config, cache));
    const noCredits = (account: (typeof accounts)[number]) => ({ account, creditsExpected: 0 as const, creditsMax: 0 as const });
    const est = estimate(inRun, config, now);
    const spentThisMonth = ledger.creditsThisMonth(now);
    const capLeft = Math.max(0, est.monthlyCreditCap - spentThisMonth);

    let rows: ContactPlanRow[] = [
        ...inRun.flatMap((p) => rowsForAccount(p, 'awaiting_approval')),
        ...deferred.flatMap((p) => rowsForAccount(p, 'deferred_run_cap')),
        ...gate.blocked.flatMap((a) => rowsForAccount(noCredits(a), 'blocked_competitor')),
        ...gate.excluded.flatMap((a) => rowsForAccount(noCredits(a), 'do_not_enrich')),
        ...gate.review.flatMap((a) => rowsForAccount(noCredits(a), 'manual_review')),
        ...excluded.map(rowForExclusion),
    ].sort((a, b) => b.opportunity_score - a.opportunity_score);

    await mkdir(values.out, { recursive: true });
    const stamp = now.toISOString().slice(0, 10);
    const estimatePath = join(values.out, `enrich-estimate-${est.planId}.json`);

    if (values['dry-run']) {
        const csvPath = join(values.out, `contact-plan-${stamp}.csv`);
        const jsonlPath = join(values.out, `contact-plan-${stamp}.jsonl`);
        await writeFile(csvPath, contactPlanToCsv(rows));
        await writeFile(jsonlPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        await writeFile(estimatePath, JSON.stringify({ estimate: est, calls: inRun.flatMap((p) => p.calls) }, null, 2) + '\n');
        const reviewPath = join(values.out, `buyer-review-${stamp}.csv`);
        await writeFile(reviewPath, contactPlanToCsv(rows.filter((r) => ['manual_review', 'blocked_competitor', 'do_not_enrich'].includes(r.status))));

        const qualified = opportunities.filter((o) => o.score >= config.minOpportunityScore).length;
        console.log(`\nDRY RUN — no Apollo calls were made, no credits were used, nobody was contacted.\n`);
        console.log(`Opportunities scoring ≥ ${config.minOpportunityScore}: ${qualified}`);
        for (const [reason, n] of Object.entries(Object.groupBy(excluded, (e) => e.reason))) console.log(`  excluded before the gate (${n?.length}): ${reason}`);
        console.log(`\nBuyer gate (${accounts.length} companies): ${gate.buyers.length} buyer, ${gate.blocked.length} blocked, ${gate.excluded.length} do-not-enrich, ${gate.review.length} manual review`);
        console.log(`\nACCEPTED — buyers to look up${deferred.length ? ` (+${deferred.length} deferred to later runs)` : ''}:`);
        for (const line of accountsSummary(inRun)) console.log(`  ${line}`);
        for (const p of inRun) console.log(`       why: ${p.account.buyer!.reason}`);
        console.log(`\nBLOCKED — competitors / not buyers (0 credits):`);
        for (const a of gate.blocked) console.log(`  ${String(a.bestScore).padStart(3)}  ${a.displayName.padEnd(42)} ${a.buyer!.source.padEnd(15)} ${a.buyer!.reason}`);
        console.log(`\nDO NOT ENRICH — owner decision (0 credits):`);
        for (const a of gate.excluded) console.log(`  ${String(a.bestScore).padStart(3)}  ${a.displayName.padEnd(42)} ${a.buyer!.reason}`);
        console.log(`\nMANUAL REVIEW — uncertain, stopped before Apollo (0 credits):`);
        for (const a of gate.review) console.log(`  ${String(a.bestScore).padStart(3)}  ${a.displayName.padEnd(42)} ${a.buyer!.source.padEnd(15)} ${a.buyer!.reason}`);
        console.log(`\nEstimate ${est.planId}: ${est.calls} planned Apollo requests (${est.cachedCalls} cached)`);
        console.log(`  credits: ${est.creditsExpected} expected, ${est.creditsMax} maximum` + (est.usdExpected === null ? '' : ` ($${est.usdExpected}–$${est.usdMax})`));
        console.log(`  this month: ${spentThisMonth} spent, cap ${est.monthlyCreditCap} credits / $${est.monthlyBudgetUsd} → ${est.creditsMax <= capLeft ? 'within budget' : 'OVER BUDGET: approval would be refused'}`);
        for (const a of est.assumptions) console.log(`  · ${a}`);
        console.log(`\nWrote ${csvPath}\n      ${jsonlPath}\n      ${reviewPath} (blocked + manual review, with evidence)\n      ${estimatePath} (every planned request)`);
        console.log(`\nTo run exactly this plan (uses up to ${est.creditsMax} credits):\n  npm run enrich -- --approve ${est.planId} --input ${values.input}${values.limit ? ` --limit ${values.limit}` : ''}`);
        process.exit(0);
    }

    // --approve: refuse unless everything matches the reviewed dry run.
    if (values.approve !== est.planId) {
        throw new Error(`The plan changed since estimate ${values.approve} (now ${est.planId}). Run --dry-run again and review it.`);
    }
    await access(estimatePath).catch(() => {
        throw new Error(`No dry-run estimate file ${estimatePath}; run --dry-run first.`);
    });
    const apiKey = process.env.APOLLO_API_KEY?.trim();
    if (!apiKey) throw new Error('APOLLO_API_KEY is not set.');
    if (est.creditsMax > capLeft) {
        throw new Error(`Plan needs up to ${est.creditsMax} credits but only ${capLeft} remain under this month's cap.`);
    }

    console.log(`\nRunning approved plan ${est.planId}: ${inRun.length} companies, up to ${est.creditsMax} credits. Nobody is contacted.`);
    const results = await executePlans(inRun, config, new ApolloClient(apiKey, process.env.APOLLO_BASE_URL || undefined), cache, ledger, {
        planId: est.planId,
        approvedCredits: est.creditsMax,
        monthlyCreditCap: est.monthlyCreditCap,
        now,
        log: (m) => console.error(m),
    });
    rows = applyResults(rows, results);
    const csvPath = join(values.out, `contact-plan-${stamp}-enriched.csv`);
    const jsonlPath = join(values.out, `contact-plan-${stamp}-enriched.jsonl`);
    await writeFile(csvPath, contactPlanToCsv(rows));
    await writeFile(jsonlPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const used = results.reduce((s, r) => s + r.creditsSpent, 0);
    for (const [status, list] of Object.entries(Object.groupBy(results, (r) => r.status))) console.log(`  ${status}: ${list?.length}`);
    console.log(`\nCredits used (per configured costs): ${used} of ${est.creditsMax} approved; ${spentThisMonth + used} this month.`);
    console.log(`Wrote ${csvPath}\n      ${jsonlPath}\nNothing was sent to anyone.`);
} catch (error) {
    console.error(`Enrichment failed: ${(error as Error).message}`);
    process.exit(1);
}
