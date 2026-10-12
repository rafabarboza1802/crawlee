import type { PageFindings } from './extract.js';
import { uniqueEvidence } from './extract.js';
import type { CrawlStatus, PageRecord, Prospect, Seed, SkippedRecord } from './schema.js';
import { ProspectSchema } from './schema.js';

export interface SiteState {
    seed: Seed;
    prospectId: string;
    pages: PageRecord[];
    findings: PageFindings[];
    skipped: SkippedRecord[];
}

/** Dedupe key: lowercase hostname without a leading "www.". */
export function prospectIdFor(url: string): string {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

export function crawlStatusFor(state: SiteState): CrawlStatus {
    const ok = state.pages.filter((p) => p.status === 'ok').length;
    if (ok > 0) return ok === state.pages.length ? 'ok' : 'partial';
    if (state.pages.some((p) => p.status === 'blocked')) return 'blocked';
    if (state.pages.length === 0 && state.skipped.some((s) => s.reason === 'robotsTxt')) return 'robots_disallowed';
    return 'unreachable';
}

/** Merges all page findings for one site into a single validated prospect record. */
export function mergeSite(state: SiteState, crawledAt: Date): Prospect {
    const { seed, findings } = state;

    // Prefer the home page's name (first page crawled); seed name always wins.
    const detected = findings.find((f) => f.companyName?.source === 'json_ld')?.companyName ?? findings[0]?.companyName;

    return ProspectSchema.parse({
        schema_version: 1,
        prospect_id: state.prospectId,
        website: new URL(seed.website).origin,
        company_name: seed.company_name ?? detected?.value,
        company_name_source: seed.company_name ? 'seed' : detected?.source,
        segment_hint: seed.segment_hint,
        seed_source: seed.source,
        seed_notes: seed.notes,
        phones: uniqueEvidence(findings.flatMap((f) => f.phones)),
        business_emails: uniqueEvidence(findings.flatMap((f) => f.businessEmails)),
        contact_page_urls: [...new Set(findings.flatMap((f) => f.contactPageUrls))],
        address: findings.find((f) => f.address)?.address,
        service_area_mentions: uniqueEvidence(findings.flatMap((f) => f.serviceAreaMentions)),
        public_roles: uniqueEvidence(findings.flatMap((f) => f.publicRoles)),
        social_profiles: uniqueEvidence(findings.flatMap((f) => f.socialProfiles)),
        // One signal per keyword per site keeps records compact.
        signals: [...new Map(findings.flatMap((f) => f.signals).map((s) => [`${s.category}:${s.keyword.toLowerCase()}`, s])).values()],
        crawl_status: crawlStatusFor(state),
        pages: state.pages,
        skipped: state.skipped,
        crawled_at: crawledAt.toISOString(),
    });
}
