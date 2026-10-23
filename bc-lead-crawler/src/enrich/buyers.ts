import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { PermitHistory } from './research.js';

/**
 * Buyer gate: every company is classified before it can reach Apollo.
 * - buyer: may proceed to enrichment;
 * - competitor: blocked (self-performs Best Construction's scopes, or is a trade/specialty contractor);
 * - uncertain: stops for manual review, never uses Apollo credits.
 */
export type BuyerClass = 'buyer' | 'competitor' | 'uncertain';

const RegistryCompany = z.object({
    name: z.string(),
    classification: z.enum(['buyer', 'competitor']),
    aliases: z.array(z.string()).default([]),
    licenses: z.array(z.string()).default([]),
    website: z.string().optional(),
    reason: z.string(),
    scope: z.string().optional(),
    evidence: z.array(z.string()).default([]),
    decidedBy: z.string().optional(),
    decided: z.string().optional(),
});

const RegistryJv = z.object({
    name: z.string(),
    aliases: z.array(z.string()).default([]),
    licenses: z.array(z.string()).default([]),
    /** The partner that runs subcontractor bidding; must itself be in `companies`. */
    managingGc: z.string(),
    evidence: z.array(z.string()).default([]),
    decidedBy: z.string().optional(),
    decided: z.string().optional(),
});

export const BuyerRegistrySchema = z.object({
    version: z.literal(1),
    updated: z.string().optional(),
    companies: z.array(RegistryCompany),
    jointVentures: z.array(RegistryJv).default([]),
    competitorNamePatterns: z.array(z.string()).default([]),
});
export type BuyerRegistry = z.infer<typeof BuyerRegistrySchema>;
type Company = z.infer<typeof RegistryCompany>;

export async function loadBuyerRegistry(path: string): Promise<BuyerRegistry> {
    const registry = BuyerRegistrySchema.parse(JSON.parse(await readFile(path, 'utf8')));
    for (const jv of registry.jointVentures) {
        if (!findByName(registry, jv.managingGc)) throw new Error(`Registry: managing GC "${jv.managingGc}" of "${jv.name}" is not listed in companies.`);
    }
    return registry;
}

export interface BuyerDecision {
    classification: BuyerClass;
    reason: string;
    evidence: string[];
    source: 'registry' | 'joint_venture' | 'name_rule' | 'permit_research';
    /** Company to enrich instead of the permit name (registry canonical name or a JV's managing GC). */
    resolvedName?: string;
    /** Original JV name when the decision was resolved through a joint venture. */
    jointVenture?: string;
    scope?: string;
    website?: string;
}

/** "W.E. O'Neil Construction Co." → "w e oneil construction co" */
export function normalizeName(name: string): string {
    return ` ${name
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()} `;
}

const matchesAlias = (name: string, alias: string) => normalizeName(name).includes(normalizeName(alias));

function findByName(registry: BuyerRegistry, name: string): Company | undefined {
    return registry.companies.find((c) => matchesAlias(name, c.name) || c.aliases.some((a) => matchesAlias(name, a)));
}

function findCompany(registry: BuyerRegistry, name: string, license?: string): Company | undefined {
    return (license ? registry.companies.find((c) => c.licenses.includes(license)) : undefined) ?? findByName(registry, name);
}

const JV_RE = /\b(?:jv|j\s?v|joint\s+venture)\b/i;

export function isJointVenture(name: string): boolean {
    return JV_RE.test(normalizeName(name));
}

function fromCompany(company: Company, source: BuyerDecision['source'], extra: Partial<BuyerDecision> = {}): BuyerDecision {
    return {
        classification: company.classification,
        reason: company.reason,
        evidence: company.evidence,
        source,
        resolvedName: company.name,
        ...(company.scope ? { scope: company.scope } : {}),
        ...(company.website ? { website: company.website } : {}),
        ...extra,
    };
}

/** Decision without network research: registry, joint ventures, name rules. Undefined = needs research. */
export function classifyFromRegistry(registry: BuyerRegistry, name: string, license?: string): BuyerDecision | undefined {
    if (isJointVenture(name)) {
        const jv =
            (license ? registry.jointVentures.find((j) => j.licenses.includes(license)) : undefined) ??
            registry.jointVentures.find((j) => matchesAlias(name, j.name) || j.aliases.some((a) => matchesAlias(name, a)));
        if (!jv) {
            return {
                classification: 'uncertain',
                reason: 'Joint venture: identify the managing GC that runs subcontractor bidding, then add it to the registry.',
                evidence: [],
                source: 'joint_venture',
                jointVenture: name,
            };
        }
        const gc = findByName(registry, jv.managingGc)!;
        return fromCompany(gc, 'joint_venture', {
            jointVenture: name,
            reason: `Joint venture; managing GC for subcontractor bidding is ${gc.name}. ${gc.reason}`,
            evidence: [...jv.evidence, ...gc.evidence],
        });
    }

    const company = findCompany(registry, name, license);
    if (company) return fromCompany(company, 'registry');

    const n = normalizeName(name);
    const pattern = registry.competitorNamePatterns.find((p) => n.includes(` ${normalizeName(p).trim()}`));
    if (pattern) {
        return {
            classification: 'competitor',
            reason: `Name indicates a specialty/trade or sitework contractor ("${pattern}"): not a buyer.`,
            evidence: [`Company name: ${name}`],
            source: 'name_rule',
        };
    }
    return undefined;
}

/** Thresholds for permit-history research. */
export const RESEARCH_RULES = {
    years: 3,
    /** Share of a company's own permits that are stand-alone demolition/grading/sitework: above this it self-performs. */
    specialistShare: 0.5,
    minPermitsForSpecialist: 3,
    largeGc: { minPermits: 10, minLargestValue: 5_000_000, minNewBuildings: 2, minTotalValue: 20_000_000 },
} as const;

const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`);

/**
 * Classifies a new company from its public San Francisco permit history (DataSF). This can prove that a company
 * self-performs (most of its permits are its own demolition/grading jobs) or that it is a large GC, but it cannot prove
 * that the company subcontracts sitework, so research alone never yields "buyer": large GCs go to manual review with
 * the evidence attached.
 */
export function classifyFromHistory(name: string, history: PermitHistory | undefined): BuyerDecision {
    const r = RESEARCH_RULES;
    if (!history) {
        return { classification: 'uncertain', reason: 'Permit research unavailable (DataSF not reachable): manual review.', evidence: [], source: 'permit_research' };
    }
    const summary = `${history.permits} SF permits as contractor since ${history.since} (${history.newBuildings} new buildings, total ${money(history.totalValue)}, largest ${money(history.largestValue)})`;
    const evidence = [summary, ...history.examples];
    if (history.permits >= r.minPermitsForSpecialist && history.specialistPermits / history.permits >= r.specialistShare) {
        return {
            classification: 'competitor',
            reason: `Self-performs demolition/grading/sitework: ${history.specialistPermits} of ${history.permits} of its own permits are stand-alone sitework.`,
            evidence,
            source: 'permit_research',
        };
    }
    const large =
        history.permits >= r.largeGc.minPermits &&
        history.largestValue >= r.largeGc.minLargestValue &&
        (history.newBuildings >= r.largeGc.minNewBuildings || history.totalValue >= r.largeGc.minTotalValue);
    return {
        classification: 'uncertain',
        reason: large
            ? `Large GC by permit history, but no public evidence yet that ${name} subcontracts sitework and does not self-perform it: confirm, then add to the registry.`
            : `Not shown to be a large GC (${summary}).`,
        evidence: history.permits ? evidence : [],
        source: 'permit_research',
    };
}
