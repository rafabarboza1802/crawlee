import type { Opportunity } from '../discover/types.js';
import { type Account, buildAccounts } from '../enrich/accounts.js';
import type { BuyerRegistry } from '../enrich/buyers.js';
import type { EnrichConfig } from '../enrich/config.js';
import { applyBuyerGate, type HistoryLookup } from '../enrich/gate.js';
import { type AccountPlan, type Estimate, estimate, planAccount } from '../enrich/plan.js';
import type { FileCache, LookupCache } from '../enrich/store.js';
import type { LeadDatabase } from './db.js';
import { describeProject, verifyProject } from './project.js';
import type { LeadSettings } from './settings.js';
import type { CompanyRecord, LeadRecord, LeadStatus } from './types.js';

export interface EvaluateOptions {
    settings: LeadSettings;
    registry: BuyerRegistry;
    db: LeadDatabase;
    researchCache: FileCache;
    lookupHistory: HistoryLookup;
    suppressed?: Set<string>;
    now: Date;
}

export interface EvaluateResult {
    discovered: number;
    newLeads: number;
    /** Projects that passed verification and the minimum score. */
    qualified: number;
    /** Where the qualified projects ended up, by lead status. */
    qualifiedByStatus: Partial<Record<LeadStatus, number>>;
    /** Rejected before qualifying (score, size, inactive, no target scope, homeowner) or after the company check. */
    rejected: number;
    buyers: Account[];
    competitors: Account[];
    notPursued: Account[];
    review: Account[];
    /** Leads touched by this run, best first. */
    leads: LeadRecord[];
}

const STATUS_RANK: Partial<Record<LeadStatus, number>> = {
    'BID OPPORTUNITY': 0,
    'READY FOR OUTREACH': 1,
    'CONTACT FOUND': 2,
    'CONTACT NEEDED': 3,
    'BUYER VERIFIED': 4,
    'FOLLOW-UP': 5,
    CONTACTED: 6,
    QUALIFIED: 7,
    RESEARCHING: 8,
};
const WINDOW_RANK = { now: 0, soon: 1, started: 2, watch: 3 } as const;

/** Best leads first: actionable status, Bay Area priority county, open bid window, then score. */
export function rankLeads(leads: LeadRecord[]): LeadRecord[] {
    return [...leads].sort(
        (a, b) =>
            (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99) ||
            Number(b.project.priority_area) - Number(a.project.priority_area) ||
            WINDOW_RANK[a.project.bid_window] - WINDOW_RANK[b.project.bid_window] ||
            b.project.score - a.project.score,
    );
}

/** A pursuable lead: qualified project, not rejected or a competitor. */
export const isActive = (l: LeadRecord) => STATUS_RANK[l.status] !== undefined;

/** Lead status for an approved buyer, from what the (public) database knows about its contact lookup. */
export function buyerStatus(company: CompanyRecord | undefined): [LeadStatus, string] {
    const e = company?.enrichment;
    if (!e) return ['CONTACT NEEDED', 'Approved buyer: decision-maker lookup not done yet (prepare contacts).'];
    if (e.verified_contacts > 0) return ['READY FOR OUTREACH', `Verified decision maker found ${e.at.slice(0, 10)} (see the private contacts report).`];
    if (e.contact_ids.length > 0) return ['CONTACT FOUND', `Decision maker found ${e.at.slice(0, 10)}, but no verified business email.`];
    if (e.status.startsWith('stopped')) return ['CONTACT NEEDED', `Previous lookup stopped (${e.status}); will be retried.`];
    return ['BUYER VERIFIED', `Contact lookup found nobody usable (${e.status}${e.note ? `: ${e.note}` : ''}). Use the company phone or the LinkedIn search link.`];
}

function exclusionStatus(reason: string): [LeadStatus, string] {
    if (/^Public agency/.test(reason)) return ['QUALIFIED', 'Public project: watch for the prime contractor award, then bid to the prime.'];
    if (/^No contractor/.test(reason)) return ['QUALIFIED', 'No GC named on the permit yet: watch for the contractor.'];
    return ['REJECTED', reason];
}

/**
 * VERIFY PROJECT → SCORE → CLASSIFY COMPANY → BUYER GATE for one batch of discovered opportunities, recording every
 * lead and company in the master database. Free: the only network use is public DataSF research (cached).
 */
export async function evaluateOpportunities(opportunities: Opportunity[], options: EvaluateOptions): Promise<EvaluateResult> {
    const { settings, db, now } = options;
    let newLeads = 0;
    let rejected = 0;
    const touched = new Set<string>();
    const qualified: Opportunity[] = [];

    // Deduplicate: one record per project (the opportunity id is the parcel/address key).
    const unique = new Map<string, Opportunity>();
    for (const o of opportunities) if (!unique.has(o.opportunity_id) || unique.get(o.opportunity_id)!.score < o.score) unique.set(o.opportunity_id, o);

    for (const o of unique.values()) {
        const problems = verifyProject(o, settings, now);
        const passes = o.score >= settings.minScore && problems.length === 0;
        if (db.upsertLead({ lead_id: o.opportunity_id, last_seen_at: now.toISOString(), project: describeProject(o, now, settings), company_id: null, ...(passes ? { opportunity: o } : {}) }, now)) newLeads++;
        touched.add(o.opportunity_id);
        if (passes) {
            qualified.push(o);
            continue;
        }
        rejected++;
        db.setStatus(o.opportunity_id, 'REJECTED', o.score < settings.minScore ? `Score ${o.score} is below ${settings.minScore}.` : problems.join('; '), 'system', now);
    }

    const { accounts, excluded } = buildAccounts(qualified, settings.minScore, options.suppressed);
    for (const e of excluded) {
        const [status, reason] = exclusionStatus(e.reason);
        if (status === 'REJECTED') rejected++;
        db.setStatus(e.opportunity.opportunity_id, status, reason, 'system', now);
    }

    const gate = await applyBuyerGate(accounts, options.registry, options.lookupHistory, options.researchCache, now);
    const record = (a: Account, status: LeadStatus, reason: string) => {
        const decision = a.buyer!;
        const name = decision.classification === 'buyer' ? (decision.resolvedName ?? a.displayName) : a.displayName;
        const company = db.upsertCompany(
            {
                company_id: a.accountId,
                name,
                license: a.license ?? null,
                classification: decision.classification,
                reason: decision.reason,
                evidence: decision.evidence,
                source: decision.source,
                ...(decision.scope ? { scope: decision.scope } : {}),
                ...(decision.website ? { website: decision.website } : {}),
                ...(decision.riskSignal ? { risk_signal: decision.riskSignal } : {}),
                ...(decision.jointVenture ? { joint_ventures: [decision.jointVenture] } : {}),
                last_classified_at: now.toISOString(),
            },
            now,
        );
        const [finalStatus, finalReason] = decision.classification === 'buyer' ? buyerStatus(company) : [status, reason];
        for (const o of a.opportunities) {
            const lead = db.lead(o.opportunity_id)!;
            lead.company_id = a.accountId;
            lead.project.general_contractor = a.displayName;
            db.setStatus(o.opportunity_id, finalStatus, finalReason, 'system', now);
        }
    };
    for (const a of gate.buyers) record(a, 'CONTACT NEEDED', '');
    for (const a of gate.blocked) record(a, 'COMPETITOR', `Competitor: ${a.buyer!.reason}`);
    for (const a of gate.excluded) {
        rejected += a.opportunities.length;
        record(a, 'REJECTED', a.buyer!.classification === 'not_target' ? a.buyer!.reason : `Do not enrich: ${a.buyer!.reason}`);
    }
    for (const a of gate.review) record(a, 'RESEARCHING', `Manual review: ${a.buyer!.reason}`);

    const qualifiedByStatus: Partial<Record<LeadStatus, number>> = {};
    for (const o of qualified) {
        const status = db.lead(o.opportunity_id)!.status;
        qualifiedByStatus[status] = (qualifiedByStatus[status] ?? 0) + 1;
    }
    return {
        discovered: unique.size,
        newLeads,
        qualified: qualified.length,
        qualifiedByStatus,
        rejected,
        buyers: gate.buyers,
        competitors: gate.blocked,
        notPursued: gate.excluded,
        review: gate.review,
        leads: rankLeads([...touched].map((id) => db.lead(id)!)),
    };
}

export interface ContactBatch {
    plans: AccountPlan[];
    deferred: AccountPlan[];
    estimate: Estimate;
    /** Buyers skipped because they were already looked up (never bought twice). */
    alreadyEnriched: string[];
}

/**
 * The next contact-enrichment batch: approved buyers with leads in CONTACT NEEDED that meet the minimum score and have
 * not been looked up before. Pure planning — nothing is sent.
 */
export async function planContactBatch(
    db: LeadDatabase,
    registry: BuyerRegistry,
    settings: LeadSettings,
    config: EnrichConfig,
    apolloCache: LookupCache,
    researchCache: FileCache,
    now: Date,
    limit = Infinity,
): Promise<ContactBatch> {
    const opportunities = db.leads.filter((l) => l.status === 'CONTACT NEEDED' && l.opportunity && l.project.score >= settings.minScore).map((l) => l.opportunity!);
    const { accounts } = buildAccounts(opportunities, Math.max(settings.minScore, config.minOpportunityScore));
    // Buyers are decided by the registry; no research (and no network) is needed here.
    const gate = await applyBuyerGate(
        accounts,
        registry,
        async () => {
            throw new Error('offline');
        },
        researchCache,
        now,
    );
    const alreadyEnriched = gate.buyers.filter((a) => db.company(a.accountId)?.enrichment && !db.company(a.accountId)!.enrichment!.status.startsWith('stopped'));
    const todo = gate.buyers.filter((a) => !alreadyEnriched.includes(a)).sort((a, b) => b.bestScore - a.bestScore);
    const perRun = Math.min(config.maxAccountsPerRun, limit);
    const plans = todo.slice(0, perRun).map((a) => planAccount(a, config, apolloCache));
    const deferred = todo.slice(perRun).map((a) => planAccount(a, config, apolloCache));
    return { plans, deferred, estimate: estimate(plans, config, now), alreadyEnriched: alreadyEnriched.map((a) => a.displayName) };
}
