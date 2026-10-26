import { randomUUID } from 'node:crypto';

import type { ContactStore, LeadDatabase } from '../leads/db.js';
import { rankLeads } from '../leads/pipeline.js';
import type { ContactRecord, LeadRecord } from '../leads/types.js';
import { OWNER_STATUSES } from '../leads/types.js';
import { effectiveMode, type OutreachConfig, type OutreachEnv, readinessProblems } from './config.js';
import { addressOf, EmailAuthError, type EmailProvider, isBounceNotice, isOptOut } from './provider.js';
import { domainOf, maskEmail, type OutreachState, type OutreachStore, type Sequence, type Suppression } from './store.js';
import { firstNameOf, renderEmail } from './templates.js';

export interface OutreachDeps {
    db: LeadDatabase;
    contacts: ContactStore;
    store: OutreachStore;
    suppression: Suppression;
    state: OutreachState;
    /** Undefined when no mailbox is connected. */
    provider?: EmailProvider;
    config: OutreachConfig;
    env: OutreachEnv;
    now: Date;
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
}

export interface OutreachResult {
    mode: OutreachConfig['mode'];
    sent: number;
    followUps: number;
    testSends: number;
    replies: number;
    bounces: number;
    optOuts: number;
    stopped: number;
    /** Emails ready but not sent this run (mode off, limits, or an error). They stay queued. */
    queued: number;
    errors: string[];
    notes: string[];
    /** What was sent: lead, company, step (no addresses). */
    items: { lead_id: string; company: string; step: number; test: boolean }[];
}

const DAY = 86_400_000;
const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY).toISOString();

/** Owner statuses and blocks end a sequence; so does a competitor classification. */
function stopReason(lead: LeadRecord | undefined, db: LeadDatabase): string | undefined {
    if (!lead) return 'lead missing';
    if (lead.status === 'DO_NOT_CONTACT') return 'marked do-not-contact';
    if (lead.status === 'COMPETITOR' || (lead.company_id && db.company(lead.company_id)?.classification === 'competitor')) return 'company classified as competitor';
    if (lead.status_by === 'owner' && lead.status !== 'CONTACTED' && lead.status !== 'FOLLOW_UP') return `owner set ${lead.status}`;
    if (OWNER_STATUSES.includes(lead.status)) return `owner set ${lead.status}`;
    return undefined;
}

function endSequence(seq: Sequence, state: Sequence['state'], reason: string, d: OutreachDeps) {
    seq.state = state;
    seq.next_due_at = null;
    seq.stop_reason = reason;
    for (const id of seq.lead_ids) {
        const lead = d.db.lead(id);
        if (lead?.outreach?.sequence_id === seq.id) lead.outreach = { ...lead.outreach, state, next_due_at: null, stop_reason: reason, ...(seq.replied_at ? { replied_at: seq.replied_at } : {}) };
    }
}

/**
 * SYNC: reads the mailbox for replies, unsubscribe requests and bounces before anything is sent, and stops those
 * sequences for good. Throws (and nothing is sent) if the mailbox cannot be read.
 */
export async function syncInbox(d: OutreachDeps, me: string): Promise<Pick<OutreachResult, 'replies' | 'bounces' | 'optOuts'>> {
    const counts = { replies: 0, bounces: 0, optOuts: 0 };
    const p = d.provider!;
    const recent = (s: Sequence) => s.state === 'active' || (s.state === 'completed' && Date.parse(s.steps.at(-1)?.sent_at ?? '') > d.now.getTime() - 30 * DAY);
    const byAddress = new Map(d.store.sequences.map((s) => [s.to.toLowerCase(), s]));

    const optOut = (seq: Sequence | undefined, address: string) => {
        d.suppression.add(address, 'opt_out', d.now);
        if (seq && seq.state !== 'opted_out') {
            endSequence(seq, 'opted_out', 'recipient asked to unsubscribe', d);
            for (const id of seq.lead_ids) d.db.setStatus(id, 'DO_NOT_CONTACT', 'Recipient opted out.', 'system', d.now);
            counts.optOuts++;
        }
    };
    const bounce = (seq: Sequence | undefined, address: string) => {
        d.suppression.add(address, 'bounce', d.now);
        if (seq && seq.state !== 'bounced') {
            endSequence(seq, 'bounced', 'email bounced permanently', d);
            const company = d.db.company(seq.company_id);
            if (company?.enrichment) company.enrichment = { ...company.enrichment, status: 'bounced', verified_contacts: 0 };
            for (const id of seq.lead_ids) d.db.setStatus(id, 'QUALIFIED', 'Contact email bounced. Call the company or name a new contact.', 'system', d.now, { allowBackward: true });
            counts.bounces++;
        }
    };

    for (const seq of d.store.sequences.filter(recent)) {
        for (const m of await p.threadMessages(seq.thread_id)) {
            const from = addressOf(m.from);
            if (from === me) continue;
            if (isBounceNotice(m)) {
                if (!/delay|delayed|will retry/i.test(`${m.subject} ${m.snippet}`)) bounce(seq, seq.to);
                break;
            }
            if (seq.state !== 'replied' && seq.state !== 'opted_out') {
                if (isOptOut(m)) optOut(seq, seq.to);
                else {
                    seq.replied_at = d.now.toISOString();
                    endSequence(seq, 'replied', 'recipient replied', d);
                    for (const id of seq.lead_ids) d.db.setStatus(id, 'REPLIED', 'They replied: follow-ups stopped. Your turn.', 'system', d.now);
                    counts.replies++;
                }
            }
            break;
        }
    }
    // Unsubscribe requests that arrive as new messages (List-Unsubscribe mailto) and bounce notices outside the thread.
    for (const m of await p.search('subject:unsubscribe newer_than:30d', 50)) {
        const from = addressOf(m.from);
        if (from !== me) optOut(byAddress.get(from), from);
    }
    for (const m of await p.search('from:(mailer-daemon OR postmaster) newer_than:30d', 50)) {
        if (/delay|delayed|will retry/i.test(`${m.subject} ${m.snippet}`)) continue;
        for (const address of m.failedRecipients ?? []) bounce(byAddress.get(address), address);
    }
    d.state.last_inbox_sync_at = d.now.toISOString();
    return counts;
}

interface Planned {
    kind: 'new' | 'follow_up';
    step: number;
    lead: LeadRecord;
    others: LeadRecord[];
    contact: ContactRecord;
    sequence?: Sequence;
}

/** Personalization for one planned email: the GC or the developer/owner, a person or a published bids mailbox. */
function emailContext(p: Planned, d: OutreachDeps) {
    const mailbox = p.contact.role_category === 'bid_mailbox';
    return {
        firstName: mailbox ? '' : firstNameOf(p.contact.name),
        ...(mailbox ? { greeting: 'Hello estimating team,' } : {}),
        company: p.contact.company_name,
        lead: p.lead,
        otherLeads: p.others,
        sender: d.config.sender,
        audience: p.lead.project.permit_contractor ? ('contractor' as const) : ('owner' as const),
    };
}

/** The send queue for this run: due follow-ups first, then new prospects, within the configured limits. */
export function planSends(d: OutreachDeps): { planned: Planned[]; skipped: string[] } {
    const { db, config, now } = d;
    const skipped: string[] = [];
    const planned: Planned[] = [];
    const contactsById = new Map(d.contacts.all().map((c) => [c.id, c]));

    // Follow-ups that are due.
    for (const seq of d.store.sequences.filter((s) => s.state === 'active' && s.next_due_at && Date.parse(s.next_due_at) <= now.getTime())) {
        const lead = db.lead(seq.lead_ids[0]!);
        const contact = contactsById.get(seq.contact_id);
        if (!lead || !contact) continue;
        planned.push({ kind: 'follow_up', step: seq.steps.length + 1, lead, others: [], contact, sequence: seq });
    }

    // New prospects: CONTACT_READY leads of approved buyers with a verified business email, one sequence per person.
    const busy = new Set(d.store.sequences.filter((s) => s.state === 'active').map((s) => s.contact_id));
    const recentlyDone = new Set(
        d.store.sequences.filter((s) => Date.parse(s.steps.at(-1)?.sent_at ?? '') > now.getTime() - config.sequence.contactCooldownDays * DAY).map((s) => s.contact_id),
    );
    const contacted = new Set(d.store.sequences.flatMap((s) => s.lead_ids.map((l) => `${s.contact_id}|${l}`)));
    const byCompany = new Map<string, LeadRecord[]>();
    for (const lead of rankLeads(db.leads.filter((l) => l.status === 'CONTACT_READY' && !l.outreach && l.company_id))) {
        byCompany.set(lead.company_id!, [...(byCompany.get(lead.company_id!) ?? []), lead]);
    }
    for (const [companyId, leads] of byCompany) {
        const company = db.company(companyId);
        if (company?.classification !== 'buyer') {
            skipped.push(`${company?.name ?? companyId}: not an approved buyer`);
            continue;
        }
        const contact = d.contacts
            .forCompany(companyId)
            // Apollo-verified decision makers first; a bids mailbox the company publishes on its own website is the fallback.
            .filter((c) => c.verified && c.business_email && (c.email_status === 'verified' || (c.email_status === 'published' && c.role_category === 'bid_mailbox')))
            .sort((a, b) => Number(a.role_category === 'bid_mailbox') - Number(b.role_category === 'bid_mailbox'))[0];
        if (!contact) {
            skipped.push(`${company.name}: no verified business email in the private contact store`);
            continue;
        }
        const block = d.suppression.blockedReason(contact.business_email!, company.name);
        if (block) {
            skipped.push(`${company.name}: ${block}`);
            for (const l of leads) db.setStatus(l.lead_id, 'DO_NOT_CONTACT', `Contact ${block}.`, 'system', now);
            continue;
        }
        if (busy.has(contact.id) || recentlyDone.has(contact.id)) {
            skipped.push(`${company.name}: contact already in a recent sequence (cooldown ${config.sequence.contactCooldownDays} days)`);
            continue;
        }
        const fresh = leads.filter((l) => !contacted.has(`${contact.id}|${l.lead_id}`));
        if (!fresh.length) continue;
        planned.push({ kind: 'new', step: 1, lead: fresh[0]!, others: fresh.slice(1, 2), contact });
    }

    // Limits: total, new prospects, and per company domain.
    const out: Planned[] = [];
    const perDomain = new Map<string, number>();
    let fresh = 0;
    for (const p of planned) {
        if (out.length >= config.limits.maxEmailsPerRun) break;
        if (p.kind === 'new' && fresh >= config.limits.maxNewPerRun) continue;
        const domain = domainOf(p.contact.business_email!);
        if ((perDomain.get(domain) ?? 0) >= config.limits.maxPerDomainPerRun) continue;
        perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
        if (p.kind === 'new') fresh++;
        out.push(p);
    }
    return { planned: out, skipped };
}

/**
 * The outreach step of the weekly run: SYNC INBOX → STOP sequences that must stop → SEND (test or live) → LOG.
 * Never sends in "off" mode, never sends to a prospect in "test" mode, and sends nothing if the mailbox cannot be read.
 */
export async function runOutreach(d: OutreachDeps): Promise<OutreachResult> {
    const mode = effectiveMode(d.config, d.env);
    const result: OutreachResult = { mode, sent: 0, followUps: 0, testSends: 0, replies: 0, bounces: 0, optOuts: 0, stopped: 0, queued: 0, errors: [], notes: [], items: [] };
    const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    // Mailbox connection and inbox sync (also in test/off mode when connected, so replies are never missed).
    let me: string | undefined;
    if (d.provider) {
        try {
            me = await d.provider.whoAmI();
            if (d.env.from && me !== d.env.from.toLowerCase()) throw new EmailAuthError(`The authorized mailbox is ${maskEmail(me)}, not OUTREACH_FROM ${maskEmail(d.env.from)}.`);
            Object.assign(result, await syncInbox(d, me));
        } catch (error) {
            result.errors.push(`Email: ${(error as Error).message} Nothing was sent; the queue is kept for the next run.`);
            me = undefined;
        }
    } else if (mode !== 'off') {
        result.errors.push('Email: no mailbox connected (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN missing). Nothing was sent; the queue is kept.');
    }

    // Stop sequences that must stop (competitor, do-not-contact, owner outcome).
    for (const seq of d.store.sequences.filter((s) => s.state === 'active')) {
        const reason = seq.lead_ids.map((id) => stopReason(d.db.lead(id), d.db)).find(Boolean);
        if (reason) {
            endSequence(seq, 'stopped', reason, d);
            result.stopped++;
        }
    }

    const { planned, skipped } = planSends(d);
    result.notes.push(...skipped);
    const problems = readinessProblems(d.config, d.env, mode, d.state.test_passed_at);
    if (mode === 'off' || problems.length || !me) {
        result.queued = planned.length;
        if (mode !== 'off') result.errors.push(...problems.map((p) => `Email: ${p}`));
        return result;
    }

    if (mode === 'test') {
        let ok = true;
        for (const p of planned.slice(0, d.config.limits.maxTestPerRun)) {
            const email = renderEmail(p.step, emailContext(p, d));
            const banner = `[TEST MODE — this message was NOT sent to the prospect. It would go to ${maskEmail(p.contact.business_email!)} (${p.contact.title ?? 'contact'}) at ${p.contact.company_name}, email ${p.step} of ${d.config.sequence.maxEmails}.]\n\n`;
            try {
                await d.provider!.send({ to: d.env.testTo!, subject: `[TEST] ${email.subject}`, text: banner + email.text, unsubscribeMailto: d.env.from });
                d.store.recordTest({ at: d.now.toISOString(), to: d.env.testTo!, would_go_to: maskEmail(p.contact.business_email!), lead_id: p.lead.lead_id, step: p.step, subject: email.subject });
                result.testSends++;
                result.items.push({ lead_id: p.lead.lead_id, company: p.contact.company_name, step: p.step, test: true });
                await sleep(d.config.limits.delaySeconds * 1000);
            } catch (error) {
                ok = false;
                result.errors.push(`Email (test): ${(error as Error).message}`);
                break;
            }
        }
        if (!planned.length) result.notes.push('Test mode: no prospect is ready yet; use "npm run outreach -- --sample" to send a sample to the test address.');
        if (ok && result.testSends > 0) d.state.test_passed_at = d.now.toISOString();
        result.queued = planned.length;
        return result;
    }

    // LIVE
    for (const p of planned) {
        const latest = d.db.lead(p.lead.lead_id);
        const block = d.suppression.blockedReason(p.contact.business_email!, p.contact.company_name) ?? stopReason(latest, d.db);
        if (block || (p.sequence && p.sequence.state !== 'active')) continue;
        const ctx = emailContext(p, d);
        const email = renderEmail(p.step, ctx);
        try {
            const sent = await d.provider!.send({
                to: p.contact.business_email!,
                subject: email.subject,
                text: email.text,
                unsubscribeMailto: d.env.from,
                ...(p.sequence ? { threadId: p.sequence.thread_id, inReplyTo: p.sequence.steps.at(-1)?.rfc_message_id } : {}),
            });
            const at = d.now.toISOString();
            const seq: Sequence = p.sequence ?? {
                id: randomUUID(),
                contact_id: p.contact.id,
                company_id: p.contact.company_id,
                company_name: p.contact.company_name,
                to: p.contact.business_email!,
                first_name: ctx.firstName,
                lead_ids: [p.lead.lead_id, ...p.others.map((o) => o.lead_id)],
                thread_id: sent.threadId,
                state: 'active',
                steps: [],
                next_due_at: null,
            };
            seq.steps.push({ step: p.step, sent_at: at, message_id: sent.messageId, ...(sent.rfcMessageId ? { rfc_message_id: sent.rfcMessageId } : {}), subject: email.subject });
            const next = d.config.sequence.followUpDays[seq.steps.length - 1];
            const done = seq.steps.length >= d.config.sequence.maxEmails || next === undefined;
            seq.next_due_at = done ? null : addDays(seq.steps[0]!.sent_at, next);
            if (done) seq.state = 'completed';
            d.store.put(seq);
            for (const id of seq.lead_ids) {
                const lead = d.db.lead(id)!;
                lead.outreach = {
                    contact_id: seq.contact_id,
                    sequence_id: seq.id,
                    state: seq.state,
                    emails_sent: seq.steps.length,
                    first_sent_at: seq.steps[0]!.sent_at,
                    last_sent_at: at,
                    next_due_at: seq.next_due_at,
                };
                d.db.setStatus(id, p.step === 1 ? 'CONTACTED' : 'FOLLOW_UP', p.step === 1 ? 'First email sent.' : `Follow-up ${p.step - 1} sent.`, 'system', d.now);
            }
            if (p.step === 1) result.sent++;
            else result.followUps++;
            result.items.push({ lead_id: p.lead.lead_id, company: p.contact.company_name, step: p.step, test: false });
            await sleep(d.config.limits.delaySeconds * 1000);
        } catch (error) {
            result.errors.push(`Email: ${(error as Error).message} Remaining emails stay queued for the next run.`);
            if (error instanceof EmailAuthError) break;
        }
    }
    result.queued = planned.length - result.sent - result.followUps;
    return result;
}
