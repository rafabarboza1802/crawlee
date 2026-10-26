import { CORE_SCOPES, SERVICE_POINTS } from '../discover/services.js';
import type { Opportunity, Service } from '../discover/types.js';
import type { LeadProject } from './types.js';
import type { LeadSettings } from './settings.js';
import { companiesFor } from './identify.js';

/** Best Construction's target scopes, as matched from public permit descriptions. Remodel/ADU work is not a scope. */
const TARGET_SCOPE: Partial<Record<Service, string>> = {
    demolition: 'Demolition',
    interior_demolition: 'Interior demolition',
    excavation: 'Excavation',
    grading: 'Grading',
    site_work: 'Sitework/earthwork',
    land_clearing: 'Land clearing',
    concrete: 'Concrete flatwork/removal',
    drainage: 'Underground/site utilities (drainage)',
    retaining_walls: 'Sitework (retaining walls)',
    hauling_debris: 'Hauling and debris removal',
    paving: 'Paving',
    pavers_hardscape: 'Pavers/hardscape',
};

const rank = (s: Service) => (CORE_SCOPES.includes(s) ? CORE_SCOPES.indexOf(s) : 99);

export function targetScopes(o: Opportunity): string[] {
    return [...o.services]
        .sort((a, b) => SERVICE_POINTS[b.service] - SERVICE_POINTS[a.service] || rank(a.service) - rank(b.service))
        .map((s) => TARGET_SCOPE[s.service])
        .filter((s): s is string => !!s)
        .filter((s, i, all) => all.indexOf(s) === i);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`);

/** Permits have no project name: build a readable one from the public record. */
export function projectName(o: Opportunity): string {
    const where = o.location.address ?? `permit ${o.permit.number}`;
    const type = (o.permit.type ?? '').toLowerCase();
    let what: string;
    if (o.proposed_units && o.proposed_units >= 2 && /new construction/.test(type)) what = `New ${o.proposed_units}-unit building`;
    else if (/new construction/.test(type)) what = 'New construction';
    else if (/demolition/.test(type)) what = 'Demolition';
    else {
        // First clause with real words ("28th floor: t.i. ..." → "T.I. ..."), skipping floor/suite/reference prefixes.
        const text = o.project_description.replace(/\bt\.\s?i\.?/gi, 'tenant improvement').replace(/\s+/g, ' ');
        const clauses = text.split(/[.;:]/).map((c) => c.trim());
        const first = clauses.find((c) => c.split(' ').length >= 4 && !/^(?:ref\b|re:)/i.test(c)) ?? text.trim();
        what = capitalize(first.length > 60 ? `${first.slice(0, 57)}…` : first || 'Project');
    }
    return `${what} — ${where}`;
}

export function projectType(o: Opportunity): string {
    const segment = o.lead_segment.replace(/_/g, ' ');
    return [o.permit.type, o.proposed_use ? `use: ${o.proposed_use}` : undefined, `segment: ${segment}`].filter(Boolean).join('; ');
}

/** When sub bids for our scopes are most likely, from the permit stage and dates. */
export function bidTiming(o: Opportunity, now: Date): Pick<LeadProject, 'bid_window' | 'bid_timing'> {
    const days = (d?: string) => (d ? Math.floor((now.getTime() - Date.parse(d)) / 86_400_000) : undefined);
    switch (o.permit.stage) {
        case 'pre_construction':
            return {
                bid_window: 'now',
                bid_timing: 'Permit in review: the GC is pricing now. Demo/excavation/sitework bids usually go out 0–3 months before the permit is issued. Contact now.',
            };
        case 'issued': {
            const age = days(o.permit.issued_date ?? o.permit.status_date) ?? 0;
            return age <= 45
                ? {
                      bid_window: 'soon',
                      bid_timing: `Permit issued ${age} day(s) ago: early trades (demo, excavation, grading) start first. Contact immediately; some packages may be awarded.`,
                  }
                : {
                      bid_window: 'started',
                      bid_timing: `Issued ${age} days ago: sitework likely awarded. Ask about later scopes (flatwork, paving, hardscape, hauling) and their next project.`,
                  };
        }
        default:
            return { bid_window: 'watch', bid_timing: 'Permit stalled or status unclear: watch for movement before pursuing.' };
    }
}

/** Checks that the project is real, current and the right size. Returns the problems found (empty = verified). */
export function verifyProject(o: Opportunity, settings: LeadSettings, now: Date): string[] {
    const problems: string[] = [];
    if (o.permit.stage === 'inactive') problems.push(`Permit is ${o.permit.status ?? 'inactive'}`);
    if (o.permit.expiration_date && Date.parse(o.permit.expiration_date) < now.getTime()) problems.push(`Permit expired ${o.permit.expiration_date}`);
    if (!o.location.address) problems.push('No project address in the public record');
    if (o.estimated_value !== null && o.estimated_value < settings.minProjectValue) {
        problems.push(`Project value ${money(o.estimated_value)} is below ${money(settings.minProjectValue)}`);
    }
    const scopes = targetScopes(o);
    if (!scopes.length) problems.push('No Best Construction scope in the permit (remodel/interior work only)');
    else if (scopes.every((s) => s === 'Interior demolition') && (o.estimated_value ?? 0) < settings.minInteriorOnlyValue) {
        problems.push(`Small interior remodel (interior demolition only, under ${money(settings.minInteriorOnlyValue)})`);
    }
    return problems;
}

export function describeProject(o: Opportunity, now: Date, settings: LeadSettings): LeadProject {
    const contractor = o.businesses.find((b) => b.role === 'contractor');
    const owner = o.businesses.find((b) => b.role === 'owner_business');
    // Permit agents are often the developer, but also architects, engineers, expediters, law firms or contractors.
    const otherRoles = new Set(o.businesses.filter((b) => b.role !== 'agent').map((b) => b.name));
    const agents = o.businesses.filter(
        (b) => b.role === 'agent' && !otherRoles.has(b.name) && !/design|architect|studio|engineer|structural|permit|expedit|consult|\bllp\b|\blaw\b|assoc|assco|construction|builders|contract/i.test(b.name),
    );
    const agent = agents.find((b) => /housing|develop|propert|partners|holdings|realty|capital|homes|invest|\bllc\b|\blp\b/i.test(b.name)) ?? agents[0];
    const scopes = targetScopes(o);
    const timing = bidTiming(o, now);
    return {
        name: projectName(o),
        address: o.location.address ?? null,
        city: o.jurisdiction.city,
        county: o.jurisdiction.county,
        priority_area: settings.priorityCounties.includes(o.jurisdiction.county),
        project_type: projectType(o),
        description: o.project_description,
        estimated_value: o.estimated_value,
        permit_number: o.permit.number,
        permit_status: [o.permit.status, o.permit.status_date].filter(Boolean).join(' ') || null,
        project_stage: o.permit.stage,
        general_contractor: contractor?.name ?? null,
        gc_license: contractor?.license ?? null,
        permit_contractor: contractor?.name ?? null,
        // Owners that are businesses; otherwise the permit agent, which is often the developer (or an expediter).
        developer_owner: owner?.name ?? (agent ? `${agent.name} (permit agent)` : null),
        companies: companiesFor(o),
        evidence_url: o.source.record_url,
        source_name: o.source.name,
        target_scopes: scopes,
        score: o.score,
        score_summary: o.score_summary,
        ...timing,
        qualifies_because: `${o.score_summary}. Scopes for Best Construction: ${scopes.join(', ') || 'none'}.`,
    };
}
