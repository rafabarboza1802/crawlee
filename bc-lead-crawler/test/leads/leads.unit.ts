import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { EnrichConfigSchema } from '../../src/enrich/config.js';
import type { AccountResult } from '../../src/enrich/execute.js';
import type { PermitHistory } from '../../src/enrich/research.js';
import { loadCache } from '../../src/enrich/store.js';
import { recordEnrichment, verifyContact } from '../../src/leads/contacts.js';
import { ContactStore, LeadDatabase } from '../../src/leads/db.js';
import { evaluateOpportunities, planContactBatch, rankLeads } from '../../src/leads/pipeline.js';
import { bidTiming, describeProject, projectName, targetScopes, verifyProject } from '../../src/leads/project.js';
import { LeadSettingsSchema } from '../../src/leads/settings.js';
import { history, NOW, opp, registry } from './fixtures.js';

const settings = LeadSettingsSchema.parse({});
const config = EnrichConfigSchema.parse({});

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'leads-'));
    const db = await LeadDatabase.load(join(dir, 'lead-db.json'));
    const researchCache = await loadCache(join(dir, 'research.json'), 30, NOW);
    const apolloCache = await loadCache(join(dir, 'apollo.json'), 90, NOW);
    const contacts = await ContactStore.load(join(dir, 'private', 'contacts.json'));
    const lookups: string[] = [];
    const histories: Record<string, PermitHistory> = {
        '100': history({ permits: 40, newBuildings: 3, totalValue: 90e6, largestValue: 30e6 }), // large GC: manual review
        '200': history({ permits: 12, totalValue: 1.2e6, largestValue: 2e5 }), // small contractor: not a target
        '300': history({ permits: 10, specialistPermits: 8, totalValue: 3e6, largestValue: 5e5 }), // self-performs: competitor
        '400': history({ permits: 9, totalValue: 2e6, largestValue: 3e5 }), // name risk word, but no self-performing evidence
    };
    const lookupHistory = async (license: string) => {
        lookups.push(license);
        const h = histories[license];
        if (!h) throw new Error('offline');
        return h;
    };
    const evaluate = (opps: ReturnType<typeof opp>[], now = NOW) => evaluateOpportunities(opps, { settings, registry, db, researchCache, lookupHistory, now });
    return { dir, db, researchCache, apolloCache, contacts, lookups, evaluate };
}

describe('project facts', () => {
    test('target scopes, readable names and bid timing come from the public record', () => {
        const o = opp({ contractor: 'Cahill Contractors' });
        expect(targetScopes(o)).toEqual(['Excavation', 'Sitework/earthwork']);
        expect(projectName(o)).toMatch(/^New 120-unit building — \d+ Example St$/);
        expect(projectName(opp({ permit: { number: '1', type: 'otc alterations permit', stage: 'issued' }, project_description: '28th floor: t.i. new partitions, demo of ceilings and finishes' }))).toMatch(
            /^Tenant improvement new partitions, demo of ceilings/,
        );
        expect(bidTiming(o, NOW).bid_window).toBe('now');
        expect(bidTiming(opp({ permit: { number: '1', stage: 'issued', issued_date: '2026-10-20' } }), NOW).bid_window).toBe('soon');
        expect(bidTiming(opp({ permit: { number: '1', stage: 'issued', issued_date: '2026-01-20' } }), NOW).bid_window).toBe('started');
    });

    test('verification rejects inactive, expired, tiny, address-less and out-of-scope projects', () => {
        expect(verifyProject(opp(), settings, NOW)).toEqual([]);
        expect(verifyProject(opp({ permit: { number: '1', status: 'expired', stage: 'inactive' } }), settings, NOW)[0]).toMatch(/inactive|expired/);
        expect(verifyProject(opp({ estimated_value: 40_000 }), settings, NOW)[0]).toMatch(/below \$100K/);
        expect(verifyProject(opp({ location: {} }), settings, NOW)[0]).toMatch(/No project address/);
        expect(verifyProject(opp({ services: [{ service: 'remodel', evidence: [] }] }), settings, NOW)[0]).toMatch(/No Best Construction scope/);
        const interior = { services: [{ service: 'interior_demolition' as const, evidence: [] }], estimated_value: 600_000 };
        expect(verifyProject(opp(interior), settings, NOW)[0]).toMatch(/Small interior remodel/);
        expect(verifyProject(opp({ ...interior, estimated_value: 4_000_000 }), settings, NOW)).toEqual([]);
    });

    test('developer/owner: a business owner, else a developer-like permit agent, never the engineer or law firm', () => {
        const o = opp({
            businesses: [
                { role: 'engineer', name: 'Mar Structural Design', source_url: 'https://data.sf.gov/x' },
                { role: 'agent', name: 'Mar Structural Design', source_url: 'https://data.sf.gov/x' },
                { role: 'agent', name: 'Reuben, Junius & Rose Llp', source_url: 'https://data.sf.gov/x' },
                { role: 'agent', name: 'Mercy Housing Ca', source_url: 'https://data.sf.gov/x' },
                { role: 'contractor', name: 'Cahill Contractors', source_url: 'https://data.sf.gov/x' },
            ],
        });
        expect(describeProject(o, NOW, settings).developer_owner).toBe('Mercy Housing Ca (permit agent)');
    });
});

describe('lead pipeline: verify → score → classify → buyer gate', () => {
    test('every lead gets a clear status and only approved buyers need contacts', async () => {
        const s = await setup();
        const run = await s.evaluate([
            opp({ contractor: 'Cahill Guzman Construction Group JV', license: '9', score: 95 }),
            opp({ contractor: 'Cahill Contractors Inc', license: '8', score: 80 }),
            opp({ contractor: 'Bay Cities Paving & Grading Inc', score: 88 }),
            opp({ contractor: 'Large Builders Inc', license: '100', score: 86 }),
            opp({ contractor: 'Tiny Remodel Co', license: '200', score: 84, estimated_value: 900_000 }),
            opp({ contractor: 'Acme Demolition Inc', license: '300', score: 83, estimated_value: 800_000 }),
            opp({ contractor: 'Golden Grading Inc', license: '400', score: 82, estimated_value: 900_000 }),
            opp({ score: 81 }),
            opp({ contractor: 'Cahill Contractors', score: 55 }),
            opp({ contractor: 'Cahill Contractors', score: 90, estimated_value: 30_000 }),
        ]);
        const byGc = (name: string) => s.db.leads.filter((l) => l.project.permit_contractor === name).map((l) => l.status);
        expect(byGc('Cahill Guzman Construction Group JV')).toEqual(['QUALIFIED']);
        expect(byGc('Cahill Contractors Inc')).toEqual(['QUALIFIED']);
        expect(byGc('Bay Cities Paving & Grading Inc')).toEqual(['COMPETITOR']);
        expect(byGc('Large Builders Inc')).toEqual(['NEEDS_REVIEW']);
        expect(byGc('Tiny Remodel Co')).toEqual(['REJECTED']);
        expect(byGc('Acme Demolition Inc')).toEqual(['COMPETITOR']);
        // A risk word in the name is not enough to block: research found no self-performing.
        expect(byGc('Golden Grading Inc')).toEqual(['REJECTED']);
        expect(s.db.leads.find((l) => l.project.permit_contractor === 'Golden Grading Inc')!.status_reason).toMatch(/Small contractor.*Competitor-risk word/);
        expect(byGc('Cahill Contractors').sort()).toEqual(['REJECTED', 'REJECTED']);
        expect(s.db.leads.find((l) => !l.project.permit_contractor)!.status).toBe('QUALIFIED');
        expect(run).toMatchObject({ discovered: 10, newLeads: 10, qualified: 8 });

        // The JV and the GC are one company (the managing GC), remembered with the JV name.
        const cahill = s.db.company('cahill-contractors')!;
        expect(cahill).toMatchObject({ classification: 'buyer', joint_ventures: ['Cahill Guzman Construction Group JV'] });
        expect(s.db.leads.filter((l) => l.company_id === 'cahill-contractors' && l.status === 'QUALIFIED')).toHaveLength(2);
        expect(rankLeads(s.db.leads)[0]!.project.permit_contractor).toBe('Cahill Guzman Construction Group JV');
    });

    test('one project per permit: the same permit under a second address is a duplicate', async () => {
        const s = await setup();
        const a = opp({ contractor: 'Cahill Contractors', score: 90, permit: { number: 'P-93M', type: 'new construction', status: 'filed', stage: 'pre_construction' } });
        const b = { ...a, opportunity_id: 'sf-dbi:other-frontage', location: { address: '3881 Sacramento St' } };
        const run = await s.evaluate([a, b]);
        expect(run).toMatchObject({ discovered: 2, duplicates: 1, qualified: 1 });
        expect(s.db.leads).toHaveLength(1);
        // Already stored from an earlier run (and not in this batch)? It is closed as a duplicate of the current project.
        s.db.upsertLead({ lead_id: b.opportunity_id, last_seen_at: new Date(NOW.getTime() - 1000).toISOString(), project: s.db.lead(a.opportunity_id)!.project, company_id: null }, NOW);
        await s.evaluate([a], new Date(NOW.getTime() + 1000));
        expect(s.db.lead(b.opportunity_id)).toMatchObject({ status: 'REJECTED', status_reason: expect.stringMatching(/^Duplicate of .*same permit P-93M/) });
        expect(s.db.lead(a.opportunity_id)!.status).toBe('QUALIFIED');
    });

    test('the database remembers: no duplicate leads, no repeated research, owner statuses are never overwritten', async () => {
        const s = await setup();
        const leads = [opp({ contractor: 'Cahill Contractors', score: 90 }), opp({ contractor: 'Large Builders Inc', license: '100', score: 86 })];
        await s.evaluate(leads);
        const id = leads[0]!.opportunity_id;
        s.db.setStatus(id, 'WON', 'Won the sitework package', 'owner', NOW);
        const later = new Date(NOW.getTime() + 86_400_000);
        const again = await s.evaluate([...leads, leads[0]!], later);
        expect(again).toMatchObject({ discovered: 2, newLeads: 0 });
        expect(s.db.leads).toHaveLength(2);
        expect(s.lookups).toEqual(['100']);
        expect(s.db.lead(id)).toMatchObject({ status: 'WON', status_by: 'owner', last_seen_at: later.toISOString() });
        s.db.releaseStatus(id, later);
        await s.evaluate(leads, later);
        expect(s.db.lead(id)!.status).toBe('QUALIFIED');
    });

    test('contact batch: approved buyers only, exact credits, never bought twice', async () => {
        const s = await setup();
        await s.evaluate([
            opp({ contractor: 'Cahill Guzman Construction Group JV', score: 95 }),
            opp({ contractor: 'Nibbi Brothers', score: 88 }),
            opp({ contractor: 'Large Builders Inc', license: '100', score: 86 }),
        ]);
        const batch = await planContactBatch(s.db, registry, settings, config, s.apolloCache, s.researchCache, NOW);
        expect(batch.plans.map((p) => p.account.accountId)).toEqual(['cahill-contractors', 'nibbi-brothers']);
        expect(batch.estimate).toMatchObject({ creditsExpected: 4, creditsMax: 6 });

        // A lookup under the previous strategy that found no usable email gets exactly one retry...
        s.db.setEnrichment('nibbi-brothers', { status: 'no_people', at: NOW.toISOString(), plan_id: 'x', credits: 1, contact_ids: [], verified_contacts: 0 });
        expect((await planContactBatch(s.db, registry, settings, config, s.apolloCache, s.researchCache, NOW)).plans.map((p) => p.account.accountId)).toContain('nibbi-brothers');
        // ...and once the current strategy has run, never again.
        s.db.setEnrichment('nibbi-brothers', { status: 'no_people', at: NOW.toISOString(), plan_id: 'x', credits: 1, contact_ids: [], verified_contacts: 0, strategy: 2 });
        const next = await planContactBatch(s.db, registry, settings, config, s.apolloCache, s.researchCache, NOW);
        expect(next.plans.map((p) => p.account.accountId)).toEqual(['cahill-contractors']);
        expect(next.alreadyEnriched).toEqual(['Nibbi Brothers']);
        expect(next.estimate.planId).not.toBe(batch.estimate.planId);
    });

    test('verified contacts make a lead READY FOR OUTREACH; names and emails stay out of the public database', async () => {
        const s = await setup();
        await s.evaluate([opp({ contractor: 'Cahill Contractors', score: 95 })]);
        const batch = await planContactBatch(s.db, registry, settings, config, s.apolloCache, s.researchCache, NOW);
        const result: AccountResult = {
            accountId: 'cahill-contractors',
            status: 'enriched',
            org: { id: 'o1', name: 'Cahill Contractors', domain: 'cahill.example', phone: '+14155550100', matchScore: 1 },
            primary: { id: 'p1', name: 'Sam Estimator', title: 'Senior Estimator', email: 'sam@cahill.example', emailStatus: 'verified', roleCategory: 'estimating_preconstruction', rank: 0 },
            backups: [{ id: 'p2', name: 'Pat Manager', title: 'Project Manager', roleCategory: 'project_leadership', rank: 2 }],
            creditsSpent: 2,
        };
        const found = recordEnrichment([result], batch.plans, s.db, s.contacts, batch.estimate.planId, NOW);
        expect(found.map((c) => [c.name, c.verified])).toEqual([
            ['Sam Estimator', true],
            ['Pat Manager', false],
        ]);
        expect(s.db.leads[0]!.status).toBe('CONTACT_READY');
        await s.db.save(NOW);
        await s.contacts.save();
        const publicDb = await readFile(join(s.dir, 'lead-db.json'), 'utf8');
        expect(publicDb).not.toMatch(/Sam Estimator|sam@cahill\.example/);
        expect(await readFile(join(s.dir, 'private', 'contacts.json'), 'utf8')).toMatch(/sam@cahill\.example/);
        expect((await planContactBatch(s.db, registry, settings, config, s.apolloCache, s.researchCache, NOW)).plans).toEqual([]);
    });

    test('contact verification: verified business email on the company domain, decision-making title', () => {
        const person = { id: 'p', name: 'A', title: 'Estimator', email: 'a@other.com', emailStatus: 'verified', roleCategory: 'estimating_preconstruction', rank: 0 };
        const org = { id: 'o', name: 'X', domain: 'x.com' };
        expect(verifyContact(person, org)).toMatchObject({ verified: false, notes: [expect.stringMatching(/differs from company domain/)] });
        expect(verifyContact({ ...person, email: 'a@x.com' }, org).verified).toBe(true);
        expect(verifyContact({ ...person, email: 'a@x.com', emailStatus: 'guessed' }, org).verified).toBe(false);
        expect(verifyContact({ ...person, email: 'a@gmail.com' }, { id: 'o', name: 'X' }).verified).toBe(false);
    });
});
