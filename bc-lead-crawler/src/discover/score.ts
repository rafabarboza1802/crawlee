import { SERVICE_LABELS, SERVICE_POINTS } from './services.js';
import type { Business, NormalizedPermit, Opportunity, ScoreFactor, Service } from './types.js';

export interface ScoreInput {
    permit: NormalizedPermit;
    services: Service[];
    businesses: Business[];
    contactPolicy: Opportunity['contact_policy'];
    /** False when the source does not publish contractor/owner information at all. */
    sourcePublishesContacts: boolean;
    now: Date;
}

export interface ScoreResult {
    score: number;
    band: Opportunity['score_band'];
    factors: ScoreFactor[];
    summary: string;
}

const DAY = 86_400_000;

export function projectValue(permit: NormalizedPermit): { value: number | null; basis: Opportunity['value_basis'] } {
    if (permit.revisedCost && permit.revisedCost > 0) return { value: permit.revisedCost, basis: 'revised_cost' };
    if (permit.estimatedCost && permit.estimatedCost > 0) return { value: permit.estimatedCost, basis: 'estimated_cost' };
    return { value: null, basis: null };
}

/** Most recent public activity date on the permit. */
export function lastActivity(permit: NormalizedPermit): Date | undefined {
    const times = [permit.statusDate, permit.issuedDate, permit.filedDate]
        .map((d) => (d ? Date.parse(d) : NaN))
        .filter((t) => !Number.isNaN(t));
    return times.length ? new Date(Math.max(...times)) : undefined;
}

const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`);

/**
 * Transparent additive score (0–100). Every point is explained in `factors`:
 * service fit 40 · project value 20 · stage 15 · recency 15 · who to approach 10, plus adjustments.
 */
export function scoreOpportunity(input: ScoreInput): ScoreResult {
    const { permit, services, businesses, now } = input;
    const factors: ScoreFactor[] = [];

    // Service fit (max 40): best service tier + 2 per extra service (max +5).
    const ranked = [...services].sort((a, b) => SERVICE_POINTS[b] - SERVICE_POINTS[a]);
    const best = ranked[0];
    const fit = best ? Math.min(40, SERVICE_POINTS[best] + Math.min(5, 2 * (ranked.length - 1))) : 0;
    factors.push({
        factor: 'service_fit',
        points: fit,
        max: 40,
        detail: best ? `Matches ${ranked.map((s) => SERVICE_LABELS[s]).join(', ')}` : 'No matching service',
    });

    // Project value (max 20).
    const { value } = projectValue(permit);
    const valuePoints = value === null ? 6 : value >= 5e6 ? 20 : value >= 1e6 ? 17 : value >= 250e3 ? 13 : value >= 75e3 ? 9 : value >= 15e3 ? 5 : 2;
    factors.push({
        factor: 'project_value',
        points: valuePoints,
        max: 20,
        detail: value === null ? 'Value not published (neutral)' : `Estimated value ${money(value)}`,
    });

    // Stage (max 15).
    const stagePoints = { pre_construction: 15, issued: 12, stalled: 4, unknown: 6, inactive: 0 }[permit.stage];
    const stageDetail = {
        pre_construction: `Pre-construction (${permit.status}): bid window open`,
        issued: `Permit issued (${permit.status}): work starting, subs being hired`,
        stalled: `Stalled (${permit.status})`,
        unknown: `Status unclear (${permit.status ?? 'none'})`,
        inactive: `Inactive (${permit.status}): no work to bid`,
    }[permit.stage];
    factors.push({ factor: 'stage', points: stagePoints, max: 15, detail: stageDetail });

    // Recency (max 15).
    const last = lastActivity(permit);
    const ageDays = last ? Math.max(0, Math.floor((now.getTime() - last.getTime()) / DAY)) : undefined;
    const recencyPoints = ageDays === undefined ? 0 : ageDays <= 14 ? 15 : ageDays <= 30 ? 12 : ageDays <= 60 ? 9 : ageDays <= 90 ? 6 : ageDays <= 180 ? 3 : 0;
    factors.push({
        factor: 'recency',
        points: recencyPoints,
        max: 15,
        detail: ageDays === undefined ? 'No activity date published' : `Last activity ${ageDays} day(s) ago`,
    });

    // Who to approach (max 10).
    const contractor = businesses.find((b) => b.role === 'contractor' || b.role === 'owner_business');
    const designer = businesses.find((b) => b.role === 'architect' || b.role === 'engineer');
    let approachPoints: number;
    let approachDetail: string;
    if (input.contactPolicy === 'no_direct_contact') {
        approachPoints = 0;
        approachDetail = 'Homeowner project with no business contact: signal only';
    } else if (contractor) {
        approachPoints = 10;
        approachDetail = `Named ${contractor.role === 'contractor' ? 'contractor' : 'owner/developer'}: ${contractor.name}`;
    } else if (designer) {
        approachPoints = 6;
        approachDetail = `Named ${designer.role}: ${designer.name} (can point to the GC)`;
    } else if (!input.sourcePublishesContacts) {
        approachPoints = 4;
        approachDetail = 'Source does not publish contractors; look up via the permit record (neutral)';
    } else {
        approachPoints = 2;
        approachDetail = 'No contractor listed yet';
    }
    factors.push({ factor: 'approach', points: approachPoints, max: 10, detail: approachDetail });

    // Adjustments.
    if (/\brevision\b|\brev(?:\.|ision)? to\b|\bper (?:pa|permit)\b/i.test(permit.description)) {
        factors.push({ factor: 'adjustment', points: -5, max: 0, detail: 'Revision of an earlier permit' });
    }

    // Caps are recorded as an adjustment so the factors always add up to the score.
    const raw = factors.reduce((sum, f) => sum + f.points, 0);
    const [cap, capDetail] =
        permit.stage === 'inactive'
            ? [10, 'Inactive permit: capped at 10']
            : input.contactPolicy === 'no_direct_contact'
              ? [40, 'Homeowner project with no business to approach: signal only, capped at 40']
              : [100, 'Clamped to the 0–100 range'];
    const score = Math.max(0, Math.min(cap, raw));
    if (score !== raw) factors.push({ factor: 'adjustment', points: score - raw, max: 0, detail: score < raw ? capDetail : 'Clamped to the 0–100 range' });
    const band = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';
    const top = factors
        .filter((f) => f.points > 0 && f.factor !== 'adjustment')
        .sort((a, b) => b.points - a.points)
        .slice(0, 3)
        .map((f) => f.detail.charAt(0).toLowerCase() + f.detail.slice(1));
    return { score, band, factors, summary: `${score}/100 (${band}): ${top.join('; ')}` };
}
