import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LeadSettingsSchema } from '../../src/leads/settings.js';
import { ContactStore, LeadDatabase } from '../../src/leads/db.js';
import { evaluateOpportunities } from '../../src/leads/pipeline.js';
import type { ContactRecord } from '../../src/leads/types.js';
import { loadCache } from '../../src/enrich/store.js';
import { OutreachConfigSchema } from '../../src/outreach/config.js';
import type { OutreachDeps } from '../../src/outreach/engine.js';
import type { EmailProvider, InboxMessage, OutgoingEmail, SentEmail, ThreadMessage } from '../../src/outreach/provider.js';
import { EmailAuthError } from '../../src/outreach/provider.js';
import { OutreachStore, Suppression } from '../../src/outreach/store.js';
import { NOW, opp, registry } from '../leads/fixtures.js';

export const ME = 'outreach@bestconstruction.example';
export const TEST_TO = 'owner-test@bestconstruction.example';

/** In-memory mailbox: records sends; tests add replies/bounces to threads. */
export class FakeMailbox implements EmailProvider {
    readonly name = 'fake';
    sent: (OutgoingEmail & { threadId: string })[] = [];
    threads = new Map<string, ThreadMessage[]>();
    inbox: InboxMessage[] = [];
    authFails = false;
    private n = 0;

    async whoAmI() {
        if (this.authFails) throw new EmailAuthError('Gmail authorization failed (400 invalid_grant).');
        return ME;
    }

    async send(email: OutgoingEmail): Promise<SentEmail> {
        if (this.authFails) throw new EmailAuthError('Gmail authorization failed (400 invalid_grant).');
        const threadId = email.threadId ?? `t${++this.n}`;
        this.sent.push({ ...email, threadId });
        this.threads.set(threadId, [...(this.threads.get(threadId) ?? []), { from: ME, date: '', subject: email.subject, snippet: email.text.slice(0, 80) }]);
        return { messageId: `m${this.n}`, threadId, rfcMessageId: `<m${this.n}@bestconstruction.example>` };
    }

    reply(threadId: string, from: string, snippet: string, subject = 'Re: bid') {
        this.threads.get(threadId)!.push({ from, date: '', subject, snippet });
    }

    async threadMessages(threadId: string) {
        return this.threads.get(threadId) ?? [];
    }

    async search(query: string) {
        return this.inbox.filter((m) => (query.includes('unsubscribe') ? /unsubscribe/i.test(m.subject) : /mailer-daemon|postmaster/.test(m.from)));
    }
}

export const contact = (over: Partial<ContactRecord> = {}): ContactRecord => ({
    id: 'p-sam',
    company_id: 'cahill-contractors',
    company_name: 'Cahill Contractors',
    name: 'Sam Estimator',
    title: 'Senior Estimator',
    role_category: 'estimating_preconstruction',
    business_email: 'sam@cahill.example',
    email_status: 'verified',
    verified: true,
    verify_notes: [],
    linkedin_url: null,
    company_phone: null,
    company_website: null,
    found_at: NOW.toISOString(),
    plan_id: 'x',
    ...over,
});

/** A database with Cahill (buyer, verified contact → CONTACT_READY) and a second Cahill project. */
export async function outreachSetup(over: { mode?: 'off' | 'test' | 'live'; authorized?: boolean; testPassed?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'outreach-'));
    const db = await LeadDatabase.load(join(dir, 'db.json'));
    const settings = LeadSettingsSchema.parse({});
    const researchCache = await loadCache(join(dir, 'r.json'), 30, NOW);
    const leads = [opp({ contractor: 'Cahill Contractors', score: 95 }), opp({ contractor: 'Cahill Contractors', score: 85 })];
    await evaluateOpportunities(leads, { settings, registry, db, researchCache, lookupHistory: async () => Promise.reject(new Error('offline')), now: NOW });
    db.setEnrichment('cahill-contractors', { status: 'enriched', at: NOW.toISOString(), plan_id: 'x', credits: 2, contact_ids: ['p-sam'], verified_contacts: 1 });
    for (const l of leads) db.setStatus(l.opportunity_id, 'CONTACT_READY', 'Verified decision maker', 'system', NOW);
    const contacts = await ContactStore.load(join(dir, 'contacts.json'));
    contacts.upsert(contact());
    const store = await OutreachStore.load(join(dir, 'outreach.json'));
    const suppression = await Suppression.load(join(dir, 'suppression.json'), join(dir, 'blocklist.txt'));
    const mailbox = new FakeMailbox();
    const config = OutreachConfigSchema.parse({
        mode: over.mode ?? 'live',
        liveAuthorization: over.authorized === false ? null : { by: 'Owner', date: '2026-10-23' },
        sender: { name: 'Pat Owner', title: 'Estimator', phone: '(555) 010-0000', licenseNumber: '0000000', postalAddress: '1 Example Way, San Francisco, CA 94100' },
        limits: { delaySeconds: 0 },
    });
    const deps = (now = NOW): OutreachDeps => ({
        db,
        contacts,
        store,
        suppression,
        state,
        provider: mailbox,
        config,
        env: { from: ME, testTo: TEST_TO },
        now,
        sleep: async () => {},
    });
    const state = { version: 1 as const, ...(over.testPassed === false ? {} : { test_passed_at: NOW.toISOString() }) };
    return { dir, db, contacts, store, suppression, mailbox, config, deps, leads, state };
}

export const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
