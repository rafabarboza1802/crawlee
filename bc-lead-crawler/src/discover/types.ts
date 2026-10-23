import { z } from 'zod';

import { SegmentGroupSchema } from '../schema.js';

/** Best Construction services an opportunity can be matched to. */
export const SERVICES = [
    'demolition',
    'interior_demolition',
    'excavation',
    'grading',
    'concrete',
    'pavers_hardscape',
    'paving',
    'drainage',
    'retaining_walls',
    'site_work',
    'land_clearing',
    'hauling_debris',
    'remodel',
    'adu',
    'general_construction',
] as const;
export const ServiceSchema = z.enum(SERVICES);
export type Service = z.infer<typeof ServiceSchema>;

export const BusinessRoleSchema = z.enum(['contractor', 'owner_business', 'architect', 'engineer', 'agent', 'other']);
export type BusinessRole = z.infer<typeof BusinessRoleSchema>;

/** A business entity named in public permit records. People's names are never stored. */
export const BusinessSchema = z.object({
    role: BusinessRoleSchema,
    name: z.string(),
    license: z.string().optional(),
    source_url: z.url(),
});
export type Business = z.infer<typeof BusinessSchema>;

/** Permit lifecycle stage, normalized across jurisdictions. */
export const PermitStageSchema = z.enum(['pre_construction', 'issued', 'stalled', 'inactive', 'unknown']);
export type PermitStage = z.infer<typeof PermitStageSchema>;

/** One permit, normalized from a jurisdiction-specific record. Only fields the public source provides. */
export interface NormalizedPermit {
    sourceId: string;
    permitNumber: string;
    permitType?: string;
    permitTypeCode?: string;
    description: string;
    status?: string;
    stage: PermitStage;
    statusDate?: string;
    filedDate?: string;
    issuedDate?: string;
    completedDate?: string;
    expirationDate?: string;
    estimatedCost?: number;
    revisedCost?: number;
    existingUse?: string;
    proposedUse?: string;
    existingUnits?: number;
    proposedUnits?: number;
    proposedStories?: number;
    address?: string;
    city: string;
    county: string;
    zip?: string;
    /** Assessor parcel identifier (public), e.g. SF "block/lot". */
    parcel?: string;
    neighborhood?: string;
    latitude?: number;
    longitude?: number;
    softStoryRetrofit?: boolean;
    /** Public URL of this permit record (API query or permit-tracking page). */
    sourceUrl: string;
}

const ScoreFactorSchema = z.object({
    factor: z.enum(['service_fit', 'project_value', 'stage', 'recency', 'approach', 'adjustment']),
    points: z.number(),
    max: z.number(),
    detail: z.string(),
});
export type ScoreFactor = z.infer<typeof ScoreFactorSchema>;

const RelatedPermitSchema = z.object({
    permit_number: z.string(),
    permit_type: z.string().optional(),
    status: z.string().optional(),
    status_date: z.string().optional(),
    description: z.string(),
    source_url: z.url(),
});

/**
 * One construction opportunity (a project, possibly made of several permits on the same parcel).
 * This is the contract consumed by agency-agents. Discovery never contacts anyone.
 */
export const OpportunitySchema = z.object({
    schema_version: z.literal(1),
    /** Stable across runs: `<source>:<parcel or address>`. */
    opportunity_id: z.string(),
    source: z.object({
        id: z.string(),
        name: z.string(),
        dataset_url: z.url(),
        record_url: z.url(),
    }),
    jurisdiction: z.object({ city: z.string(), county: z.string(), state: z.literal('CA') }),
    location: z.object({
        address: z.string().optional(),
        zip: z.string().optional(),
        parcel: z.string().optional(),
        neighborhood: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
    }),
    permit: z.object({
        number: z.string(),
        type: z.string().optional(),
        status: z.string().optional(),
        stage: PermitStageSchema,
        status_date: z.string().optional(),
        filed_date: z.string().optional(),
        issued_date: z.string().optional(),
        expiration_date: z.string().optional(),
    }),
    project_description: z.string(),
    estimated_value: z.number().nullable(),
    value_basis: z.enum(['revised_cost', 'estimated_cost']).nullable(),
    existing_use: z.string().optional(),
    proposed_use: z.string().optional(),
    existing_units: z.number().optional(),
    proposed_units: z.number().optional(),
    businesses: z.array(BusinessSchema),
    services: z.array(
        z.object({
            service: ServiceSchema,
            /** Words in the public record that triggered the match, or the rule that implied it. */
            evidence: z.array(z.string()),
        }),
    ),
    lead_segment: SegmentGroupSchema,
    segment_reason: z.string(),
    /** Who may be approached. Homeowner-only projects are signals, never contact targets. */
    contact_policy: z.enum(['approach_named_businesses', 'research_contractor_first', 'no_direct_contact']),
    score: z.number().int().min(0).max(100),
    score_band: z.enum(['high', 'medium', 'low']),
    score_reasons: z.array(ScoreFactorSchema),
    score_summary: z.string(),
    related_permits: z.array(RelatedPermitSchema),
    is_new: z.boolean(),
    first_seen_at: z.iso.datetime(),
    discovered_at: z.iso.datetime(),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;
