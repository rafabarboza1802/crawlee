import { z } from 'zod';

import { OpportunitySchema } from '../discover/types.js';

/**
 * Lead lifecycle (owner's list, 2026-10-23, plus REJECTED). The pipeline sets the pre-outreach statuses, the outreach
 * engine sets CONTACTED / FOLLOW_UP / REPLIED, and the owner sets the sales outcomes. A status set by the owner is never
 * overwritten by the system.
 */
export const LEAD_STATUSES = [
    'NEW',
    'QUALIFIED',
    'NEEDS_REVIEW',
    'CONTACT_READY',
    'CONTACTED',
    'FOLLOW_UP',
    'REPLIED',
    'ESTIMATING',
    'BID_INVITED',
    'BID_SUBMITTED',
    'WON',
    'LOST',
    'COMPETITOR',
    'DO_NOT_CONTACT',
    'REJECTED',
] as const;
export const LeadStatusSchema = z.enum(LEAD_STATUSES);
export type LeadStatus = z.infer<typeof LeadStatusSchema>;

/** What each status means (shown in reports and the README). */
export const STATUS_MEANING: Record<LeadStatus, string> = {
    NEW: 'Just discovered; not evaluated yet.',
    QUALIFIED: 'Good project. The buyer still needs a decision maker, or no GC is named yet (watch).',
    NEEDS_REVIEW: 'Good project, but the company is not yet proven to be a buyer. Never emailed.',
    CONTACT_READY: 'Approved buyer with a verified decision maker; outreach starts on the next run (if sending is on).',
    CONTACTED: 'First email sent.',
    FOLLOW_UP: 'Follow-up email(s) sent; waiting for a reply.',
    REPLIED: 'They replied. Follow-ups stopped; your turn.',
    ESTIMATING: 'You are estimating the job (set by you).',
    BID_INVITED: 'Invited to bid (set by you).',
    BID_SUBMITTED: 'Bid submitted (set by you).',
    WON: 'Won (set by you).',
    LOST: 'Lost (set by you).',
    COMPETITOR: 'Self-performs our scopes or a known competitor. Never contacted.',
    DO_NOT_CONTACT: 'Opted out, bounced, blocked or excluded. Never contacted again.',
    REJECTED: 'Not a fit: too small, inactive, homeowner, small contractor or unrelated scope.',
};

/** Statuses only the owner sets (sales outcomes). */
export const OWNER_STATUSES: LeadStatus[] = ['ESTIMATING', 'BID_INVITED', 'BID_SUBMITTED', 'WON', 'LOST'];

/** Outreach progress: the pipeline never moves a lead back from these (only forward, or to COMPETITOR/DO_NOT_CONTACT). */
export const OUTREACH_STATUSES: LeadStatus[] = ['CONTACTED', 'FOLLOW_UP', 'REPLIED'];

/** Statuses from the first version of the database, mapped on load. */
export const LEGACY_STATUS: Record<string, LeadStatus> = {
    RESEARCHING: 'NEEDS_REVIEW',
    'BUYER VERIFIED': 'QUALIFIED',
    'CONTACT NEEDED': 'QUALIFIED',
    'CONTACT FOUND': 'QUALIFIED',
    'READY FOR OUTREACH': 'CONTACT_READY',
    'FOLLOW-UP': 'FOLLOW_UP',
    'BID OPPORTUNITY': 'BID_INVITED',
};

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
    /** Every business identified for the project (GC, developer/owner, applicant, architect, engineer) and where from. */
    companies: z.array(z.object({ role: z.string(), name: z.string(), source: z.string() })).default([]),
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
    /** Outreach summary (no names or emails: those live in the encrypted private store). */
    outreach: z
        .object({
            contact_id: z.string(),
            sequence_id: z.string(),
            state: z.enum(['active', 'replied', 'opted_out', 'bounced', 'stopped', 'completed']),
            emails_sent: z.number(),
            first_sent_at: z.string(),
            last_sent_at: z.string(),
            next_due_at: z.string().nullable(),
            replied_at: z.string().optional(),
            stop_reason: z.string().optional(),
        })
        .optional(),
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
            /** Decision makers identified (with or without a verified email). */
            people_found: z.number().optional(),
            /** Lookup strategy version; older lookups that found no usable email get one retry with the current one. */
            strategy: z.number().optional(),
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
    /** Rows of data/owner-updates.csv already applied (by content hash), so each is applied once. */
    applied_owner_updates: z.array(z.string()).default([]),
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
