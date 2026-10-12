import { createRequire } from 'node:module';

// robots-parser is CommonJS (`module.exports = fn`) but its typings declare an ES default export,
// so load it via require to get the function with correct types under NodeNext resolution.
const robotsParser = createRequire(import.meta.url)('robots-parser') as typeof import('robots-parser').default;

export type RobotsPolicy =
    | { status: 'ok'; robotsUrl: string; isAllowed: (url: string) => boolean; crawlDelaySecs?: number }
    | { status: 'unavailable'; robotsUrl: string; reason: string };

export interface RobotsFetchOptions {
    /** Full User-Agent header sent when fetching robots.txt. */
    userAgent: string;
    /** Product token matched against `User-agent:` groups. */
    robotsToken: string;
    timeoutMillis?: number;
}

/**
 * Fetches and interprets robots.txt following RFC 9309:
 * - 2xx: obey the rules (including Crawl-delay),
 * - 4xx: no rules, everything allowed,
 * - 5xx or unreachable: assume everything is disallowed.
 */
export async function fetchRobotsPolicy(siteUrl: string, options: RobotsFetchOptions): Promise<RobotsPolicy> {
    const robotsUrl = new URL('/robots.txt', siteUrl).href;
    let response: Response;
    try {
        response = await fetch(robotsUrl, {
            headers: { 'user-agent': options.userAgent },
            redirect: 'follow',
            signal: AbortSignal.timeout(options.timeoutMillis ?? 15_000),
        });
    } catch (error) {
        return { status: 'unavailable', robotsUrl, reason: `robots.txt unreachable: ${(error as Error).message}` };
    }

    if (response.status >= 400 && response.status < 500) {
        return { status: 'ok', robotsUrl, isAllowed: () => true };
    }
    if (!response.ok) {
        return { status: 'unavailable', robotsUrl, reason: `robots.txt returned HTTP ${response.status}` };
    }

    // Rules apply to the original host even if robots.txt redirected elsewhere.
    const robots = robotsParser(robotsUrl, await response.text());
    return {
        status: 'ok',
        robotsUrl,
        isAllowed: (url) => robots.isAllowed(url, options.robotsToken) === true,
        crawlDelaySecs: robots.getCrawlDelay(options.robotsToken),
    };
}
