import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { LeadDatabase } from '../../src/leads/db.js';
import { evaluateOpportunities } from '../../src/leads/pipeline.js';
import { LeadSettingsSchema } from '../../src/leads/settings.js';
import { loadCache } from '../../src/enrich/store.js';
import { buildMime, GmailProvider } from '../../src/outreach/gmail.js';
import { EmailAuthError } from '../../src/outreach/provider.js';
import { lockVault, open, seal, unlockVault, VaultKeyError } from '../../src/outreach/vault.js';
import { applyOwnerUpdates } from '../../src/weekly/owner-updates.js';
import { saveWeekly, type WeeklyMetrics, weeklyMarkdown } from '../../src/weekly/report.js';
import { NOW, opp, registry } from '../leads/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

/** Local stand-in for Google's token endpoint and the Gmail API. */
async function fakeGoogle(opts: { tokenStatus?: number } = {}) {
    const calls: { method: string; path: string; body: string; auth?: string }[] = [];
    const server: Server = createServer(async (req: IncomingMessage, res) => {
        let body = '';
        for await (const c of req) body += c;
        const path = req.url!;
        calls.push({ method: req.method!, path, body, auth: req.headers.authorization });
        const json = (status: number, v: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(v));
        };
        if (path === '/token') return opts.tokenStatus ? json(opts.tokenStatus, { error: 'invalid_grant' }) : json(200, { access_token: 'at-1', expires_in: 3600 });
        if (path === '/api/profile') return json(200, { emailAddress: 'Outreach@BestConstruction.example' });
        if (path === '/api/messages/send') return json(200, { id: 'm1', threadId: 't1' });
        if (path.startsWith('/api/threads/t1')) {
            return json(200, {
                messages: [
                    { payload: { headers: [{ name: 'From', value: 'outreach@bestconstruction.example' }, { name: 'Subject', value: 'Paving for 1 Main St' }] }, snippet: 'Hi Sam' },
                    { payload: { headers: [{ name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }, { name: 'X-Failed-Recipients', value: 'Sam@X.example' }] }, snippet: 'not delivered' },
                ],
            });
        }
        json(404, {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => server.close(() => r()));
    return { calls, urls: { token: `${base}/token`, api: `${base}/api` } };
}

const creds = { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken' };

describe('Gmail API client (OAuth, no password)', () => {
    test('refreshes an access token once, sends a threaded plain-text message with List-Unsubscribe, reads bounces', async () => {
        const g = await fakeGoogle();
        const gmail = new GmailProvider(creds, 'outreach@bestconstruction.example', g.urls);
        expect(await gmail.whoAmI()).toBe('outreach@bestconstruction.example');
        const sent = await gmail.send({ to: 'sam@x.example', subject: 'Paving for 1 Main St', text: 'Hi Sam,\nline 2', threadId: 't0', inReplyTo: '<a@b>', unsubscribeMailto: 'outreach@bestconstruction.example' });
        expect(sent).toMatchObject({ messageId: 'm1', threadId: 't1' });
        expect(g.calls.filter((c) => c.path === '/token')).toHaveLength(1);
        expect(new URLSearchParams(g.calls[0]!.body).get('grant_type')).toBe('refresh_token');
        const send = g.calls.find((c) => c.path === '/api/messages/send')!;
        expect(send.auth).toBe('Bearer at-1');
        const body = JSON.parse(send.body) as { raw: string; threadId: string };
        expect(body.threadId).toBe('t0');
        const raw = Buffer.from(body.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        expect(raw).toMatch(/^From: outreach@bestconstruction\.example\r\nTo: sam@x\.example\r\nSubject: Paving for 1 Main St\r\n/);
        expect(raw).toContain('In-Reply-To: <a@b>');
        expect(raw).toContain('List-Unsubscribe: <mailto:outreach@bestconstruction.example?subject=unsubscribe>');
        expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
        expect(raw).toMatch(/\r\n\r\nHi Sam,\r\nline 2$/);
        const thread = await gmail.threadMessages('t1');
        expect(thread[1]!.failedRecipients).toEqual(['sam@x.example']);
        // Credentials never appear in requests other than the token exchange.
        expect(g.calls.filter((c) => c.path !== '/token').some((c) => /csecret|rtoken/.test(c.body))).toBe(false);
    });

    test('a revoked or expired authorization is an EmailAuthError without credentials in the message', async () => {
        const g = await fakeGoogle({ tokenStatus: 400 });
        const gmail = new GmailProvider(creds, 'outreach@bestconstruction.example', g.urls);
        const error = await gmail.whoAmI().catch((e: Error) => e);
        expect(error).toBeInstanceOf(EmailAuthError);
        expect((error as Error).message).toMatch(/invalid_grant/);
        expect((error as Error).message).not.toMatch(/csecret|rtoken|cid/);
    });

    test('non-ASCII subjects are encoded', () => {
        expect(buildMime({ to: 'a@b.example', subject: 'Démolition', text: 'x' }, 'me@c.example').raw).toContain('Subject: =?UTF-8?B?');
    });
});

describe('encrypted private data vault', () => {
    test('round trip; wrong key or tampering fails; nothing readable without the key', async () => {
        const sealed = seal({ 'contacts.json': '{"sam@x.example":1}' }, 'correct horse battery staple');
        expect(sealed).not.toContain('sam@x.example');
        expect(open(sealed, 'correct horse battery staple')).toEqual({ 'contacts.json': '{"sam@x.example":1}' });
        expect(() => open(sealed, 'wrong key')).toThrow(VaultKeyError);
        const tampered = JSON.parse(sealed) as { data: string };
        tampered.data = Buffer.from('x' + Buffer.from(tampered.data, 'base64').toString('binary'), 'binary').toString('base64');
        expect(() => open(JSON.stringify({ ...JSON.parse(sealed), data: tampered.data }), 'correct horse battery staple')).toThrow(VaultKeyError);
    });

    test('lock/unlock data/private; a missing key is an explicit error', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'vault-'));
        const priv = join(dir, 'private');
        const vault = join(dir, 'private.vault');
        expect(await unlockVault(vault, priv, undefined)).toBe(false);
        await writeFile(join(dir, 'outreach.json'), '{}');
        await (await import('node:fs/promises')).mkdir(priv, { recursive: true });
        await writeFile(join(priv, 'contacts.json'), '{"a":"sam@x.example"}');
        await writeFile(join(priv, 'last-opportunities.jsonl'), 'big');
        expect(await lockVault(vault, priv, 'k')).toBe(1);
        await writeFile(join(priv, 'contacts.json'), 'overwritten');
        expect(await unlockVault(vault, priv, 'k')).toBe(true);
        expect(await readFile(join(priv, 'contacts.json'), 'utf8')).toBe('{"a":"sam@x.example"}');
        await expect(unlockVault(vault, priv, undefined)).rejects.toThrow(/LEAD_DATA_KEY is not set/);
    });
});

describe('weekly scheduler (GitHub Actions)', () => {
    const workflowPath = new URL('../../../.github/workflows/bc-weekly-leads.yml', import.meta.url);

    test('runs every Monday morning Pacific Time, in the cloud, and can be started by hand', async () => {
        const wf = await readFile(workflowPath, 'utf8');
        const cron = /cron: '([^']+)'/.exec(wf)![1]!;
        const [minute, hour, dom, month, dow] = cron.split(' ');
        expect([dom, month, dow]).toEqual(['*', '*', '1']);
        // Pacific is UTC-7 in summer and UTC-8 in winter: both must be a Monday morning.
        for (const offset of [7, 8]) {
            const local = Number(hour) - offset;
            expect(local).toBeGreaterThanOrEqual(6);
            expect(local).toBeLessThanOrEqual(10);
        }
        expect(Number(minute)).toBeGreaterThan(0);
        expect(wf).toMatch(/workflow_dispatch:/);
        expect(wf).toMatch(/runs-on: ubuntu-latest/);
        expect(wf).toMatch(/run: npm run weekly/);
        expect(wf).toMatch(/concurrency:/);
    });

    test('npm only runs inside bc-lead-crawler (the repository root requires pnpm via devEngines)', async () => {
        const wf = await readFile(workflowPath, 'utf8');
        // setup-node's npm cache runs `npm config get cache` in the repository root, which fails with EBADDEVENGINES.
        expect(wf).not.toMatch(/^\s*cache:\s*npm/m);
        expect(wf).toMatch(/node-version: 22/);
        expect(wf).toMatch(/defaults:\s*\n\s*run:\s*\n\s*working-directory: bc-lead-crawler/);
        const root = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { devEngines?: { packageManager?: { name: string } } };
        const own = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { devEngines?: unknown; engines?: { node?: string } };
        expect(root.devEngines?.packageManager?.name).toBe('pnpm');
        expect(own.devEngines).toBeUndefined();
        expect(own.engines?.node).toBe('>=22');
    });

    test('secrets only come from GitHub Secrets, and private data can never be committed', async () => {
        const wf = await readFile(workflowPath, 'utf8');
        for (const name of ['LEAD_DATA_KEY', 'APOLLO_API_KEY', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'OUTREACH_FROM', 'OUTREACH_TEST_TO', 'OWNER_REPORT_TO']) {
            expect(wf).toContain(`${name}: \${{ secrets.${name} }}`);
        }
        expect(wf).toMatch(/Refusing to commit private data/);
        expect(wf).toMatch(/\[skip ci\]/);
        const gitignore = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');
        expect(gitignore).toMatch(/^data\/private$/m);
        expect(gitignore).toMatch(/^\.env/m);
    });
});

describe('owner updates and weekly report', () => {
    async function db() {
        const dir = await mkdtemp(join(tmpdir(), 'weekly-'));
        const d = await LeadDatabase.load(join(dir, 'db.json'));
        const leads = [opp({ contractor: 'Cahill Contractors', score: 95 })];
        await evaluateOpportunities(leads, { settings: LeadSettingsSchema.parse({}), registry, db: d, researchCache: await loadCache(join(dir, 'r.json'), 30, NOW), lookupHistory: async () => Promise.reject(new Error('x')), now: NOW });
        return { dir, d, leads };
    }

    test('owner-updates.csv: each row applied once; STOP means do-not-contact; unknown rows are reported', async () => {
        const { dir, d, leads } = await db();
        const csv = join(dir, 'owner-updates.csv');
        await writeFile(csv, 'lead_or_company,status,note\nCahill Contractors,BID_INVITED,Invite received\nNobody Inc,WON,\nCahill Contractors,maybe,\n');
        const first = await applyOwnerUpdates(csv, d, NOW);
        expect(first.applied).toEqual(['Cahill Contractors → BID_INVITED (1 lead)']);
        expect(first.problems).toHaveLength(2);
        expect(d.lead(leads[0]!.opportunity_id)).toMatchObject({ status: 'BID_INVITED', status_by: 'owner', owner_note: 'Invite received' });
        expect((await applyOwnerUpdates(csv, d, NOW)).applied).toEqual([]);
        await writeFile(csv, 'lead_or_company,status,note\nCahill Contractors,STOP,\n');
        await applyOwnerUpdates(csv, d, NOW);
        expect(d.lead(leads[0]!.opportunity_id)!.status).toBe('DO_NOT_CONTACT');
    });

    test('weekly report: every metric, failed sources shown, no email addresses, history kept per week', async () => {
        const { dir, d } = await db();
        const m: WeeklyMetrics = {
            date: '2026-10-26',
            sources: [
                { id: 'sf-dbi', name: 'SF permits', ok: true, permits: 3400, opportunities: 700, newOpportunities: 50 },
                { id: 'x', name: 'Broken county', ok: false, permits: 0, opportunities: 0, newOpportunities: 0, error: 'HTTP 503' },
            ],
            projectsScanned: 3400,
            newOpportunities: 50,
            qualified: 12,
            rejected: 600,
            needsReview: 4,
            competitorsBlocked: 2,
            contactsDiscovered: 1,
            verifiedEmails: 1,
            companiesIdentified: 3,
            notEnriched: ['Example GC: no verified email'],
            apolloCredits: 2,
            apolloCreditsMonth: 2,
            apolloCostUsd: null,
            emailMode: 'test',
            emailsSent: 0,
            followUpsSent: 0,
            testEmails: 1,
            replies: 0,
            bounces: 0,
            optOuts: 0,
            bidInvitations: 0,
            queued: 1,
            errors: ['Source Broken county failed: HTTP 503'],
            notes: [],
        };
        const md = weeklyMarkdown(m, d);
        for (const label of ['Projects scanned', 'New opportunities', 'Qualified leads', 'Rejected opportunities', 'Leads requiring review', 'Competitors blocked', 'Companies identified', 'Contacts discovered', 'Verified business emails', 'Contacts that could not be enriched', 'Apollo credits used', 'Estimated Apollo cost', 'Emails sent', 'Follow-ups sent', 'Replies', 'Bounces', 'Opt-outs', 'Bid invitations', 'Top opportunities']) {
            expect(md).toContain(label);
        }
        expect(md).toMatch(/❌ Broken county: FAILED — HTTP 503/);
        expect(md).not.toMatch(/@/);
        await saveWeekly(dir, m, md);
        await saveWeekly(dir, { ...m, date: '2026-11-02', qualified: 15 }, md);
        await saveWeekly(dir, { ...m, date: '2026-11-02', qualified: 16 }, md);
        const history = (await readFile(join(dir, 'weekly-history.csv'), 'utf8')).trim().split('\n');
        expect(history).toHaveLength(3);
        expect(history[2]).toMatch(/^2026-11-02,1,1,3400,50,16,/);
        expect(history[0]).toContain('companies_identified,contacts_discovered,verified_emails');
        expect(await readFile(join(dir, 'weekly', '2026-10-26.md'), 'utf8')).toBe(md);
    });
});
