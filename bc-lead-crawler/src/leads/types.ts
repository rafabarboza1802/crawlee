import { z } from 'zod';

import { OpportunitySchema } from '../discover/types.js';

/**
 * Lead lifecycle. The system sets the automatic statuses on every run; CONTACTED, FOLLOW-UP and BID OPPORTUNITY (and
 * any status the owner sets by hand) are never overwritten by the system.
 */
export const LEAD_STATUSES = [
    'NEW',
    'RESEARCHING',
    'QUALIFIED',
    'BUYER VERIFIED',
    'CONTACT NEEDED',
    'CONTACT FOUND',
    'READY FOR OUTREACH',
    'CONTACTED',
    'FOLLOW-UP',
    'BID OPPORTUNITY',
    'REJECTED',
    'COMPETITOR',
] as const;
export const LeadStatusSchema = z.enum(LEAD_STATUSES);
export type LeadStatus = z.infer<typeof LeadStatusSchema>;

/** What each status means (shown in reports and the README). */
export const STATUS_MEANING: Record<LeadStatus, string> = {
    NEW: 'Just discovered; not evaluated yet.',
    RESEARCHING: 'Good project, but the company needs a buyer decision (manual review).',
    QUALIFIED: 'Good project with no GC/buyer named yet (or a public project): watch for the contractor.',
    'BUYER VERIFIED': 'Approved buyer; contact lookup found nobody usable. Use the company phone or the LinkedIn search link.',
    'CONTACT NEEDED': 'Approved buyer; decision-maker lookup not done yet (run "prepare contacts").',
    'CONTACT FOUND': 'Decision maker found, but no verified business email yet.',
    'READY FOR OUTREACH': 'Decision maker with a verified business email. Ready for you to reach out.',
    CONTACTED: 'You contacted them (set by you).',
    'FOLLOW-UP': 'Follow-up due (set by you).',
    'BID OPPORTUNITY': 'Invited to bid / bid in progress (set by you).',
    REJECTED: 'Not a fit (too small, inactive, homeowner, do-not-enrich, or set by you).',
    COMPETITOR: 'Company self-performs our scopes or is a known competitor. Never contacted.',
};

/** Statuses only the owner sets; the system never changes a lead away from them. */
export const OWNER_STATUSES: LeadStatus[] = ['CONTACTED', 'FOLLOW-UP', 'BID OPPORTUNITY'];

export const LeadProjectSchema = z.object({
    name: z.string(),
    address: z.string().nullable(),
    city: z.string(),
    county: z.string(),
    priority_area: z.boolean(),
    project_type: z.string(),
    description: z.string(),
    estimated_value: z.number().nullable(),
    permit_number: z.string(),
    permit_status: z.string().nullable(),
    project_stage: z.string(),
    general_contractor: z.string().nullable(),
    gc_license: z.string().nullable(),
    /** Contractor name exactly as on the permit (differs from general_contractor when a JV resolves to its managing GC). */
    permit_contractor: z.string().nullable(),
    developer_owner: z.string().nullable(),
    evidence_url: z.string(),
    source_name: z.string(),
    target_scopes: z.array(z.string()),
    score: z.number(),
    score_summary: z.string(),
    bid_window: z.enum(['now', 'soon', 'started', 'watch']),
    bid_timing: z.string(),
    qualifies_because: z.string(),
});
export type LeadProject = z.infer<typeof LeadProjectSchema>;

export const LeadRecordSchema = z.object({
    lead_id: z.string(),
    status: LeadStatusSchema,
    status_reason: z.string(),
    status_by: z.enum(['system', 'owner']),
    status_updated_at: z.string(),
    history: z.array(z.object({ at: z.string(), status: LeadStatusSchema, reason: z.string(), by: z.enum(['system', 'owner']) })),
    first_seen_at: z.string(),
    last_seen_at: z.string(),
    project: LeadProjectSchema,
    company_id: z.string().nullable(),
    owner_note: z.string().optional(),
    /** Latest public record, kept for qualified leads so contacts can be prepared later without re-discovery. */
    opportunity: OpportunitySchema.optional(),
});
export type LeadRecord = z.infer<typeof LeadRecordSchema>;

export const CompanyRecordSchema = z.object({
    company_id: z.string(),
    name: z.string(),
    license: z.string().nullable(),
    classification: z.enum(['buyer', 'competitor', 'uncertain', 'do_not_enrich', 'not_target']),
    reason: z.string(),
    evidence: z.array(z.string()),
    source: z.string(),
    scope: z.string().optional(),
    website: z.string().optional(),
    risk_signal: z.string().optional(),
    /** For a JV resolved to its managing GC: the JV name(s) seen on permits. */
    joint_ventures: z.array(z.string()).default([]),
    first_seen_at: z.string(),
    last_classified_at: z.string(),
    /** Set after an approved Apollo run; the company is never bought again while this exists. */
    enrichment: z
        .object({
            status: z.string(),
            at: z.string(),
            plan_id: z.string(),
            credits: z.number(),
            /** Apollo person ids only; names and emails live in the private contact store. */
            contact_ids: z.array(z.string()),
            verified_contacts: z.number(),
            company_website: z.string().optional(),
            company_phone: z.string().optional(),
            note: z.string().optional(),
        })
        .optional(),
});
export type CompanyRecord = z.infer<typeof CompanyRecordSchema>;

export const LeadDatabaseSchema = z.object({
    version: z.literal(1),
    updated_at: z.string(),
    leads: z.record(z.string(), LeadRecordSchema),
    companies: z.record(z.string(), CompanyRecordSchema),
});
export type LeadDatabaseFile = z.infer<typeof LeadDatabaseSchema>;

/** A purchased business contact. Stored only in the private (git-ignored) contact store. */
export const ContactRecordSchema = z.object({
    id: z.string(),
    company_id: z.string(),
    company_name: z.string(),
    name: z.string(),
    title: z.string().nullable(),
    role_category: z.string(),
    business_email: z.string().nullable(),
    email_status: z.string().nullable(),
    verified: z.boolean(),
    verify_notes: z.array(z.string()),
    linkedin_url: z.string().nullable(),
    company_phone: z.string().nullable(),
    company_website: z.string().nullable(),
    found_at: z.string(),
    plan_id: z.string(),
});
export type ContactRecord = z.infer<typeof ContactRecordSchema>;
