import { z } from 'zod';

/**
 * Target segments. The crawler only passes through the hint given in the seed file;
 * final segment classification is done downstream by the agency-agents pipeline.
 */
export const SEGMENTS = [
    'property_manager',
    'multifamily_property_manager',
    'hoa_management',
    'commercial_property_manager',
    'general_contractor',
    'developer',
    'home_builder',
    'commercial_real_estate',
    'public_agency',
    'unknown',
] as const;

export const SegmentSchema = z.enum(SEGMENTS);
export type Segment = z.infer<typeof SegmentSchema>;

export const SeedSchema = z.object({
    website: z.url(),
    company_name: z.string().optional(),
    segment_hint: SegmentSchema.default('unknown'),
    /** Where this company came from, e.g. "apollo", "manual", "datasf-permits". */
    source: z.string().default('manual'),
    notes: z.string().optional(),
});
export type Seed = z.infer<typeof SeedSchema>;

/** Every extracted fact carries the public page it came from. */
const Evidence = z.object({
    value: z.string(),
    source_url: z.url(),
});
export type Evidence = z.infer<typeof Evidence>;

export const SignalCategorySchema = z.enum(['hardscape', 'paving', 'demolition_sitework', 'remodel', 'portfolio', 'project_activity']);
export type SignalCategory = z.infer<typeof SignalCategorySchema>;

const Signal = z.object({
    category: SignalCategorySchema,
    keyword: z.string(),
    /** Short quote from the page so a human (or agent) can verify the signal. */
    snippet: z.string(),
    source_url: z.url(),
});
export type Signal = z.infer<typeof Signal>;

const Address = z.object({
    street: z.string().optional(),
    city: z.string().optional(),
    region: z.string().optional(),
    postal_code: z.string().optional(),
    source_url: z.url(),
});
export type Address = z.infer<typeof Address>;

export const PageStatusSchema = z.enum(['ok', 'blocked', 'not_found', 'error']);

const PageRecord = z.object({
    url: z.url(),
    status: PageStatusSchema,
    http_status: z.number().int().optional(),
    note: z.string().optional(),
    fetched_at: z.iso.datetime(),
});
export type PageRecord = z.infer<typeof PageRecord>;

const SkippedRecord = z.object({
    url: z.string(),
    /** Crawlee skip reason, e.g. "robotsTxt", "limit", "depth". */
    reason: z.string(),
});
export type SkippedRecord = z.infer<typeof SkippedRecord>;

export const CrawlStatusSchema = z.enum(['ok', 'partial', 'blocked', 'robots_disallowed', 'unreachable']);
export type CrawlStatus = z.infer<typeof CrawlStatusSchema>;

/**
 * One record per company website. This is the contract consumed by agency-agents.
 */
export const ProspectSchema = z.object({
    schema_version: z.literal(1),
    /** Registrable hostname without "www.", used as the dedupe key. */
    prospect_id: z.string(),
    website: z.url(),
    company_name: z.string().optional(),
    company_name_source: z.enum(['seed', 'json_ld', 'og_site_name', 'title']).optional(),
    segment_hint: SegmentSchema,
    seed_source: z.string(),
    seed_notes: z.string().optional(),
    phones: z.array(Evidence),
    /** Generic business mailboxes only (info@, office@, ...). Not verified; outreach must use Apollo-verified contacts. */
    business_emails: z.array(Evidence),
    contact_page_urls: z.array(z.url()),
    address: Address.optional(),
    /** Bay Area cities/regions mentioned on the site — a proxy for service area. */
    service_area_mentions: z.array(Evidence),
    /** Job titles published on the site (titles only — names are intentionally not collected). */
    public_roles: z.array(Evidence),
    social_profiles: z.array(Evidence),
    signals: z.array(Signal),
    crawl_status: CrawlStatusSchema,
    pages: z.array(PageRecord),
    skipped: z.array(SkippedRecord),
    crawled_at: z.iso.datetime(),
});
export type Prospect = z.infer<typeof ProspectSchema>;
