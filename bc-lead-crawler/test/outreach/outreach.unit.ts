import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { effectiveMode, OutreachConfigSchema, readinessProblems } from '../../src/outreach/config.js';
import { runOutreach } from '../../src/outreach/engine.js';
import { isOptOut } from '../../src/outreach/provider.js';
import { emailHash, Suppression } from '../../src/outreach/store.js';
import { OPT_OUT_LINE, renderEmail } from '../../src/outreach/templates.js';
import { NOW } from '../leads/fixtures.js';
import { contact, day, ME, outreachSetup, TEST_TO } from './fixtures.js';

describe('email rendering', () => {
    test('personal, project-specific, only relevant scopes, sender identification and opt-out, no unsupported claims', async () => {
        const s = await outreachSetup();
        const lead = s.db.lead(s.leads[0]!.opportunity_id)!;
        const ctx = { firstName: 'Sam', company: 'Cahill Contractors', lead, otherLeads: [], sender: s.config.sender };
        const first = renderEmail(1, ctx);
        expect(first.subject).toBe(`Excavation and sitework and earthwork for ${lead.project.address}`);
        expect(first.text).toMatch(/^Hi Sam,/);
        expect(first.text).toContain(`Public permit records list Cahill Contractors as the contractor on the new 120-unit building at ${lead.project.address}, San Francisco.`);
        expect(first.text).toMatch(/add us to your bidder list for those packages, or send the bid invitation and plans/);
        expect(first.text).toContain('bestconstruction.pro');
        expect(first.text).toContain('1 Example Way, San Francisco, CA 94100');
        expect(first.text).toContain(OPT_OUT_LINE);
        expect(first.text).not.toMatch(/demolition|paving|hardscape/i);
        for (const step of [1, 2, 3]) {
            const e = renderEmail(step, ctx);
            expect(e.text).not.toMatch(/licen[sc]ed|bonded|insured|certified|years of experience|award-winning|guarantee/i);
            expect(e.text.split(/\s+/).length).toBeLessThan(170);
        }
        expect(renderEmail(2, ctx).subject).toBe(`Re: ${first.subject}`);
    });

    test('opt-out wording is recognized', () => {
        expect(isOptOut({ subject: 'Re: bid', snippet: 'Please unsubscribe me' })).toBe(true);
        expect(isOptOut({ subject: 'unsubscribe', snippet: '' })).toBe(true);
        expect(isOptOut({ subject: 'Re: bid', snippet: 'Thanks, send your number' })).toBe(false);
    });
});

describe('sending modes and safety', () => {
    test('off: nothing is sent and the queue is kept', async () => {
        const s = await outreachSetup({ mode: 'off' });
        const r = await runOutreach(s.deps());
        expect(s.mailbox.sent).toEqual([]);
        expect(r).toMatchObject({ mode: 'off', sent: 0, queued: 1 });
    });

    test('test mode: only the company test address receives anything; prospects and lead statuses are untouched', async () => {
        const s = await outreachSetup({ mode: 'test', testPassed: false });
        const r = await runOutreach(s.deps());
        expect(s.mailbox.sent.map((m) => m.to)).toEqual([TEST_TO]);
        expect(s.mailbox.sent[0]!.subject).toMatch(/^\[TEST\] /);
        expect(s.mailbox.sent[0]!.text).toMatch(/TEST MODE — this message was NOT sent to the prospect\. It would go to s\*\*\*@cahill\.example/);
        expect(r).toMatchObject({ testSends: 1, sent: 0 });
        expect(s.store.sequences).toEqual([]);
        expect(s.db.lead(s.leads[0]!.opportunity_id)!.status).toBe('CONTACT_READY');
        expect(s.state.test_passed_at).toBe(NOW.toISOString());
    });

    test('live is refused without the owner authorization or a passed test; overrides can only pause', async () => {
        const unauthorized = await outreachSetup({ authorized: false });
        const r = await runOutreach(unauthorized.deps());
        expect(unauthorized.mailbox.sent).toEqual([]);
        expect(r.errors.join(' ')).toMatch(/Live sending is not authorized/);
        const untested = await outreachSetup({ testPassed: false });
        expect((await runOutreach(untested.deps())).errors.join(' ')).toMatch(/No successful test run yet/);
        expect(untested.mailbox.sent).toEqual([]);

        const live = OutreachConfigSchema.parse({ mode: 'live' });
        const testCfg = OutreachConfigSchema.parse({ mode: 'test' });
        expect(effectiveMode(live, { modeOverride: 'off' })).toBe('off');
        expect(effectiveMode(live, { modeOverride: 'test' })).toBe('test');
        expect(effectiveMode(testCfg, { modeOverride: 'live' })).toBe('test');
        expect(readinessProblems(OutreachConfigSchema.parse({ mode: 'live', liveAuthorization: { by: 'Owner', date: '2026-10-23' } }), { from: ME }, 'live', 'x')).toEqual([
            'sender.name is empty in outreach.config.json.',
            'sender.postalAddress is empty (a physical mailing address is legally required).',
        ]);
    });

    test('mailbox authorization failure: nothing sent, queue kept, error reported', async () => {
        const s = await outreachSetup();
        s.mailbox.authFails = true;
        const r = await runOutreach(s.deps());
        expect(s.mailbox.sent).toEqual([]);
        expect(r.queued).toBe(1);
        expect(r.errors[0]).toMatch(/Gmail authorization failed.*Nothing was sent; the queue is kept/);
        expect(s.db.lead(s.leads[0]!.opportunity_id)!.status).toBe('CONTACT_READY');
    });
});

describe('live sequence', () => {
    test('day 0, day 4, day 10 in one thread; max 3 emails; never twice for the same person and project', async () => {
        const s = await outreachSetup();
        const r0 = await runOutreach(s.deps());
        expect(r0).toMatchObject({ sent: 1, followUps: 0 });
        const first = s.mailbox.sent[0]!;
        expect(first.to).toBe('sam@cahill.example');
        expect(first.unsubscribeMailto).toBe(ME);
        // One email covers both Cahill projects (one sequence per person).
        expect(first.text).toMatch(/We would be glad to look at .* as well\./);
        const lead = s.db.lead(s.leads[0]!.opportunity_id)!;
        expect(lead).toMatchObject({ status: 'CONTACTED', outreach: { emails_sent: 1, next_due_at: day(4).toISOString(), state: 'active' } });
        expect(s.db.lead(s.leads[1]!.opportunity_id)!.status).toBe('CONTACTED');

        expect((await runOutreach(s.deps(day(1)))).sent + s.mailbox.sent.length).toBe(1);
        const r4 = await runOutreach(s.deps(day(4)));
        expect(r4).toMatchObject({ sent: 0, followUps: 1 });
        expect(s.mailbox.sent[1]).toMatchObject({ threadId: first.threadId, inReplyTo: '<m1@bestconstruction.example>' });
        expect(s.db.lead(lead.lead_id)!.status).toBe('FOLLOW_UP');
        await runOutreach(s.deps(day(10)));
        expect(s.mailbox.sent).toHaveLength(3);
        expect(s.store.sequences[0]).toMatchObject({ state: 'completed', next_due_at: null });
        await runOutreach(s.deps(day(30)));
        expect(s.mailbox.sent).toHaveLength(3);
    });

    test('a reply stops the sequence immediately and the lead becomes REPLIED', async () => {
        const s = await outreachSetup();
        await runOutreach(s.deps());
        s.mailbox.reply(s.mailbox.sent[0]!.threadId, 'Sam Estimator <sam@cahill.example>', 'Thanks — send your info, bids due Nov 15');
        const r = await runOutreach(s.deps(day(4)));
        expect(r).toMatchObject({ replies: 1, followUps: 0 });
        expect(s.mailbox.sent).toHaveLength(1);
        expect(s.db.lead(s.leads[0]!.opportunity_id)).toMatchObject({ status: 'REPLIED', outreach: { state: 'replied' } });
        await runOutreach(s.deps(day(10)));
        expect(s.mailbox.sent).toHaveLength(1);
    });

    test('opt-out and permanent bounce suppress the address for good', async () => {
        const s = await outreachSetup();
        await runOutreach(s.deps());
        s.mailbox.reply(s.mailbox.sent[0]!.threadId, 'sam@cahill.example', 'Please remove me / unsubscribe');
        const r = await runOutreach(s.deps(day(4)));
        expect(r.optOuts).toBe(1);
        expect(s.db.lead(s.leads[0]!.opportunity_id)!.status).toBe('DO_NOT_CONTACT');
        expect(s.suppression.blockedReason('SAM@cahill.example', 'Cahill Contractors')).toBe('suppressed (opt-out)');

        const b = await outreachSetup();
        await runOutreach(b.deps());
        b.mailbox.reply(b.mailbox.sent[0]!.threadId, 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', "Address not found. Your message wasn't delivered", 'Delivery Status Notification (Failure)');
        const rb = await runOutreach(b.deps(day(4)));
        expect(rb).toMatchObject({ bounces: 1, followUps: 0 });
        expect(b.suppression.blockedReason('sam@cahill.example', 'x')).toBe('suppressed (bounce)');
        expect(b.db.lead(b.leads[0]!.opportunity_id)).toMatchObject({ status: 'QUALIFIED', status_reason: expect.stringMatching(/bounced/) });
        expect(b.db.company('cahill-contractors')!.enrichment!.status).toBe('bounced');

        // An unsubscribe request arriving as a new message (List-Unsubscribe mailto) is honoured too.
        const u = await outreachSetup();
        await runOutreach(u.deps());
        u.mailbox.inbox.push({ id: 'x', threadId: 'other', from: 'sam@cahill.example', date: '', subject: 'unsubscribe', snippet: '' });
        expect((await runOutreach(u.deps(day(4)))).optOuts).toBe(1);
        expect(u.mailbox.sent).toHaveLength(1);
    });

    test('competitor reclassification and an owner STOP end the sequence', async () => {
        const s = await outreachSetup();
        await runOutreach(s.deps());
        s.db.upsertCompany({ ...s.db.company('cahill-contractors')!, classification: 'competitor' }, NOW);
        const r = await runOutreach(s.deps(day(4)));
        expect(r.stopped).toBe(1);
        expect(s.mailbox.sent).toHaveLength(1);

        const o = await outreachSetup();
        await runOutreach(o.deps());
        o.db.setStatus(o.leads[0]!.opportunity_id, 'DO_NOT_CONTACT', 'STOP', 'owner', NOW);
        await runOutreach(o.deps(day(4)));
        expect(o.mailbox.sent).toHaveLength(1);
        expect(o.store.sequences[0]!.state).toBe('stopped');
    });

    test('suppression: blocked domain or previously opted-out address is never emailed; unverified emails are never used', async () => {
        const s = await outreachSetup();
        await writeFile(join(s.dir, 'blocklist.txt'), '# blocked by owner\ncahill.example\n');
        const blocked = await outreachSetup();
        const sup = await Suppression.load(join(s.dir, 'suppression.json'), join(s.dir, 'blocklist.txt'));
        const r = await runOutreach({ ...blocked.deps(), suppression: sup });
        expect(blocked.mailbox.sent).toEqual([]);
        expect(r.notes.join(' ')).toMatch(/blocked by owner \(cahill\.example\)/);
        expect(blocked.db.lead(blocked.leads[0]!.opportunity_id)!.status).toBe('DO_NOT_CONTACT');

        const unverified = await outreachSetup();
        unverified.contacts.upsert(contact({ verified: false, email_status: 'guessed' }));
        await runOutreach(unverified.deps());
        expect(unverified.mailbox.sent).toEqual([]);

        expect(emailHash('Sam@Cahill.example ')).toBe(emailHash('sam@cahill.example'));
    });

    test('sending limits: no new prospects beyond the per-run limit', async () => {
        const s = await outreachSetup();
        const deps = s.deps();
        deps.config = { ...s.config, limits: { ...s.config.limits, maxNewPerRun: 0 } };
        const r = await runOutreach(deps);
        expect(r.sent).toBe(0);
        expect(s.mailbox.sent).toEqual([]);
    });
});
