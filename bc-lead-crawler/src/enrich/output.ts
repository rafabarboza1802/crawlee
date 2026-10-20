import { z } from 'zod';

import { csvCell } from '../output.js';
import type { Opportunity } from '../discover/types.js';
import type { Account, Exclusion } from './accounts.js';
import { linkedInCompanySearchUrl, linkedInPeopleSearchUrl } from './linkedin.js';
import { contactReason, recommendedPitch } from './pitch.js';
import type { AccountPlan } from './plan.js';
import { roleTargets } from './roles.js';

/** One qualified opportunity with its contact plan. Person fields stay null until an approved paid lookup fills them. */
export const ContactPlanRowSchema = z.object({
    status: z.enum(['awaiting_approval', 'deferred_run_cap', 'excluded']),
    status_reason: z.string().optional(),
    opportunity_id: z.string(),
    opportunity_score: z.number(),
    project_address: z.string().nullable(),
    project_description: z.string(),
    estimated_value: z.number().nullable(),
    permit_number: z.string(),
    permit_status: z.string().nullable(),
    lead_segment: z.string(),
    record_url: z.url(),
    company_name: z.string().nullable(),
    company_license: z.string().nullable(),
    company_website: z.string().nullable(),
    company_phone: z.string().nullable(),
    decision_maker_name: z.string().nullable(),
    decision_maker_title: z.string().nullable(),
    business_email: z.string().nullable(),
    linkedin_profile_url: z.string().nullable(),
    linkedin_manual_search_url: z.string().nullable(),
    linkedin_company_search_url: z.string().nullable(),
    target_titles: z.array(z.string()),
    reason_to_contact: z.string().nullable(),
    recommended_pitch: z.string().nullable(),
    account_id: z.string().nullable(),
    account_credits_expected: z.number(),
    account_credits_max: z.number(),
});
export type ContactPlanRow = z.infer<typeof ContactPlanRowSchema>;

function base(o: Opportunity) {
    return {
        opportunity_id: o.opportunity_id,
        opportunity_score: o.score,
        project_address: o.location.address ?? null,
        project_description: o.project_description,
        estimated_value: o.estimated_value,
        permit_number: o.permit.number,
        permit_status: [o.permit.status, o.permit.status_date].filter(Boolean).join(' ') || null,
        lead_segment: o.lead_segment,
        record_url: o.source.record_url,
    };
}

const PENDING = {
    company_website: null,
    company_phone: null,
    decision_maker_name: null,
    decision_maker_title: null,
    business_email: null,
    linkedin_profile_url: null,
};

export function rowsForAccount(plan: AccountPlan, status: 'awaiting_approval' | 'deferred_run_cap'): ContactPlanRow[] {
    const { account } = plan;
    const primaryTitle = roleTargets(account.kind)[0]!.titles[0]!;
    return account.opportunities.map((o, i) =>
        ContactPlanRowSchema.parse({
            status,
            ...(status === 'deferred_run_cap' ? { status_reason: 'Over the per-run company cap; next run' } : {}),
            ...base(o),
            company_name: account.displayName,
            company_license: account.license ?? null,
            ...PENDING,
            linkedin_manual_search_url: linkedInPeopleSearchUrl(account.searchName, primaryTitle),
            linkedin_company_search_url: linkedInCompanySearchUrl(account.searchName),
            target_titles: roleTargets(account.kind).flatMap((r) => r.titles),
            reason_to_contact: contactReason(account, o),
            recommended_pitch: recommendedPitch(account, o),
            account_id: account.accountId,
            // Credits are counted once per company, on its first opportunity.
            account_credits_expected: i === 0 ? plan.creditsExpected : 0,
            account_credits_max: i === 0 ? plan.creditsMax : 0,
        }),
    );
}

export function rowForExclusion(e: Exclusion): ContactPlanRow {
    return ContactPlanRowSchema.parse({
        status: 'excluded',
        status_reason: e.reason,
        ...base(e.opportunity),
        company_name: null,
        company_license: null,
        ...PENDING,
        linkedin_manual_search_url: null,
        linkedin_company_search_url: null,
        target_titles: [],
        reason_to_contact: null,
        recommended_pitch: null,
        account_id: null,
        account_credits_expected: 0,
        account_credits_max: 0,
    });
}

const PENDING_TEXT = '(pending approved lookup)';

export function contactPlanToCsv(rows: ContactPlanRow[]): string {
    const pending = (v: string | null, r: ContactPlanRow) => v ?? (r.status === 'excluded' ? '' : PENDING_TEXT);
    const columns: [string, (r: ContactPlanRow) => string][] = [
        ['status', (r) => r.status],
        ['opportunity_score', (r) => String(r.opportunity_score)],
        ['project_address', (r) => r.project_address ?? ''],
        ['project_description', (r) => r.project_description.slice(0, 300)],
        ['estimated_value', (r) => (r.estimated_value === null ? '' : String(r.estimated_value))],
        ['permit', (r) => `${r.permit_number} ${r.permit_status ?? ''}`.trim()],
        ['lead_segment', (r) => r.lead_segment],
        ['company_name', (r) => r.company_name ?? ''],
        ['company_license', (r) => r.company_license ?? ''],
        ['company_website', (r) => pending(r.company_website, r)],
        ['company_phone', (r) => pending(r.company_phone, r)],
        ['decision_maker_name', (r) => pending(r.decision_maker_name, r)],
        ['decision_maker_title', (r) => pending(r.decision_maker_title, r)],
        ['business_email', (r) => pending(r.business_email, r)],
        ['linkedin_profile_url', (r) => pending(r.linkedin_profile_url, r)],
        ['linkedin_manual_search_url', (r) => r.linkedin_manual_search_url ?? ''],
        ['target_titles', (r) => r.target_titles.join('; ')],
        ['reason_to_contact', (r) => r.reason_to_contact ?? r.status_reason ?? ''],
        ['recommended_pitch', (r) => r.recommended_pitch ?? ''],
        ['credits_expected', (r) => String(r.account_credits_expected)],
        ['credits_max', (r) => String(r.account_credits_max)],
        ['record_url', (r) => r.record_url],
    ];
    return [columns.map(([h]) => h).join(','), ...rows.map((r) => columns.map(([, get]) => csvCell(get(r))).join(','))].join('\n') + '\n';
}

export function accountsSummary(plans: AccountPlan[]): string[] {
    return plans.map((p: AccountPlan) => {
        const a: Account = p.account;
        return `${String(a.bestScore).padStart(3)}  ${a.displayName.padEnd(42)} ${a.kind.padEnd(22)} search "${a.searchName}"  credits ${p.creditsExpected}–${p.creditsMax}`;
    });
}
