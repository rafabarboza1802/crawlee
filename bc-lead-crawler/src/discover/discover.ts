import type { PermitContact } from './businesses.js';
import { toBusinesses } from './businesses.js';
import { classify } from './classify.js';
import { lastActivity, projectValue, scoreOpportunity } from './score.js';
import { matchServices } from './services.js';
import type { PermitSource, SourceContext } from './sources/source.js';
import type { DiscoveryState } from './state.js';
import type { Business, NormalizedPermit, Opportunity, Service } from './types.js';
import { OpportunitySchema } from './types.js';

export interface DiscoverOptions {
    source: PermitSource;
    ctx: SourceContext;
    /** Look-back window in days. */
    days: number;
    now?: Date;
    maxRows?: number;
    minScore?: number;
    includeInactive?: boolean;
    /** Skip the contacts lookup (e.g. offline runs). */
    skipContacts?: boolean;
    /** Use these permits instead of fetching (offline runs from a saved API response). */
    permits?: NormalizedPermit[];
    state?: DiscoveryState;
}

export interface DiscoverStats {
    fetched: number;
    duplicates: number;
    inactive: number;
    excluded: Record<string, number>;
    relevant: number;
    opportunities: number;
    belowMinScore: number;
    newOpportunities: number;
}

export interface DiscoverResult {
    opportunities: Opportunity[];
    stats: DiscoverStats;
    warnings: string[];
}

interface Candidate {
    permit: NormalizedPermit;
    services: Map<Service, Set<string>>;
    businesses: Business[];
    preliminary: number;
}

/** Project key: same parcel (or street address) = same project. */
export function projectKey(permit: NormalizedPermit): string {
    const where = permit.parcel ?? permit.address?.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim() ?? `permit ${permit.permitNumber}`;
    return `${permit.sourceId}:${where.replace(/\s+/g, '-').toLowerCase()}`;
}

/** Permits filed for adjacent parcels on the same day with near-consecutive numbers are one project. */
function filedTogether(a: NormalizedPermit, b: NormalizedPermit): boolean {
    const block = (p: NormalizedPermit) => p.parcel?.split('/')[0];
    const day = (p: NormalizedPermit) => p.filedDate ?? p.statusDate;
    if (!block(a) || block(a) !== block(b) || !day(a) || day(a) !== day(b)) return false;
    if ((a.permitType ?? '') !== (b.permitType ?? '')) return false;
    if (!/^\d+$/.test(a.permitNumber) || !/^\d+$/.test(b.permitNumber)) return false;
    return Math.abs(Number(a.permitNumber) - Number(b.permitNumber)) <= 5;
}

/**
 * Merges project groups whose permits were filed together for adjacent parcels (e.g. two demolition permits for
 * neighbouring lots of one site). The merged group keeps the first key in sort order.
 */
export function mergeAdjacentProjects<T = NormalizedPermit>(
    groups: Map<string, T[]>,
    permitOf: (item: T) => NormalizedPermit = (item) => item as unknown as NormalizedPermit,
): Map<string, T[]> {
    const keys = [...groups.keys()].sort();
    const parent = new Map(keys.map((k) => [k, k]));
    const find = (k: string): string => (parent.get(k) === k ? k : find(parent.get(k)!));
    // Only groups on the same assessor block can be adjacent, so compare within blocks.
    const byBlock = Map.groupBy(keys, (k) => permitOf(groups.get(k)![0]!).parcel?.split('/')[0] ?? `none:${k}`);
    for (const blockKeys of byBlock.values()) {
        for (let i = 0; i < blockKeys.length; i++) {
            for (let j = i + 1; j < blockKeys.length; j++) {
                const a = groups.get(blockKeys[i]!)!.map(permitOf);
                const b = groups.get(blockKeys[j]!)!.map(permitOf);
                if (a.some((pa) => b.some((pb) => filedTogether(pa, pb)))) {
                    const [ri, rj] = [find(blockKeys[i]!), find(blockKeys[j]!)];
                    if (ri !== rj) parent.set(rj > ri ? rj : ri, rj > ri ? ri : rj);
                }
            }
        }
    }
    const merged = new Map<string, T[]>();
    for (const k of keys) merged.set(find(k), [...(merged.get(find(k)) ?? []), ...groups.get(k)!]);
    return merged;
}

/**
 * Discovers construction opportunities from one permit source. Read-only: it never contacts anyone.
 */
export async function discover(options: DiscoverOptions): Promise<DiscoverResult> {
    const now = options.now ?? new Date();
    const { source, ctx } = options;
    const warnings: string[] = [];
    const since = new Date(now.getTime() - options.days * 86_400_000);
    const stats: DiscoverStats = { fetched: 0, duplicates: 0, inactive: 0, excluded: {}, relevant: 0, opportunities: 0, belowMinScore: 0, newOpportunities: 0 };

    const maxRows = options.maxRows ?? 5000;
    const fetched = options.permits ?? (await source.fetchPermits(ctx, { since, maxRows }));
    stats.fetched = fetched.length;
    if (!options.permits && fetched.length >= maxRows) {
        warnings.push(`Stopped at the ${maxRows}-row limit; older permits in the window were not checked. Use fewer --days or a higher --max-rows.`);
    }

    // 1. One row per permit.
    const permits = new Map<string, NormalizedPermit>();
    for (const p of fetched) {
        if (permits.has(p.permitNumber)) stats.duplicates++;
        else permits.set(p.permitNumber, p);
    }

    // 2. Keep active permits that involve Best Construction's services.
    const relevant: { permit: NormalizedPermit; services: Map<Service, Set<string>> }[] = [];
    for (const permit of permits.values()) {
        if (permit.stage === 'inactive' && !options.includeInactive) {
            stats.inactive++;
            continue;
        }
        const analysis = matchServices(permit);
        if (analysis.excludedReason) {
            const reason = analysis.excludedReason.replace(/\s*\(.*\)$/, '');
            stats.excluded[reason] = (stats.excluded[reason] ?? 0) + 1;
            continue;
        }
        relevant.push({ permit, services: new Map(analysis.services.map((s) => [s.service, new Set(s.evidence)])) });
    }
    stats.relevant = relevant.length;

    // 3. Business contacts (firm names only) for the relevant permits.
    let contacts: PermitContact[] = [];
    let contactsAvailable = source.publishesContacts && !options.skipContacts && !!source.fetchContacts;
    if (contactsAvailable && relevant.length) {
        try {
            contacts = await source.fetchContacts!(ctx, relevant.map((r) => r.permit.permitNumber));
        } catch (error) {
            contactsAvailable = false;
            warnings.push(`Contacts lookup failed, continuing without business names: ${(error as Error).message}`);
        }
    }
    const contactsByPermit = Map.groupBy(contacts, (c) => c.permitNumber);

    const candidates: Candidate[] = relevant.map(({ permit, services }) => {
        const url = source.contactsUrl?.(ctx, permit.permitNumber) ?? permit.sourceUrl;
        const businesses = toBusinesses(contactsByPermit.get(permit.permitNumber) ?? [], url);
        const list = [...services.keys()];
        const c = classify(permit, list, businesses);
        const preliminary = scoreOpportunity({ permit, services: list, businesses, contactPolicy: c.contactPolicy, sourcePublishesContacts: contactsAvailable, now }).score;
        return { permit, services, businesses, preliminary };
    });

    // 4. Group permits on the same parcel (or adjacent parcels filed together) into one project,
    //    scored on the combined picture.
    const groups = mergeAdjacentProjects(Map.groupBy(candidates, (c) => projectKey(c.permit)), (c) => c.permit);
    const opportunities: Opportunity[] = [];
    for (const [key, group] of groups) {
        group.sort((a, b) => b.preliminary - a.preliminary || (lastActivity(b.permit)?.getTime() ?? 0) - (lastActivity(a.permit)?.getTime() ?? 0));
        const primary = group[0]!;

        const services = new Map<Service, Set<string>>();
        for (const c of group) for (const [s, ev] of c.services) services.set(s, new Set([...(services.get(s) ?? []), ...ev]));
        const businesses = dedupeBusinesses(group.flatMap((c) => c.businesses));
        const values = group.map((c) => projectValue(c.permit)).filter((v) => v.value !== null);
        const bestValue = values.sort((a, b) => b.value! - a.value!)[0];
        const merged: NormalizedPermit = {
            ...primary.permit,
            estimatedCost: bestValue?.basis === 'estimated_cost' ? bestValue.value! : primary.permit.estimatedCost,
            revisedCost: bestValue?.basis === 'revised_cost' ? bestValue.value! : undefined,
            existingUnits: max(group.map((c) => c.permit.existingUnits)),
            proposedUnits: max(group.map((c) => c.permit.proposedUnits)),
            permitType: group.some((c) => /new construction/i.test(c.permit.permitType ?? '')) ? 'new construction' : primary.permit.permitType,
        };
        const serviceList = [...services.keys()];
        const classification = classify(merged, serviceList, businesses);
        const scored = scoreOpportunity({
            permit: merged,
            services: serviceList,
            businesses,
            contactPolicy: classification.contactPolicy,
            sourcePublishesContacts: contactsAvailable,
            now,
        });
        if (group.length > 1 && merged.stage !== 'inactive' && classification.contactPolicy !== 'no_direct_contact') {
            const bonus = Math.min(3, 100 - scored.score);
            if (bonus > 0) {
                scored.factors.push({ factor: 'adjustment', points: bonus, max: 3, detail: `${group.length} related permits on this property` });
                scored.score += bonus;
                scored.band = scored.score >= 70 ? 'high' : scored.score >= 45 ? 'medium' : 'low';
                scored.summary = scored.summary.replace(/^\d+\/100 \(\w+\)/, `${scored.score}/100 (${scored.band})`);
            }
        }
        if (scored.score < (options.minScore ?? 0)) {
            stats.belowMinScore++;
            continue;
        }

        const seen = options.state?.seen[key];
        const value = projectValue(merged);
        opportunities.push(
            OpportunitySchema.parse({
                schema_version: 1,
                opportunity_id: key,
                source: { id: source.id, name: source.name, dataset_url: source.datasetUrl, record_url: primary.permit.sourceUrl },
                jurisdiction: { city: primary.permit.city, county: primary.permit.county, state: 'CA' },
                location: {
                    address: primary.permit.address,
                    zip: primary.permit.zip,
                    parcel: primary.permit.parcel,
                    neighborhood: primary.permit.neighborhood,
                    latitude: primary.permit.latitude,
                    longitude: primary.permit.longitude,
                },
                permit: {
                    number: primary.permit.permitNumber,
                    type: primary.permit.permitType,
                    status: primary.permit.status,
                    stage: primary.permit.stage,
                    status_date: primary.permit.statusDate,
                    filed_date: primary.permit.filedDate,
                    issued_date: primary.permit.issuedDate,
                    expiration_date: primary.permit.expirationDate,
                },
                project_description: primary.permit.description,
                estimated_value: value.value,
                value_basis: value.basis,
                existing_use: merged.existingUse,
                proposed_use: merged.proposedUse,
                existing_units: merged.existingUnits,
                proposed_units: merged.proposedUnits,
                businesses,
                services: serviceList.map((service) => ({ service, evidence: [...services.get(service)!] })),
                lead_segment: classification.segment,
                segment_reason: classification.reason,
                contact_policy: classification.contactPolicy,
                score: scored.score,
                score_band: scored.band,
                score_reasons: scored.factors,
                score_summary: scored.summary,
                related_permits: group.slice(1).map((c) => ({
                    permit_number: c.permit.permitNumber,
                    permit_type: c.permit.permitType,
                    status: c.permit.status,
                    status_date: c.permit.statusDate,
                    description: c.permit.description,
                    source_url: c.permit.sourceUrl,
                })),
                is_new: !seen,
                first_seen_at: seen?.first_seen_at ?? now.toISOString(),
                discovered_at: now.toISOString(),
            }),
        );
    }

    // 5. Best first: score, then most recent activity.
    opportunities.sort(
        (a, b) =>
            b.score - a.score ||
            (b.permit.status_date ?? b.permit.filed_date ?? '').localeCompare(a.permit.status_date ?? a.permit.filed_date ?? ''),
    );
    stats.opportunities = opportunities.length;
    stats.newOpportunities = opportunities.filter((o) => o.is_new).length;
    return { opportunities, stats, warnings };
}

function max(values: (number | undefined)[]): number | undefined {
    const nums = values.filter((v): v is number => v !== undefined);
    return nums.length ? Math.max(...nums) : undefined;
}

function dedupeBusinesses(businesses: Business[]): Business[] {
    const seen = new Set<string>();
    return businesses.filter((b) => {
        const key = `${b.role}:${b.name.toLowerCase()}`;
        return seen.has(key) ? false : (seen.add(key), true);
    });
}
