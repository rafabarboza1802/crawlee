import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { buildAccounts, searchNameFor } from '../../src/enrich/accounts.js';
import { domainFromUrl, nameSimilarity } from '../../src/enrich/apollo.js';
import { classifyOwner } from '../../src/enrich/buyers.js';
import { publicCompanyContacts } from '../../src/enrich/fallback.js';
import { applyBuyerGate } from '../../src/enrich/gate.js';
import { loadCache } from '../../src/enrich/store.js';
import { LeadDatabase } from '../../src/leads/db.js';
import { addLikelyDeveloper, isLikelyDeveloper, isSinglePurposeEntity } from '../../src/leads/identify.js';
import { evaluateOpportunities } from '../../src/leads/pipeline.js';
import { LeadSettingsSchema } from '../../src/leads/settings.js';
import { OutreachConfigSchema } from '../../src/outreach/config.js';
import { renderEmail } from '../../src/outreach/templates.js';
import { NOW, opp, registry } from './fixtures.js';

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('company names: permit spelling → business-database spelling', () => {
    test('search names drop legal suffixes, state words, JV markers and expand abbreviations', () => {
        expect(searchNameFor('Mercy Housing California')).toBe('Mercy Housing');
        expect(searchNameFor('G Swanson Constr. Inc.')).toBe('G Swanson Construction');
        expect(searchNameFor('Nibbi Bros. General Contractors, Inc.')).toBe('Nibbi Brothers General Contractors');
        expect(searchNameFor('Cahill Contractors LLC')).toBe('Cahill Contractors');
        expect(searchNameFor('Acme Holdings Inc dba Acme Builders')).toBe('Acme Builders');
        // DataSF cuts names at 40 characters: a cut-off trade name is not used.
        expect(searchNameFor('Andrew Chekene Enterprises/ Dba Ac Enter')).toBe('Andrew Chekene Enterprises');
    });

    test('Apollo name matching tolerates descriptive extra words and abbreviations, not different companies', () => {
        expect(nameSimilarity('Nibbi Brothers', 'Nibbi Brothers General Contractors')).toBeGreaterThanOrEqual(0.85);
        expect(nameSimilarity('Nibbi Bros', 'Nibbi Brothers')).toBe(1);
        expect(nameSimilarity('Cahill Contractors', 'Cahill Contractors, LLC')).toBe(1);
        expect(nameSimilarity('Pacific Construction', 'Atlantic Construction')).toBeLessThan(0.85);
        expect(nameSimilarity('Swinerton', 'Swinerton Builders')).toBeLessThan(0.85); // one-word names need an exact match
        expect(domainFromUrl('https://www.cahill-sf.com/about')).toBe('cahill-sf.com');
        expect(domainFromUrl('not a url')).toBeUndefined();
    });
});

describe('identifying the company behind a project', () => {
    test('law firms, expediters, architects and abbreviations are not developers; project LLCs are recognized', () => {
        for (const n of ['Reuben, Junius & Rose Llp.', 'SF Permitting', 'Handel Architects,Llp', 'Rkd Consulting Inc.', 'RJR', 'Ars', 'Bcci Construction Company']) {
            expect(isLikelyDeveloper(n), n).toBe(false);
        }
        for (const n of ['Mercy Housing California', 'Aralon Properties', 'Lennar']) expect(isLikelyDeveloper(n), n).toBe(true);
        expect(isSinglePurposeEntity('560 Brannan Street, LLC')).toBe(true);
        expect(isSinglePurposeEntity('Fillmore St Llc')).toBe(true);
        expect(isSinglePurposeEntity('Aralon Properties')).toBe(false);
    });

    test('no GC on the permit: the Development Pipeline sponsor, else a developer-like agent, becomes the owner contact', () => {
        const withSponsor = opp({ location: { address: '375 Laguna Honda Blvd', parcel: '2842/007' }, businesses: [{ role: 'architect', name: 'Ts Studio', source_url: 'https://data.sf.gov/x' }] });
        const sponsors = new Map([['2842007', { parcel: '2842007', sponsor: 'Mercy Housing California', sourceUrl: 'https://data.sf.gov/resource/6jgi-cpb4.json?blklot=2842007' }]]);
        expect(addLikelyDeveloper(withSponsor, sponsors)).toMatchObject({ role: 'owner_business', name: 'Mercy Housing California' });

        const lawFirmSponsor = opp({ location: { address: '3700 California St', parcel: '1016/002' }, businesses: [{ role: 'agent', name: 'Aralon Properties', source_url: 'https://data.sf.gov/x' }] });
        const rjr = new Map([['1016002', { parcel: '1016002', sponsor: 'RJR', sourceUrl: 'https://data.sf.gov/y' }]]);
        expect(addLikelyDeveloper(lawFirmSponsor, rjr)?.name).toBe('Aralon Properties');

        const hasGc = opp({ contractor: 'Cahill Contractors' });
        expect(addLikelyDeveloper(hasGc, sponsors)).toBeUndefined();
    });

    test('owner rule: large project → buyer; small → review; project LLC → review; risk word → researched like a contractor', () => {
        expect(classifyOwner('Mercy Housing California', undefined, false, 70e6, 159)).toMatchObject({ classification: 'buyer', source: 'owner_rule' });
        expect(classifyOwner('Small Owner Inc', undefined, false, 400_000, 2)?.classification).toBe('uncertain');
        expect(classifyOwner('560 Brannan Street, LLC', undefined, true, 50e6, 120)?.reason).toMatch(/Single-purpose project LLC/);
        expect(classifyOwner('Bay Paving Holdings', 'paving', false, 50e6, 0)).toBeUndefined();
    });

    test('pipeline: a qualified project without a GC gets its developer from public records and becomes a buyer lead', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'identify-'));
        const db = await LeadDatabase.load(join(dir, 'db.json'));
        const o = opp({ location: { address: '375 Laguna Honda Blvd', parcel: '2842/007' }, businesses: [], score: 92 });
        const run = await evaluateOpportunities([o], {
            settings: LeadSettingsSchema.parse({}),
            registry,
            db,
            researchCache: await loadCache(join(dir, 'r.json'), 30, NOW),
            lookupHistory: async () => Promise.reject(new Error('offline')),
            lookupSponsors: async () => new Map([['2842007', { parcel: '2842007', sponsor: 'Mercy Housing California', sourceUrl: 'https://data.sf.gov/resource/6jgi-cpb4.json?blklot=2842007' }]]),
            now: NOW,
        });
        expect(run.developersIdentified).toBe(1);
        const lead = db.lead(o.opportunity_id)!;
        expect(lead).toMatchObject({ status: 'QUALIFIED', company_id: 'mercy-housing' });
        expect(lead.project.companies).toContainEqual(expect.objectContaining({ role: 'developer', name: 'Mercy Housing California' }));
        expect(db.company('mercy-housing')).toMatchObject({ classification: 'buyer', source: 'owner_rule' });
        // A failing pipeline lookup is a warning, never a crash.
        const failing = await evaluateOpportunities([opp({ businesses: [], location: { address: '9 Main St', parcel: '0001/001' } })], {
            settings: LeadSettingsSchema.parse({}),
            registry,
            db,
            researchCache: await loadCache(join(dir, 'r.json'), 30, NOW),
            lookupHistory: async () => Promise.reject(new Error('offline')),
            lookupSponsors: async () => Promise.reject(new Error('HTTP 503')),
            now: NOW,
        });
        expect(failing.warnings).toEqual(['Development Pipeline lookup failed: HTTP 503']);
    });

    test('a GC on the permit always wins over the owner, and competitors stay blocked', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'identify2-'));
        const { accounts } = buildAccounts(
            [opp({ businesses: [{ role: 'contractor', name: 'Bay Cities Paving & Grading', source_url: 'https://x.example/' }, { role: 'owner_business', name: 'Big Owner Inc', source_url: 'https://x.example/' }] })],
            70,
        );
        const gate = await applyBuyerGate(accounts, registry, async () => Promise.reject(new Error('x')), await loadCache(join(dir, 'c.json'), 30, NOW), NOW);
        expect(gate.blocked.map((a) => a.displayName)).toEqual(['Bay Cities Paving & Grading']);
        expect(gate.buyers).toEqual([]);
    });
});

describe('fallback when Apollo has no verified email: the company website', () => {
    async function site(pages: Record<string, string>, robots = 'User-agent: *\nAllow: /\n') {
        const server = createServer((req, res) => {
            if (req.url === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(robots);
            const html = pages[req.url ?? '/'];
            if (!html) return void res.writeHead(404).end();
            res.writeHead(200, { 'content-type': 'text/html' }).end(html);
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        servers.push(server);
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    const ctx = { userAgent: 'BestConstructionBot/test', robotsToken: 'BestConstructionBot' };

    test('keeps only mailboxes the company publishes on its own domain; bid mailboxes are marked usable', async () => {
        const base = await site({
            '/': '<a href="/contact">Contact</a><a href="mailto:info@company.example">x</a>',
            '/contact': '<p>Subcontractors: <a href="mailto:bids@company.example">bids@company.example</a> · call (415) 555-0100 · other: estimating@gmail.com</p>',
        });
        // The local test server stands in for the company's website on company.example.
        const info = await publicCompanyContacts(base, ctx, { delayMs: 0, domain: 'company.example' });
        expect(info.emails).toEqual([
            { email: 'info@company.example', kind: 'general', sourceUrl: `${base}/` },
            { email: 'bids@company.example', kind: 'bid', sourceUrl: `${base}/contact` },
        ]);
        expect(info.phones).toContain('+14155550100');
    });

    test('respects robots.txt and stops at bot challenges', async () => {
        const blocked = await site({ '/': '<a href="mailto:bids@company.example">x</a>' }, 'User-agent: *\nDisallow: /\n');
        const none = await publicCompanyContacts(blocked, ctx, { delayMs: 0, domain: 'company.example' });
        expect([none.emails, none.pagesChecked]).toEqual([[], 0]);
        const challenge = await site({ '/': '<title>Just a moment...</title><div class="cf-challenge"></div>' });
        expect((await publicCompanyContacts(challenge, ctx, { delayMs: 0, domain: 'company.example' })).note).toMatch(/bot challenge/);
    });
});

describe('email variants', () => {
    const sender = OutreachConfigSchema.parse({}).sender;

    test('developer/owner version asks who runs the bids; bids mailbox gets a team greeting', () => {
        const lead = { project: { name: 'New 159-unit building — 375 Laguna Honda Blvd', address: '375 Laguna Honda Blvd', city: 'San Francisco', permit_contractor: null, target_scopes: ['Excavation', 'Sitework/earthwork'] } } as never;
        const owner = renderEmail(1, { firstName: 'Ana', company: 'Mercy Housing California', lead, otherLeads: [], sender, audience: 'owner' });
        expect(owner.text).toMatch(/^Hi Ana,/);
        expect(owner.text).toContain('Public records list Mercy Housing California on the new 159-unit building at 375 Laguna Honda Blvd, San Francisco.');
        expect(owner.text).toContain('If a general contractor is already running the bids, could you point us to them?');
        expect(owner.text).not.toMatch(/as the contractor/);
        const mailbox = renderEmail(1, { firstName: '', greeting: 'Hello estimating team,', company: 'Cahill Contractors', lead, otherLeads: [], sender, audience: 'contractor' });
        expect(mailbox.text).toMatch(/^Hello estimating team,/);
    });
});
