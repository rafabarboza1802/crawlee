import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { PermitHistory } from './research.js';

/**
 * Buyer gate: every company is classified before it can reach Apollo.
 * - buyer: may proceed to enrichment;
 * - competitor: blocked (self-performs Best Construction's scopes, or is a trade/specialty contractor);
 * - uncertain: stops for manual review, never uses Apollo credits;
 * - do_not_enrich: owner decision to skip (e.g. a JV partner that is not the bidding contact); never uses credits;
 * - not_target: public evidence shows a small contractor, not the large GC/developer Best Construction sells to.
 */
export type BuyerClass = 'buyer' | 'competitor' | 'uncertain' | 'do_not_enrich' | 'not_target';

const RegistryCompany = z.object({
    name: z.string(),
    /** "uncertain" records research notes for a company that still needs a decision. */
    classification: z.enum(['buyer', 'competitor', 'uncertain', 'do_not_enrich', 'not_target']),
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
    /** Name words that signal a possible competitor. They trigger research and a flag, never a block on their own. */
    competitorRiskPatterns: z.array(z.string()).default([]),
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
    source: 'registry' | 'joint_venture' | 'permit_research' | 'owner_rule';
    /** Company to enrich instead of the permit name (registry canonical name or a JV's managing GC). */
    resolvedName?: string;
    /** Original JV name when the decision was resolved through a joint venture. */
    jointVenture?: string;
    scope?: string;
    website?: string;
    /** Competitor-risk word found in the name (research decides; the word alone never blocks). */
    riskSignal?: string;
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

/** Competitor-risk word in the company name, if any. */
export function competitorRiskSignal(registry: BuyerRegistry, name: string): string | undefined {
    const n = normalizeName(name);
    return registry.competitorRiskPatterns.find((p) => n.includes(` ${normalizeName(p).trim()}`));
}

/** Decision without network research: registry and joint ventures. Undefined = needs research. */
export function classifyFromRegistry(registry: BuyerRegistry, name: string, license?: string): BuyerDecision | undefined {
    if (isJointVenture(name)) {
        const jv =
            (license ? registry.jointVentures.find((j) => j.licenses.includes(license)) : undefined) ??
            registry.jointVentures.find((j) => matchesAlias(name, j.name) || j.aliases.some((a) => matchesAlias(name, a)));
        if (!jv) {
            // JV names list partners by their first word ("Cahill Guzman ... JV"): a hint only, never a decision.
            const firstWord = (n: string) => normalizeName(n).trim().split(' ')[0] ?? '';
            const partners = registry.companies.filter((c) => c.classification === 'buyer' && firstWord(c.name).length >= 4 && matchesAlias(name, firstWord(c.name)));
            const hint = partners.length ? ` Partner already approved as a buyer: ${partners.map((c) => c.name).join(', ')} (confirm it runs the JV's bidding).` : '';
            return {
                classification: 'uncertain',
                reason: `Joint venture: identify the managing GC that runs subcontractor bidding, then add it to the registry.${hint}`,
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
    return company ? fromCompany(company, 'registry') : undefined;
}

/** Owner-side rule thresholds: a named developer/owner of a project at least this large is a buyer. */
export const OWNER_RULE = { minProjectValue: 1_000_000, minUnits: 10 } as const;

/**
 * Developers and business owners hire the GC and buy site work; they are not competitors. A named owner-side business
 * on a large qualified project is a buyer, unless its name carries a competitor-risk word (then it is researched like a
 * contractor) or it is a single-purpose project LLC (the developer behind it is unknown).
 */
export function classifyOwner(name: string, riskSignal: string | undefined, singlePurpose: boolean, projectValue: number, units: number): BuyerDecision | undefined {
    if (riskSignal) return undefined;
    if (singlePurpose) {
        return { classification: 'uncertain', reason: `Single-purpose project LLC: identify the developer behind ${name} before contacting.`, evidence: [], source: 'owner_rule' };
    }
    const large = projectValue >= OWNER_RULE.minProjectValue || units >= OWNER_RULE.minUnits;
    return large
        ? {
              classification: 'buyer',
              reason: `Developer/owner named in public records on a ${projectValue >= 1e6 ? `$${(projectValue / 1e6).toFixed(1)}M` : `${units}-unit`} project: owners hire the GC and buy site work, and are not competitors.`,
              evidence: ['Named as owner/sponsor/applicant in DataSF permit or pipeline records'],
              source: 'owner_rule',
          }
        : { classification: 'uncertain', reason: `Owner-side business on a small project: manual review.`, evidence: [], source: 'owner_rule' };
}

/** Thresholds for permit-history research. */
export const RESEARCH_RULES = {
    years: 3,
    /** Share of a company's own permits that are stand-alone demolition/grading/sitework: above this it self-performs. */
    specialistShare: 0.5,
    minPermitsForSpecialist: 3,
    largeGc: { minPermits: 10, minLargestValue: 5_000_000, minNewBuildings: 2, minTotalValue: 20_000_000 },
    /** Below all of these, and on a small current project, the company is a small contractor: not a target buyer. */
    small: { maxTotalValue: 5_000_000, maxLargestValue: 2_000_000, maxProjectValue: 5_000_000 },
} as const;

const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`);

/**
 * Classifies a new company from its public San Francisco permit history (DataSF). This can prove that a company
 * self-performs (most of its permits are its own demolition/grading jobs) or that it is a large GC. Large GCs that do not
 * self-perform are buyers (they bid out site packages), so their estimators and PMs are looked up; a competitor-risk
 * word in the name still sends them to manual review. Small contractors (small permit history, no new buildings, small current project) are not
 * target buyers. `projectValue` is the largest current opportunity, so a big out-of-town GC is never dismissed as small.
 */
export function classifyFromHistory(name: string, history: PermitHistory | undefined, riskSignal?: string, projectValue = 0): BuyerDecision {
    const r = RESEARCH_RULES;
    const risk = riskSignal ? { riskSignal } : {};
    const flag = riskSignal ? ` Competitor-risk word in name ("${riskSignal}"): research its own work before deciding.` : '';
    if (!history) {
        return { classification: 'uncertain', reason: `Permit research unavailable (DataSF not reachable): manual review.${flag}`, evidence: [], source: 'permit_research', ...risk };
    }
    const summary = `${history.permits} SF permits as contractor since ${history.since} (${history.newBuildings} new buildings, total ${money(history.totalValue)}, largest ${money(history.largestValue)})`;
    const evidence = [summary, ...history.examples];
    if (history.permits >= r.minPermitsForSpecialist && history.specialistPermits / history.permits >= r.specialistShare) {
        return {
            classification: 'competitor',
            reason: `Self-performs demolition/grading/sitework: ${history.specialistPermits} of ${history.permits} of its own permits are stand-alone sitework.`,
            evidence,
            source: 'permit_research',
            ...risk,
        };
    }
    const small =
        history.newBuildings === 0 &&
        history.totalValue < r.small.maxTotalValue &&
        history.largestValue < r.small.maxLargestValue &&
        projectValue < r.small.maxProjectValue;
    if (small) {
        return {
            classification: 'not_target',
            reason: `Small contractor, not a target buyer: ${summary}.${flag}`,
            evidence: history.permits ? evidence : [],
            source: 'permit_research',
            ...risk,
        };
    }
    const large =
        history.permits >= r.largeGc.minPermits &&
        history.largestValue >= r.largeGc.minLargestValue &&
        (history.newBuildings >= r.largeGc.minNewBuildings || history.totalValue >= r.largeGc.minTotalValue);
    if (large && !riskSignal) {
        return {
            classification: 'buyer',
            reason: `Large GC by permit history (${summary}), not a sitework specialist: approved for contact lookup. Add it to the registry as a competitor if it self-performs sitework.`,
            evidence,
            source: 'permit_research',
        };
    }
    return {
        classification: 'uncertain',
        reason:
            (large
                ? `Large GC by permit history, but no public evidence yet that ${name} subcontracts sitework and does not self-perform it: confirm, then add to the registry.`
                : `Mid-size contractor, not shown to be a large GC (${summary}): check whether it bids out sitework.`) + flag,
        evidence: history.permits ? evidence : [],
        source: 'permit_research',
        ...risk,
    };
}
