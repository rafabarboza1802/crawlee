import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { sfPipelineSponsors } from '../discover/sources/sf-pipeline.js';
import { ApolloClient } from '../enrich/apollo.js';
import { permitHistory } from '../enrich/research.js';
import { ContactStore } from '../leads/db.js';
import { evaluateOpportunities, planContactBatch, rankLeads } from '../leads/pipeline.js';
import { writeContactsReport, writeReports } from '../leads/report.js';
import { DEFAULT_WORKSPACE, discoverAll, loadWorkspace, sourceContext, type SourceRun } from '../leads/workspace.js';
import { effectiveMode, loadOutreachConfig, outreachEnv } from '../outreach/config.js';
import { runOutreach, type OutreachResult } from '../outreach/engine.js';
import { GmailProvider, gmailCredentials } from '../outreach/gmail.js';
import type { EmailProvider } from '../outreach/provider.js';
import { loadOutreachState, OutreachStore, saveOutreachState, Suppression } from '../outreach/store.js';
import { firstNameOf, renderEmail } from '../outreach/templates.js';
import { lockVault, unlockVault } from '../outreach/vault.js';
import { autoEnrich } from './enrich.js';
import { applyOwnerUpdates } from './owner-updates.js';
import { bidInvitationsThisWeek, privateSection, saveWeekly, type WeeklyMetrics, weeklyMarkdown } from './report.js';

const { values } = parseArgs({
    options: {
        data: { type: 'string', default: DEFAULT_WORKSPACE.dataDir },
        input: { type: 'string' },
        reuse: { type: 'boolean', default: false },
        sample: { type: 'boolean', default: false },
        crm: { type: 'boolean', default: false },
        'enrich-config': { type: 'string', default: DEFAULT_WORKSPACE.enrichConfigPath },
        'outreach-config': { type: 'string', default: 'outreach.config.json' },
    },
});

const now = new Date();
const log = (m: string) => console.error(m);
const errors: string[] = [];
const notes: string[] = [];
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
        return await fn();
    } catch (error) {
        errors.push(`${name}: ${(error as Error).message}`);
        log(`ERROR ${name}: ${(error as Error).message}`);
        return undefined;
    }
};

const ws = await loadWorkspace({ ...DEFAULT_WORKSPACE, dataDir: values.data, enrichConfigPath: values['enrich-config'] }, now);
const p = ws.paths;
const files = {
    vault: join(p.dataDir, 'private.vault'),
    outreach: join(p.privateDir, 'outreach.json'),
    suppression: join(p.dataDir, 'suppression.json'),
    blocklist: join(p.dataDir, 'blocklist.txt'),
    outreachState: join(p.dataDir, 'outreach-state.json'),
    ownerUpdates: join(p.dataDir, 'owner-updates.csv'),
};
const dataKey = process.env.LEAD_DATA_KEY?.trim() || undefined;

// 0. Private data (contacts, outreach log). Without it, nothing paid or sent may happen: it would be lost or repeated.
let privateOk = !!dataKey;
if (!dataKey) errors.push('LEAD_DATA_KEY is not set: contact lookups and email outreach are skipped (purchased contacts could not be saved privately).');
const vaultOpened = await step('Private data vault', async () => {
    if (await unlockVault(files.vault, p.privateDir, dataKey)) log('Private data vault opened.');
    return true;
});
if (!vaultOpened) privateOk = false;

// Reload the private stores now that the vault is open.
ws.contacts = await ContactStore.load(p.contacts);
const store = await OutreachStore.load(files.outreach);
const suppression = await Suppression.load(files.suppression, files.blocklist);
const outreachState = await loadOutreachState(files.outreachState);
const outreachConfig = await loadOutreachConfig(values['outreach-config']);
const env = outreachEnv();
const creds = gmailCredentials();
const gmailUrls = process.env.GMAIL_API_URL ? { token: process.env.GMAIL_TOKEN_URL ?? '', api: process.env.GMAIL_API_URL } : undefined;
const provider: EmailProvider | undefined = creds && env.from ? new GmailProvider(creds, env.from, gmailUrls) : undefined;

if (values.crm) {
    // Owner export: full CRM with contact details, written to the private folder only.
    const path = await writeContactsReport(p.privateReports, ws.contacts.all(), ws.db);
    console.log(`Private contacts/CRM report: ${path}`);
    process.exit(0);
}

if (values.sample) {
    // SAFE TEST: one sample email to the company-controlled test address only.
    if (!provider || !env.testTo) throw new Error('Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, OUTREACH_FROM and OUTREACH_TEST_TO first.');
    const lead = rankLeads(ws.db.leads.filter((l) => l.company_id && ws.db.company(l.company_id)?.classification === 'buyer'))[0] ?? rankLeads(ws.db.leads)[0];
    if (!lead) throw new Error('No lead in the database yet: run "npm run find-leads" first.');
    const company = ws.db.company(lead.company_id ?? '')?.name ?? lead.project.general_contractor ?? 'the contractor';
    const email = renderEmail(1, { firstName: firstNameOf('there'), company, lead, otherLeads: [], sender: outreachConfig.sender });
    const me = await provider.whoAmI();
    await provider.send({ to: env.testTo, subject: `[TEST SAMPLE] ${email.subject}`, text: `[SAMPLE — sent only to your test address]\n\n${email.text}`, unsubscribeMailto: env.from });
    outreachState.test_passed_at = now.toISOString();
    await saveOutreachState(files.outreachState, outreachState);
    console.log(`Sample sent from ${me} to the test address. Test recorded; live sending still needs liveAuthorization in outreach.config.json.`);
    process.exit(0);
}

// 1. Owner updates from data/owner-updates.csv.
const updates = await step('Owner updates', () => applyOwnerUpdates(files.ownerUpdates, ws.db, now));
if (updates) {
    notes.push(...updates.applied.map((a) => `Owner update applied: ${a}`));
    errors.push(...updates.problems);
}

// 2. DISCOVER → VERIFY → IDENTIFY → CLASSIFY → SCORE → DEDUPLICATE (free).
const ctx = sourceContext(log);
const discovered = await step('Discovery', () => discoverAll(ws, { sourcesPath: DEFAULT_WORKSPACE.sourcesPath, input: values.input, reuse: values.reuse }, ctx, now));
const sources: SourceRun[] = discovered?.sources ?? [];
for (const s of sources.filter((x) => !x.ok)) errors.push(`Source ${s.name} failed: ${s.error}`);
const evaluation = discovered
    ? await step('Qualification', () =>
          evaluateOpportunities(discovered.opportunities, {
              settings: ws.settings,
              registry: ws.registry,
              db: ws.db,
              researchCache: ws.researchCache,
              lookupHistory: (license) => permitHistory(license, ctx, now),
              lookupSponsors: (parcels) => sfPipelineSponsors(ctx, parcels),
              suppressed: ws.suppressed,
              now,
          }),
      )
    : undefined;

if (evaluation) {
    notes.push(...evaluation.warnings);
    if (evaluation.developersIdentified) notes.push(`Likely developer identified from public records for ${evaluation.developersIdentified} project(s) with no GC on the permit.`);
}

// 3. FIND DECISION MAKER (Apollo, within the standing credit limits).
const creditsBefore = ws.ledger.creditsThisMonth(now);
let contactsDiscovered = 0;
let verifiedEmails = 0;
const notEnriched: string[] = [];
const apolloKey = process.env.APOLLO_API_KEY?.trim();
if (privateOk && apolloKey) {
    const enriched = await step('Contact lookup (Apollo)', () => autoEnrich(ws, new ApolloClient(apolloKey, process.env.APOLLO_BASE_URL || undefined), now, log));
    if (enriched) {
        contactsDiscovered = enriched.contactsDiscovered;
        verifiedEmails = enriched.verifiedEmails;
        notEnriched.push(...enriched.notEnriched);
        notes.push(...enriched.skipped);
    }
} else if (!apolloKey) {
    notes.push('APOLLO_API_KEY not set: contact lookup skipped; qualified buyers keep waiting.');
}

// 4. OUTREACH: sync inbox (replies/bounces/opt-outs) → stop → send → log.
let outreach: OutreachResult | undefined;
if (privateOk) {
    outreach = await step('Email outreach', () => runOutreach({ db: ws.db, contacts: ws.contacts, store, suppression, state: outreachState, provider, config: outreachConfig, env, now, log }));
    if (outreach) {
        errors.push(...outreach.errors);
        notes.push(...outreach.notes);
    }
}

// 5. SAVE everything (public database + private stores).
await step('Save', async () => {
    await ws.db.save(now);
    await ws.contacts.save();
    await store.save();
    await suppression.save();
    await saveOutreachState(files.outreachState, outreachState);
});

// 6. REPORT: public weekly report + history, standard reports, private owner email.
const creditsMonth = ws.ledger.creditsThisMonth(now);
const credits = creditsMonth - creditsBefore;
const metrics: WeeklyMetrics = {
    date: now.toISOString().slice(0, 10),
    sources,
    projectsScanned: sources.reduce((s, x) => s + x.permits, 0),
    newOpportunities: evaluation?.newLeads ?? 0,
    qualified: evaluation?.qualified ?? 0,
    rejected: evaluation?.rejected ?? 0,
    needsReview: evaluation?.review.length ?? 0,
    competitorsBlocked: evaluation?.competitors.length ?? 0,
    contactsDiscovered,
    verifiedEmails,
    notEnriched,
    // Qualified projects whose buying company (GC, developer or owner) is identified.
    companiesIdentified: new Set(ws.db.leads.filter((l) => l.company_id && ['QUALIFIED', 'NEEDS_REVIEW', 'CONTACT_READY', 'CONTACTED', 'FOLLOW_UP', 'REPLIED'].includes(l.status)).map((l) => l.company_id)).size,
    apolloCredits: credits,
    apolloCreditsMonth: creditsMonth,
    apolloCostUsd: ws.config.usdPerCredit === null ? null : Math.round(credits * ws.config.usdPerCredit * 100) / 100,
    emailMode: outreach?.mode ?? `${effectiveMode(outreachConfig, env)} (not run)`,
    emailsSent: outreach?.sent ?? 0,
    followUpsSent: outreach?.followUps ?? 0,
    testEmails: outreach?.testSends ?? 0,
    replies: outreach?.replies ?? 0,
    bounces: outreach?.bounces ?? 0,
    optOuts: outreach?.optOuts ?? 0,
    bidInvitations: bidInvitationsThisWeek(ws.db, now),
    queued: outreach?.queued ?? 0,
    errors,
    notes,
};
const markdown = weeklyMarkdown(metrics, ws.db);
await step('Weekly report', async () => {
    const saved = await saveWeekly(p.reports, metrics, markdown);
    const batch = await planContactBatch(ws.db, ws.registry, ws.settings, ws.config, ws.apolloCache, ws.researchCache, now);
    await writeReports(p.reports, { db: ws.db, registry: ws.registry, batch, ledger: ws.ledger.all(), creditsThisMonth: creditsMonth, now, summary: markdown });
    log(`Weekly report: ${saved.report}`);
});
const owner = privateOk ? privateSection(ws.db, ws.contacts, store, outreach) : '';
await mkdir(p.privateReports, { recursive: true });
await writeFile(join(p.privateReports, `weekly-${metrics.date}.md`), `${markdown}\n${owner}\n`);
if (outreachConfig.ownerReportEmail && provider && env.ownerReportTo) {
    await step('Owner report email', () =>
        provider.send({ to: env.ownerReportTo!, subject: `Best Construction weekly leads — ${metrics.date}${errors.length ? ` (${errors.length} issue${errors.length === 1 ? '' : 's'})` : ''}`, text: `${markdown}\n${owner}\n` }).then(() => undefined),
    );
}

// 7. Lock the private data back into the encrypted vault.
if (dataKey && privateOk) await step('Private data vault (save)', async () => void (await lockVault(files.vault, p.privateDir, dataKey)));

console.log(markdown);
if (errors.length) {
    console.error(`\n${errors.length} issue(s) — see the report. Leads and the email queue were kept.`);
    process.exit(1);
}
