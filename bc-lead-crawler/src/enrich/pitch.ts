import { SERVICE_LABELS, SERVICE_POINTS } from '../discover/services.js';
import type { Opportunity, Service } from '../discover/types.js';
import type { Account } from './accounts.js';

const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`);

/** Services worth pitching for this opportunity, best fit first (remodel only when nothing better matched). */
export function servicesToPitch(o: Opportunity): Service[] {
    const services = o.services.map((s) => s.service).sort((a, b) => SERVICE_POINTS[b] - SERVICE_POINTS[a]);
    const core = services.filter((s) => s !== 'remodel' && s !== 'hauling_debris');
    return (core.length ? core : services).slice(0, 3);
}

/** Recommended Best Construction service and angle, following the segment playbook. */
export function recommendedPitch(account: Account, o: Opportunity): string {
    const services = servicesToPitch(o).map((s) => SERVICE_LABELS[s]);
    const list = services.join(', ');
    switch (account.kind) {
        case 'contractor':
            return `Sub bid for ${list}: line-item bid, CalGreen haul-off included, photo-documented; ask to be on their bid list.`;
        case 'developer':
            return `${list} under one contract; ask to be on the bid list before packages go out.`;
        case 'property_owner_manager':
            return `${list}: line-item bid that is easy to approve, scheduled around tenants, walk the property for a fixed number.`;
    }
}

/** Why this company should be contacted, from the public permit record. */
export function contactReason(account: Account, o: Opportunity): string {
    const role = account.role === 'contractor' ? 'Named contractor' : 'Named owner/developer';
    const status = [o.permit.status, o.permit.status_date].filter(Boolean).join(' ');
    const value = o.estimated_value ? `, ${money(o.estimated_value)}` : '';
    const desc = o.project_description.length > 140 ? `${o.project_description.slice(0, 137)}…` : o.project_description;
    return `${role} on permit ${o.permit.number} at ${o.location.address ?? 'the property'} (${status}${value}): ${desc}`;
}
