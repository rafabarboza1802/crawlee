import { csvCell } from '../output.js';
import { SERVICE_LABELS } from './services.js';
import type { Opportunity } from './types.js';

/** Flat CSV for human review. The JSONL file is the full contract for agency-agents. */
export function opportunitiesToCsv(rows: Opportunity[]): string {
    const columns: [string, (o: Opportunity) => string][] = [
        ['score', (o) => String(o.score)],
        ['band', (o) => o.score_band],
        ['new', (o) => (o.is_new ? 'yes' : '')],
        ['lead_segment', (o) => o.lead_segment],
        ['services', (o) => o.services.map((s) => SERVICE_LABELS[s.service]).join('; ')],
        ['address', (o) => o.location.address ?? ''],
        ['neighborhood', (o) => o.location.neighborhood ?? ''],
        ['city', (o) => o.jurisdiction.city],
        ['permit_number', (o) => o.permit.number],
        ['permit_type', (o) => o.permit.type ?? ''],
        ['status', (o) => o.permit.status ?? ''],
        ['status_date', (o) => o.permit.status_date ?? ''],
        ['filed_date', (o) => o.permit.filed_date ?? ''],
        ['estimated_value', (o) => (o.estimated_value === null ? '' : String(o.estimated_value))],
        ['businesses', (o) => o.businesses.map((b) => `${b.role}: ${b.name}${b.license ? ` (lic ${b.license})` : ''}`).join('; ')],
        ['contact_policy', (o) => o.contact_policy],
        ['related_permits', (o) => o.related_permits.map((r) => r.permit_number).join(' ')],
        ['description', (o) => o.project_description.slice(0, 300)],
        ['score_summary', (o) => o.score_summary],
        ['segment_reason', (o) => o.segment_reason],
        ['record_url', (o) => o.source.record_url],
    ];
    return [columns.map(([h]) => h).join(','), ...rows.map((o) => columns.map(([, get]) => csvCell(get(o))).join(','))].join('\n') + '\n';
}
