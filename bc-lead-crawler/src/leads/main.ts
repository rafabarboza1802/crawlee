import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { ApolloClient } from '../enrich/apollo.js';
import { executePlans } from '../enrich/execute.js';
import { permitHistory } from '../enrich/research.js';
import { recordEnrichment } from './contacts.js';
import { type ContactBatch, type EvaluateResult, evaluateOpportunities, isActive, planContactBatch, rankLeads } from './pipeline.js';
import { money, writeContactsReport, writeReports } from './report.js';
import { LEAD_STATUSES, type LeadRecord, type LeadStatus, STATUS_MEANING } from './types.js';
import { discoverAll as discoverWorkspace, exists, loadWorkspace, sourceContext, type Workspace, type WorkspaceOptions } from './workspace.js';

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        input: { type: 'string' },
        reuse: { type: 'boolean', default: false },
        days: { type: 'string' },
        approve: { type: 'string' },
        limit: { type: 'string' },
        note: { type: 'string' },
        data: { type: 'string', default: 'data' },
        settings: { type: 'string', default: 'leads.config.json' },
        registry: { type: 'string', default: 'buyer-registry.json' },
        config: { type: 'string', default: 'enrich.config.json' },
        sources: { type: 'string', default: 'sources.config.json' },
        suppression: { type: 'string', default: 'suppression.txt' },
    },
});

const USAGE = `Usage:
  npm run find-leads                        discover, research and rank new leads (free; never calls Apollo)
  npm run prepare-contacts                  show the exact Apollo credits for today's qualified buyers (free)
  npm run prepare-contacts -- --approve ID  buy exactly that batch (uses credits)
  npm run lead-status -- <lead|company> <STATUS|AUTO> [--note "..."]
  npm run leads                             show the current lead list from the database`;

const command = positionals[0] ?? 'find';
const now = new Date();

const ctx = sourceContext();
const workspaceOptions: WorkspaceOptions = {
    dataDir: values.data,
    settingsPath: values.settings,
    registryPath: values.registry,
    enrichConfigPath: values.config,
    sourcesPath: values.sources,
    suppressionPath: values.suppression,
};
const load = () => loadWorkspace(workspaceOptions, now);
type Loaded = Workspace;

async function discoverAll(l: Loaded, warnings: string[]) {
    const run = await discoverWorkspace(l, { sourcesPath: values.sources, days: values.days ? Number(values.days) : undefined, input: values.input, reuse: values.reuse }, ctx, now);
    for (const s of run.sources) if (s.ok && s.permits) console.error(`${s.name}: ${s.permits} permits, ${s.opportunities} opportunities (${s.newOpportunities} new)`);
    warnings.push(...run.warnings);
    return run.opportunities;
}

function leadLine(l: LeadRecord): string {
    const p = l.project;
    return [
        `${String(p.score).padStart(3)}  ${p.name}`,
        `     ${money(p.estimated_value) || 'value n/a'} · ${p.city}, ${p.county} County · ${p.project_stage.replace('_', '-')} · GC: ${p.general_contractor ?? 'not named yet'}${p.developer_owner ? ` · owner/developer: ${p.developer_owner}` : ''}`,
        `     scope: ${p.target_scopes.join(', ')} · ${l.status}: ${l.status_reason}`,
        `     timing: ${p.bid_timing}`,
        `     source: ${p.evidence_url}`,
    ].join('\n');
}

function summaryText(l: Loaded, run: EvaluateResult | undefined, batch: ContactBatch, warnings: string[]): string {
    const db = l.db;
    const active = rankLeads(db.leads.filter(isActive));
    const count = (s: LeadStatus) => db.leads.filter((x) => x.status === s).length;
    const spent = l.ledger.creditsThisMonth(now);
    const est = batch.estimate;
    const lines = [`# Best Construction leads — ${now.toISOString().slice(0, 10)}`, ''];
    if (run) {
        lines.push(
            '## This run',
            `- Opportunities discovered: ${run.discovered} (${run.newLeads} new to the database)`,
            `- Qualified projects (score ≥ ${l.settings.minScore}, verified real, current and in scope): ${run.qualified}`,
            `  ${Object.entries(run.qualifiedByStatus)
                .map(([status, n]) => `${status}: ${n}`)
                .join(' · ')}`,
            `- Rejected in total: ${run.rejected} (${run.discovered - run.qualified} before qualifying: score, size, inactive, no target scope; the rest after the company check)`,
            `- Companies: ${run.buyers.length} approved buyer(s) · ${run.competitors.length} competitor(s) blocked · ${run.notPursued.length} not pursued (small / do-not-enrich) · ${run.review.length} manual review`,
            '',
        );
    }
    lines.push('## Master database', ...LEAD_STATUSES.map((s) => `- ${s}: ${count(s)}`), '');
    const pursue = active.filter((x) => x.company_id && db.company(x.company_id)?.classification === 'buyer');
    lines.push('## Best opportunities with an approved buyer', ...(pursue.length ? pursue.slice(0, l.settings.topLeads).map(leadLine) : ['(none yet)']), '');
    const watch = active.filter((x) => !pursue.includes(x));
    lines.push('## Strong projects to watch (GC under review or not named yet)', ...(watch.length ? watch.slice(0, l.settings.topLeads).map(leadLine) : ['(none)']), '');
    lines.push(
        '## Contacts (Apollo)',
        `- Companies ready for a decision-maker lookup: ${batch.plans.length}${batch.deferred.length ? ` (+${batch.deferred.length} in a later batch)` : ''}`,
        ...batch.plans.map((p) => `  - ${p.account.displayName}: ${p.creditsExpected}–${p.creditsMax} credits (${p.account.opportunities.length} lead(s), best score ${p.account.bestScore})`),
        `- Exact credits for this batch: ${est.creditsExpected} expected, ${est.creditsMax} maximum`,
        `- Already looked up (never bought twice): ${batch.alreadyEnriched.join(', ') || 'none'}`,
        `- Apollo credits used this month: ${spent} of ${est.monthlyCreditCap} (cap $${est.monthlyBudgetUsd})`,
        batch.plans.length ? '- To prepare contacts: say "Prepare contacts for today\'s qualified leads." (one approval for the whole batch)' : '',
        '',
    );
    if (warnings.length) lines.push('## Warnings', ...warnings.map((w) => `- ${w}`), '');
    lines.push('Nothing was sent to anyone. No Apollo credits were used by this run.');
    return lines.filter((x, i, all) => x !== '' || all[i - 1] !== '').join('\n') + '\n';
}

async function find() {
    const l = await load();
    const warnings: string[] = [];
    const opportunities = await discoverAll(l, warnings);
    const run = await evaluateOpportunities(opportunities, {
        settings: l.settings,
        registry: l.registry,
        db: l.db,
        researchCache: l.researchCache,
        lookupHistory: (license) => permitHistory(license, ctx, now),
        suppressed: l.suppressed,
        now,
    });
    const batch = await planContactBatch(l.db, l.registry, l.settings, l.config, l.apolloCache, l.researchCache, now);
    await l.db.save(now);
    const summary = summaryText(l, run, batch, warnings);
    const files = await writeReports(l.paths.reports, { db: l.db, registry: l.registry, batch, ledger: l.ledger.all(), creditsThisMonth: l.ledger.creditsThisMonth(now), now, summary });
    console.log(summary);
    console.log(`Reports:\n${files.map((f) => `  ${f}`).join('\n')}`);
}

async function contacts() {
    const l = await load();
    const batch = await planContactBatch(l.db, l.registry, l.settings, l.config, l.apolloCache, l.researchCache, now, values.limit ? Number(values.limit) : Infinity);
    const est = batch.estimate;
    const spent = l.ledger.creditsThisMonth(now);
    const capLeft = Math.max(0, est.monthlyCreditCap - spent);
    const estimatePath = join(l.paths.estimates, `estimate-${est.planId}.json`);

    if (!batch.plans.length) {
        console.log(`No approved buyers are waiting for contacts. Already looked up: ${batch.alreadyEnriched.join(', ') || 'none'}. Nothing to buy.`);
        return;
    }

    if (!values.approve) {
        await mkdir(l.paths.estimates, { recursive: true });
        await writeFile(estimatePath, JSON.stringify({ estimate: est, calls: batch.plans.flatMap((p) => p.calls) }, null, 2) + '\n');
        console.log(`\nCONTACT PREPARATION — ESTIMATE ONLY. No Apollo calls were made and no credits were used.\n`);
        console.log(`Checks before any paid request:`);
        console.log(`  ✓ every company is an approved buyer (${batch.plans.map((p) => p.account.displayName).join('; ')})`);
        console.log(`  ✓ every lead scores ≥ ${l.settings.minScore}`);
        console.log(`  ✓ not looked up before (skipped: ${batch.alreadyEnriched.join(', ') || 'none'})`);
        console.log(`  ✓ cached lookups reused: ${est.cachedCalls} of ${est.calls} requests`);
        console.log(`  ${est.creditsMax <= capLeft ? '✓' : '✗'} monthly cap: ${spent} used, ${capLeft} left of ${est.monthlyCreditCap} credits ($${est.monthlyBudgetUsd} budget)`);
        console.log(`\nBatch ${est.planId}: ${batch.plans.length} compan${batch.plans.length === 1 ? 'y' : 'ies'}${batch.deferred.length ? ` (+${batch.deferred.length} in a later batch)` : ''}`);
        for (const p of batch.plans) console.log(`  ${String(p.account.bestScore).padStart(3)}  ${p.account.displayName.padEnd(50)} ${p.creditsExpected}–${p.creditsMax} credits`);
        console.log(`\nEXACT CREDITS: ${est.creditsExpected} expected, ${est.creditsMax} maximum (never exceeded).`);
        for (const a of est.assumptions) console.log(`  · ${a}`);
        console.log(`\nTo approve this whole batch (one approval): npm run prepare-contacts -- --approve ${est.planId}`);
        return;
    }

    // --approve: refuse unless everything matches the reviewed estimate.
    if (values.approve !== est.planId) throw new Error(`The batch changed since estimate ${values.approve} (now ${est.planId}). Run "npm run prepare-contacts" again and review it.`);
    if (!(await exists(estimatePath))) throw new Error(`No estimate file for ${est.planId}; run "npm run prepare-contacts" first.`);
    const apiKey = process.env.APOLLO_API_KEY?.trim();
    if (!apiKey) throw new Error('APOLLO_API_KEY is not set.');
    if (est.creditsMax > capLeft) throw new Error(`Batch needs up to ${est.creditsMax} credits but only ${capLeft} remain under this month's cap.`);

    console.log(`Running approved batch ${est.planId}: ${batch.plans.length} companies, up to ${est.creditsMax} credits. Nobody is contacted.`);
    const results = await executePlans(batch.plans, l.config, new ApolloClient(apiKey, process.env.APOLLO_BASE_URL || undefined), l.apolloCache, l.ledger, {
        planId: est.planId,
        approvedCredits: est.creditsMax,
        monthlyCreditCap: est.monthlyCreditCap,
        now,
        log: (m) => console.error(m),
    });
    const found = recordEnrichment(results, batch.plans, l.db, l.contacts, est.planId, now);
    await l.contacts.save();
    await l.db.save(now);
    const contactsPath = await writeContactsReport(l.paths.privateReports, l.contacts.all(), l.db);
    const next = await planContactBatch(l.db, l.registry, l.settings, l.config, l.apolloCache, l.researchCache, now);
    await writeReports(l.paths.reports, { db: l.db, registry: l.registry, batch: next, ledger: l.ledger.all(), creditsThisMonth: l.ledger.creditsThisMonth(now), now, summary: summaryText(l, undefined, next, []) });

    const used = results.reduce((s, r) => s + r.creditsSpent, 0);
    for (const r of results) {
        const c = found.find((x) => x.company_id === r.accountId && x.business_email) ?? found.find((x) => x.company_id === r.accountId);
        console.log(`  ${r.accountId}: ${r.status}${c ? ` — ${c.name}, ${c.title ?? ''}${c.business_email ? `, ${c.business_email}` : ''}${c.verified ? ' (verified)' : ''}` : ''}${r.note ? ` (${r.note})` : ''}`);
    }
    console.log(`\nCredits used: ${used} of ${est.creditsMax} approved; ${l.ledger.creditsThisMonth(now)} this month.`);
    console.log(`Contacts (private, not committed): ${contactsPath}\nNothing was sent to anyone.`);
}

async function status() {
    const [, query, statusArg] = positionals;
    if (!query || !statusArg) throw new Error(USAGE);
    const l = await load();
    const leads = l.db.find(query);
    if (!leads.length) throw new Error(`No lead or company matches "${query}".`);
    // STOP = stop all outreach to this lead/company now.
    const wanted = statusArg.toUpperCase().replace(/[\s-]+/g, '_').replace(/^STOP$/, 'DO_NOT_CONTACT');
    for (const lead of leads) {
        if (wanted === 'AUTO') l.db.releaseStatus(lead.lead_id, now);
        else if ((LEAD_STATUSES as readonly string[]).includes(wanted)) l.db.setStatus(lead.lead_id, wanted as LeadStatus, values.note ?? `Set by owner`, 'owner', now);
        else throw new Error(`Unknown status "${statusArg}". Use one of: ${LEAD_STATUSES.join(', ')}, or AUTO.`);
        if (values.note) lead.owner_note = values.note;
        console.log(`${lead.lead_id}  ${lead.project.name}  →  ${lead.status}`);
    }
    await l.db.save(now);
}

async function show() {
    const l = await load();
    const batch = await planContactBatch(l.db, l.registry, l.settings, l.config, l.apolloCache, l.researchCache, now);
    console.log(summaryText(l, undefined, batch, []));
    console.log(Object.entries(STATUS_MEANING).map(([s, m]) => `  ${s.padEnd(19)} ${m}`).join('\n'));
}

try {
    const commands: Record<string, () => Promise<void>> = { find, contacts, status, show };
    const run = commands[command];
    if (!run) throw new Error(USAGE);
    await run();
} catch (error) {
    console.error(`Failed: ${(error as Error).message}`);
    process.exit(1);
}
