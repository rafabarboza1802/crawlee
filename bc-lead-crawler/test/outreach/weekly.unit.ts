import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, test } from 'vitest';

import { opp } from '../leads/fixtures.js';

const run = promisify(execFile);
const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(handler: (path: string, body: string) => [number, unknown]) {
    const calls: { path: string; body: string }[] = [];
    const server = createServer(async (req, res) => {
        let body = '';
        for await (const c of req) body += c;
        calls.push({ path: req.url!, body });
        const [status, json] = handler(req.url!, body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    return { calls, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const FROM = 'outreach@bestconstruction.example';
const PROSPECT = 'sam@cahill.example';

async function fakes() {
    const apollo = await serve((path) => {
        if (path.endsWith('mixed_companies/search')) return [200, { organizations: [{ id: 'o1', name: 'Cahill Contractors', primary_domain: 'cahill.example', state: 'California' }] }];
        if (path.endsWith('mixed_people/api_search')) return [200, { people: [{ id: 'p1', first_name: 'Sam', last_name_obfuscated: 'E***r', title: 'Senior Estimator', state: 'California' }] }];
        if (path.endsWith('people/match')) return [200, { person: { id: 'p1', name: 'Sam Estimator', title: 'Senior Estimator', email: PROSPECT, email_status: 'verified' } }];
        return [404, {}];
    });
    const gmail = await serve((path) => {
        if (path === '/token') return [200, { access_token: 'at', expires_in: 3600 }];
        if (path === '/api/profile') return [200, { emailAddress: FROM }];
        if (path === '/api/messages/send') return [200, { id: 'm1', threadId: 't1' }];
        if (path.startsWith('/api/messages?')) return [200, { messages: [] }];
        if (path.startsWith('/api/threads/')) return [200, { messages: [] }];
        return [404, {}];
    });
    return { apollo, gmail };
}

describe('weekly run (cloud job) end to end — fake Apollo and fake Gmail, no real email', () => {
    test('discovers, buys within the credit limit, sends only test copies, encrypts private data, never re-buys', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'weekly-e2e-'));
        const data = join(dir, 'data');
        const input = join(dir, 'opps.jsonl');
        await writeFile(input, [opp({ contractor: 'Cahill Guzman Construction Group JV', score: 95 }), opp({ contractor: 'Swinerton Builders', score: 90 }), opp({ contractor: 'Unknown Builders Inc', score: 85 })].map((o) => JSON.stringify(o)).join('\n'));
        const { apollo, gmail } = await fakes();
        const env = {
            ...process.env,
            LEAD_DATA_KEY: 'test-data-key',
            APOLLO_API_KEY: 'test-apollo-key',
            APOLLO_BASE_URL: `${apollo.base}/api/v1`,
            GMAIL_CLIENT_ID: 'cid',
            GMAIL_CLIENT_SECRET: 'csecret',
            GMAIL_REFRESH_TOKEN: 'rtoken',
            GMAIL_TOKEN_URL: `${gmail.base}/token`,
            GMAIL_API_URL: `${gmail.base}/api`,
            OUTREACH_FROM: FROM,
            OUTREACH_TEST_TO: 'owner-test@bestconstruction.example',
            OWNER_REPORT_TO: 'owner@bestconstruction.example',
            DISCOVER_BASE_URL: 'http://127.0.0.1:9',
            OUTREACH_MODE: '',
        };
        const outreachConfig = join(dir, 'outreach.json');
        await writeFile(outreachConfig, JSON.stringify({ mode: 'test', limits: { delaySeconds: 0 } }));
        const weekly = (extra: string[] = []) =>
            run('npx', ['tsx', 'src/weekly/main.ts', '--data', data, '--input', input, '--outreach-config', outreachConfig, ...extra], { cwd: new URL('../..', import.meta.url).pathname, env });

        const first = await weekly();
        expect(first.stdout).toMatch(/\| Qualified leads \| 3 \|/);
        expect(first.stdout).toMatch(/\| Competitors blocked \| 1 \|/);
        expect(first.stdout).toMatch(/\| Contacts discovered \| 1 \|/);
        expect(first.stdout).toMatch(/\| Apollo credits used \| 2 \(month: 2\) \|/);
        expect(first.stdout).toMatch(/\| Email mode \| TEST \|/);
        expect(first.stdout).toMatch(/\| Test emails \(to your test address\) \| 1 \|/);
        expect(apollo.calls.map((c) => c.path.split('/').slice(-2).join('/'))).toEqual(['mixed_companies/search', 'mixed_people/api_search', 'people/match']);

        // Only the test address and the owner received anything; the prospect never did.
        const sends = gmail.calls.filter((c) => c.path === '/api/messages/send').map((c) => Buffer.from((JSON.parse(c.body) as { raw: string }).raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        expect(sends.map((r) => /^To: (.*)$/m.exec(r)![1])).toEqual(['owner-test@bestconstruction.example', 'owner@bestconstruction.example']);
        expect(sends[0]).toMatch(/Subject: \[TEST\] /);

        // Private data is encrypted; nothing personal in the committed files.
        const files = (await readdir(data, { recursive: true })).map(String).filter((f) => !f.startsWith('private/') && f !== 'private');
        expect(files).toContain('private.vault');
        expect(files).toContain('apollo-ledger.json');
        expect(files.some((f) => /^reports\/weekly\/\d{4}-\d{2}-\d{2}\.md$/.test(f))).toBe(true);
        for (const f of files) {
            const text = await readFile(join(data, f), 'utf8').catch(() => '');
            expect(text, f).not.toContain(PROSPECT);
            expect(text, f).not.toContain('Sam Estimator');
            expect(text, f).not.toMatch(/test-apollo-key|csecret|rtoken|test-data-key/);
        }

        // Second run: contact already bought and cached → no Apollo call; still test mode.
        await weekly();
        expect(apollo.calls).toHaveLength(3);
    });

    test('credit control: nothing is bought if a company does not fit in the per-run credit limit; missing key means no spend at all', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'weekly-cap-'));
        const input = join(dir, 'opps.jsonl');
        await writeFile(input, JSON.stringify(opp({ contractor: 'Cahill Contractors', score: 95 })));
        const enrich = join(dir, 'enrich.json');
        await writeFile(enrich, JSON.stringify({ autoEnrich: { enabled: true, maxCreditsPerRun: 1 } }));
        const { apollo } = await fakes();
        const base = { ...process.env, APOLLO_API_KEY: 'k', APOLLO_BASE_URL: `${apollo.base}/api/v1`, DISCOVER_BASE_URL: 'http://127.0.0.1:9', OUTREACH_MODE: '', GMAIL_CLIENT_ID: '', OUTREACH_FROM: '' };
        const cli = (env: NodeJS.ProcessEnv) =>
            run('npx', ['tsx', 'src/weekly/main.ts', '--data', join(dir, 'data'), '--input', input, '--enrich-config', enrich], { cwd: new URL('../..', import.meta.url).pathname, env }).catch((e: { stdout: string; stderr: string; code: number }) => e);
        const capped = await cli({ ...base, LEAD_DATA_KEY: 'k1' });
        expect(capped.stdout).toMatch(/waits for the next run \(credit limit for this run: 1\)/);
        const noKey = await cli({ ...base, LEAD_DATA_KEY: '' });
        expect((noKey as { code: number }).code).toBe(1);
        expect(noKey.stdout).toMatch(/LEAD_DATA_KEY is not set: contact lookups and email outreach are skipped/);
        expect(apollo.calls).toEqual([]);
    });
});
