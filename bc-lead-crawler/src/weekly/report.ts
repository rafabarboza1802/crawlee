import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { csvCell } from '../output.js';
import type { ContactStore, LeadDatabase } from '../leads/db.js';
import { isActive, rankLeads } from '../leads/pipeline.js';
import { money } from '../leads/report.js';
import type { SourceRun } from '../leads/workspace.js';
import type { OutreachResult } from '../outreach/engine.js';
import type { OutreachStore } from '../outreach/store.js';

export interface WeeklyMetrics {
    date: string;
    sources: SourceRun[];
    projectsScanned: number;
    newOpportunities: number;
    qualified: number;
    rejected: number;
    needsReview: number;
    competitorsBlocked: number;
    contactsDiscovered: number;
    apolloCredits: number;
    apolloCreditsMonth: number;
    apolloCostUsd: number | null;
    emailMode: string;
    emailsSent: number;
    followUpsSent: number;
    testEmails: number;
    replies: number;
    bounces: number;
    optOuts: number;
    bidInvitations: number;
    queued: number;
    errors: string[];
    notes: string[];
}

export const HISTORY_COLUMNS: [string, (m: WeeklyMetrics) => string | number][] = [
    ['date', (m) => m.date],
    ['sources_ok', (m) => m.sources.filter((s) => s.ok).length],
    ['sources_failed', (m) => m.sources.filter((s) => !s.ok).length],
    ['projects_scanned', (m) => m.projectsScanned],
    ['new_opportunities', (m) => m.newOpportunities],
    ['qualified', (m) => m.qualified],
    ['rejected', (m) => m.rejected],
    ['needs_review', (m) => m.needsReview],
    ['competitors_blocked', (m) => m.competitorsBlocked],
    ['contacts_discovered', (m) => m.contactsDiscovered],
    ['apollo_credits', (m) => m.apolloCredits],
    ['apollo_cost_usd', (m) => (m.apolloCostUsd === null ? '' : m.apolloCostUsd)],
    ['email_mode', (m) => m.emailMode],
    ['emails_sent', (m) => m.emailsSent],
    ['follow_ups_sent', (m) => m.followUpsSent],
    ['test_emails', (m) => m.testEmails],
    ['replies', (m) => m.replies],
    ['bounces', (m) => m.bounces],
    ['opt_outs', (m) => m.optOuts],
    ['bid_invitations', (m) => m.bidInvitations],
    ['errors', (m) => m.errors.length],
];

/** Bid invitations recorded in the last 7 days (owner status BID_INVITED). */
export function bidInvitationsThisWeek(db: LeadDatabase, now: Date): number {
    const since = now.getTime() - 7 * 86_400_000;
    return db.leads.filter((l) => l.history.some((h) => h.status === 'BID_INVITED' && Date.parse(h.at) >= since)).length;
}

/** Public weekly report: counts and projects only (no person names or email addresses). */
export function weeklyMarkdown(m: WeeklyMetrics, db: LeadDatabase, top = 10): string {
    const lines = [
        `# Best Construction weekly lead report — ${m.date}`,
        '',
        '## Sources',
        ...m.sources.map((s) => (s.ok ? `- ✅ ${s.name}: ${s.permits} permits scanned, ${s.opportunities} opportunities (${s.newOpportunities} new)` : `- ❌ ${s.name}: FAILED — ${s.error}`)),
        '',
        '## This week',
        `| | |`,
        `|---|---|`,
        `| Projects scanned | ${m.projectsScanned} |`,
        `| New opportunities | ${m.newOpportunities} |`,
        `| Qualified leads | ${m.qualified} |`,
        `| Rejected opportunities | ${m.rejected} |`,
        `| Leads requiring review | ${m.needsReview} |`,
        `| Competitors blocked | ${m.competitorsBlocked} |`,
        `| Contacts discovered | ${m.contactsDiscovered} |`,
        `| Apollo credits used | ${m.apolloCredits} (month: ${m.apolloCreditsMonth}) |`,
        `| Estimated Apollo cost | ${m.apolloCostUsd === null ? 'unknown (set usdPerCredit in enrich.config.json)' : `$${m.apolloCostUsd.toFixed(2)}`} |`,
        `| Email mode | ${m.emailMode.toUpperCase()} |`,
        `| Emails sent (first contact) | ${m.emailsSent} |`,
        `| Follow-ups sent | ${m.followUpsSent} |`,
        `| Test emails (to your test address) | ${m.testEmails} |`,
        `| Replies | ${m.replies} |`,
        `| Bounces | ${m.bounces} |`,
        `| Opt-outs | ${m.optOuts} |`,
        `| Bid invitations | ${m.bidInvitations} |`,
        `| Emails waiting in the queue | ${m.queued} |`,
        '',
        '## Top opportunities',
    ];
    for (const l of rankLeads(db.leads.filter(isActive)).slice(0, top)) {
        const p = l.project;
        lines.push(
            `- **${p.score}** ${p.name} — ${money(p.estimated_value) || 'value n/a'}, ${p.city} (${p.county} County). GC: ${p.general_contractor ?? 'not named yet'}. Scope: ${p.target_scopes.join(', ')}. **${l.status}**: ${l.status_reason} [source](${p.evidence_url})`,
        );
    }
    lines.push('', '## Errors and source failures', ...(m.errors.length ? m.errors.map((e) => `- ${e}`) : ['- None']));
    if (m.notes.length) lines.push('', '## Notes', ...m.notes.map((n) => `- ${n}`));
    lines.push('', 'Contact names and email addresses are not in this public report; they are in the private owner email and the encrypted data vault.');
    return lines.join('\n') + '\n';
}

/** Saves this week's report and adds (or replaces) its row in the history table. */
export async function saveWeekly(reportsDir: string, m: WeeklyMetrics, markdown: string): Promise<{ report: string; history: string }> {
    const weeklyDir = join(reportsDir, 'weekly');
    await mkdir(weeklyDir, { recursive: true });
    const report = join(weeklyDir, `${m.date}.md`);
    await writeFile(report, markdown);
    const history = join(reportsDir, 'weekly-history.csv');
    const header = HISTORY_COLUMNS.map(([h]) => h).join(',');
    let rows: string[] = [];
    try {
        rows = (await readFile(history, 'utf8')).split('\n').slice(1).filter((r) => r && !r.startsWith(`${m.date},`));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    rows.push(HISTORY_COLUMNS.map(([, get]) => csvCell(String(get(m)))).join(','));
    await writeFile(history, [header, ...rows.sort()].join('\n') + '\n');
    return { report, history };
}

/** Private part of the owner email: who is ready, who was contacted, who replied. */
export function privateSection(db: LeadDatabase, contacts: ContactStore, store: OutreachStore, outreach: OutreachResult | undefined): string {
    const lines: string[] = [];
    const replied = store.sequences.filter((s) => s.state === 'replied');
    if (replied.length) {
        lines.push('REPLIES (follow-ups stopped — your turn):');
        for (const s of replied) lines.push(`- ${s.first_name} at ${s.company_name} <${s.to}> replied ${s.replied_at?.slice(0, 10) ?? ''}`);
        lines.push('');
    }
    const ready = rankLeads(db.leads.filter((l) => l.status === 'CONTACT_READY'));
    if (ready.length) {
        lines.push('READY FOR OUTREACH:');
        for (const l of ready.slice(0, 20)) {
            const c = contacts.forCompany(l.company_id ?? '').find((x) => x.verified);
            lines.push(`- ${l.project.name} (${l.project.score}) — ${c ? `${c.name}, ${c.title ?? ''} <${c.business_email}>` : 'contact pending'}`);
        }
        lines.push('');
    }
    if (outreach?.items.length) {
        lines.push(`SENT THIS RUN (${outreach.mode}):`);
        for (const i of outreach.items) lines.push(`- ${i.company}: email ${i.step}${i.test ? ' (test copy to you)' : ''} — ${db.lead(i.lead_id)?.project.name ?? i.lead_id}`);
    }
    return lines.join('\n');
}
