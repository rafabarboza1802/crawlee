import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import { ConfiguredSourceSchema, createConfiguredSource } from '../../src/discover/sources/configured.js';
import { startFakeSocrata } from '../discover/fake-socrata.js';
import { opp } from './fixtures.js';

const run = promisify(execFile);

describe('configured permit source (new county without code)', () => {
    const config = ConfiguredSourceSchema.parse({
        id: 'example-city',
        name: 'Example City Permits',
        city: 'Example City',
        county: 'Alameda',
        enabled: true,
        baseUrl: 'https://data.example.gov',
        permitsDataset: 'abcd-1234',
        dateColumns: ['applied'],
        fields: {
            permitNumber: 'permit_no',
            description: 'work_desc',
            status: 'current_status',
            estimatedCost: 'valuation',
            address: ['st_num', 'st_name'],
            contractorName: 'contractor_company',
            contractorLicense: 'contractor_lic',
        },
    });
    const ctx = (baseUrl: string) => ({ userAgent: 'BestConstructionBot/test', robotsToken: 'BestConstructionBot', baseUrl, log: () => {} });

    test('maps the columns, keeps only the contractor business, and checks the schema', async () => {
        const site = await startFakeSocrata({
            datasets: {
                'abcd-1234': [
                    { permit_no: 'P1', work_desc: 'Demolish garage and grade lot', current_status: 'Issued', valuation: '$450,000', st_num: '12', st_name: 'Main St', contractor_company: 'Acme Builders Inc', contractor_lic: '555', applied: '2026-10-01' },
                ],
                'wxyz-0000': [{ other: 1 }],
            },
        });
        try {
            const source = createConfiguredSource(config);
            const [permit] = await source.fetchPermits(ctx(site.baseUrl), { since: new Date('2026-09-01'), maxRows: 100 });
            expect(permit).toMatchObject({ sourceId: 'example-city', permitNumber: 'P1', stage: 'issued', estimatedCost: 450000, address: '12 Main St', county: 'Alameda' });
            expect(await source.fetchContacts!(ctx(site.baseUrl), ['P1'])).toEqual([{ permitNumber: 'P1', role: 'contractor', firmName: 'Acme Builders Inc', license: '555' }]);
            const wrong = createConfiguredSource({ ...config, permitsDataset: 'wxyz-0000' });
            await expect(wrong.fetchPermits(ctx(site.baseUrl), { since: new Date('2026-09-01'), maxRows: 100 })).rejects.toThrow(/column\(s\) permit_no, work_desc not found/);
        } finally {
            await site.close();
        }
    });
});

describe('daily commands', () => {
    // Offline: research points at a closed port, and the Apollo key and URL are fakes that are never reached.
    const env = { ...process.env, APOLLO_API_KEY: 'test-key', APOLLO_BASE_URL: 'http://127.0.0.1:9/api/v1', DISCOVER_BASE_URL: 'http://127.0.0.1:9' };
    const cli = (args: string[]) => run('npx', ['tsx', 'src/leads/main.ts', ...args], { cwd: new URL('../..', import.meta.url).pathname, env });

    test('find leads → prepare contacts (estimate only) → one approval for the exact batch', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'cmd-'));
        const input = join(dir, 'opps.jsonl');
        await writeFile(input, [opp({ contractor: 'Cahill Guzman Construction Group JV', score: 95 }), opp({ contractor: 'Unknown Builders Inc', score: 85 }), opp({ score: 40 })].map((o) => JSON.stringify(o)).join('\n'));
        const common = ['--data', join(dir, 'data'), '--config', join(dir, 'none.json'), '--settings', join(dir, 'none.json'), '--suppression', join(dir, 'none.txt')];

        const found = await cli(['find', '--input', input, ...common]);
        expect(found.stdout).toMatch(/Qualified projects \(score ≥ 70, verified real, current and in scope\): 2\n {2}QUALIFIED: 1 · NEEDS_REVIEW: 1/);
        expect(found.stdout).toMatch(/Best opportunities with an approved buyer\n {1,3}95 {2}New 120-unit building/);
        expect(found.stdout).toMatch(/Exact credits for this batch: 2 expected, 2 maximum/);
        expect(found.stdout).toMatch(/No Apollo credits were used/);
        const reports = await readdir(join(dir, 'data', 'reports'));
        for (const f of ['qualified-opportunities.csv', 'approved-buyers.csv', 'contacts-awaiting-enrichment.csv', 'rejected-competitors.csv', 'manual-review.csv', 'apollo-ledger.csv', 'summary.md']) {
            expect(reports).toContain(f);
        }
        expect(await readFile(join(dir, 'data', 'reports', 'manual-review.csv'), 'utf8')).toMatch(/Unknown Builders Inc/);

        const estimate = await cli(['contacts', ...common]);
        expect(estimate.stdout).toMatch(/ESTIMATE ONLY. No Apollo calls were made/);
        expect(estimate.stdout).toMatch(/EXACT CREDITS: 2 expected, 2 maximum/);
        const planId = /--approve ([0-9a-f]{12})/.exec(estimate.stdout)![1];
        await expect(cli(['contacts', '--approve', '000000000000', ...common])).rejects.toMatchObject({ stderr: expect.stringMatching(/batch changed/) });
        expect(planId).toMatch(/^[0-9a-f]{12}$/);
        expect(await readdir(join(dir, 'data'))).not.toContain('apollo-ledger.json');

        const status = await cli(['status', 'cahill', 'contacted', '--note', 'Called', ...common]);
        expect(status.stdout).toMatch(/→ {2}CONTACTED/);
    });
});
