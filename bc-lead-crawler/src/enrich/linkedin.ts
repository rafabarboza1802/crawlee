/**
 * LinkedIn is used only through compliant means: profile URLs returned by a licensed provider (Apollo) and search
 * links that a person opens manually in their own logged-in browser. Code never requests linkedin.com.
 */

const LINKEDIN_HOST = /(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/i;

export class LinkedInAccessError extends Error {}

/** Throws if a URL points at LinkedIn. Every HTTP request made by the enrichment engine must pass this guard. */
export function assertNotLinkedIn(url: string): void {
    if (LINKEDIN_HOST.test(new URL(url).hostname)) {
        throw new LinkedInAccessError(`Refusing to request ${new URL(url).hostname}: LinkedIn is never fetched by code.`);
    }
}

/** `fetch` wrapper that refuses LinkedIn hosts. */
export async function guardedFetch(input: string, init?: RequestInit): Promise<Response> {
    assertNotLinkedIn(input);
    return fetch(input, init);
}

/** People search link for manual use, e.g. `"Nolan Construction" Estimator`. */
export function linkedInPeopleSearchUrl(company: string, title?: string): string {
    const url = new URL('https://www.linkedin.com/search/results/people/');
    url.searchParams.set('keywords', [`"${company}"`, title].filter(Boolean).join(' '));
    return url.href;
}

/** Company search link for manual use. */
export function linkedInCompanySearchUrl(company: string): string {
    const url = new URL('https://www.linkedin.com/search/results/companies/');
    url.searchParams.set('keywords', company);
    return url.href;
}
