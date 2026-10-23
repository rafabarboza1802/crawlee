import type { PermitContact } from '../businesses.js';
import type { NormalizedPermit } from '../types.js';

export interface SourceContext {
    /** Sent with every request, so data publishers can see who is calling. */
    userAgent: string;
    /** Token matched against robots.txt `User-agent:` groups. */
    robotsToken: string;
    /** Optional Socrata app token (env SOCRATA_APP_TOKEN) for higher rate limits. */
    appToken?: string;
    /** Overrides the source's base URL (tests, mirrors). */
    baseUrl?: string;
    log: (message: string) => void;
}

export interface FetchPermitsOptions {
    /** Only permits filed or with a status change on/after this date. */
    since: Date;
    maxRows: number;
}

/**
 * A public permit data source for one jurisdiction. Implementations must only use official, publicly
 * accessible endpoints (no logins, no CAPTCHAs) and must not request personal contact fields.
 */
export interface PermitSource {
    id: string;
    name: string;
    city: string;
    county: string;
    /** Human-readable dataset page. */
    datasetUrl: string;
    /** Whether the source publishes contractor/owner business names at all (affects scoring neutrality). */
    publishesContacts: boolean;
    fetchPermits(ctx: SourceContext, options: FetchPermitsOptions): Promise<NormalizedPermit[]>;
    /** Business contacts for the given permits. Must request firm/role/license fields only. */
    fetchContacts?(ctx: SourceContext, permitNumbers: string[]): Promise<PermitContact[]>;
    /** URL documenting where a permit's contacts came from. */
    contactsUrl?(ctx: SourceContext, permitNumber: string): string;
    /** Converts one raw record (e.g. from a saved API response) into a permit. */
    normalize(raw: Record<string, unknown>, ctx: SourceContext): NormalizedPermit | undefined;
    /** Lists the dataset columns, to check field names before a first run. */
    probe?(ctx: SourceContext): Promise<{ dataset: string; columns: string[] }[]>;
}
