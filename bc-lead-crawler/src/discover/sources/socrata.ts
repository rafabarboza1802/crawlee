import { fetchRobotsPolicy } from '../../robots.js';
import type { SourceContext } from './source.js';

export class SourceAccessError extends Error {}
/** Raised when a dataset does not have the expected columns (field names changed or were never as documented). */
export class SchemaError extends Error {}

export interface SocrataOptions {
    pageSize?: number;
    /** Pause between pages, to keep load on the publisher low. */
    pageDelayMs?: number;
    maxAttempts?: number;
}

type Row = Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** SoQL floating-timestamp literal, e.g. '2026-09-15T00:00:00'. */
export function soqlDate(date: Date): string {
    return `'${date.toISOString().slice(0, 19)}'`;
}

/** Quotes a string literal for SoQL. */
export function soqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Minimal client for the Socrata Open Data API (SODA), used by DataSF and many other California portals.
 * Checks robots.txt once per host, identifies itself, paginates, and backs off on 429/5xx.
 */
export class SocrataClient {
    #robotsChecked?: Promise<void>;

    constructor(
        readonly baseUrl: string,
        private readonly ctx: SourceContext,
        private readonly options: SocrataOptions = {},
    ) {}

    resourceUrl(dataset: string, params: Record<string, string> = {}): string {
        const url = new URL(`/resource/${dataset}.json`, this.baseUrl);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        return url.href;
    }

    /** Runs a SoQL query and follows pages until `maxRows` or the end of the data. */
    async query(dataset: string, params: Record<string, string>, maxRows = Infinity): Promise<Row[]> {
        const pageSize = Math.min(this.options.pageSize ?? 1000, maxRows);
        const rows: Row[] = [];
        for (let offset = 0; rows.length < maxRows; offset += pageSize) {
            const page = await this.getJson<Row[]>(this.resourceUrl(dataset, { ...params, $limit: String(pageSize), $offset: String(offset) }));
            rows.push(...page.slice(0, maxRows - rows.length));
            if (page.length < pageSize) break;
            await sleep(this.options.pageDelayMs ?? 500);
        }
        return rows;
    }

    /** Column field names from the dataset metadata (no row data is downloaded). */
    async columns(dataset: string): Promise<string[]> {
        const meta = await this.getJson<{ columns?: { fieldName: string }[] }>(new URL(`/api/views/${dataset}.json`, this.baseUrl).href);
        return (meta.columns ?? []).map((c) => c.fieldName).filter((name) => !name.startsWith(':'));
    }

    private async checkRobots(url: string): Promise<void> {
        this.#robotsChecked ??= fetchRobotsPolicy(url, { userAgent: this.ctx.userAgent, robotsToken: this.ctx.robotsToken }).then((policy) => {
            if (policy.status === 'unavailable') {
                throw new SourceAccessError(`${policy.reason}; not querying ${this.baseUrl} (robots.txt must be readable).`);
            }
            if (!policy.isAllowed(url)) {
                throw new SourceAccessError(`robots.txt at ${policy.robotsUrl} disallows ${new URL(url).pathname}; not querying it.`);
            }
        });
        return this.#robotsChecked;
    }

    private async getJson<T>(url: string): Promise<T> {
        await this.checkRobots(url);
        const headers: Record<string, string> = { 'user-agent': this.ctx.userAgent, accept: 'application/json' };
        if (this.ctx.appToken) headers['x-app-token'] = this.ctx.appToken;

        const maxAttempts = this.options.maxAttempts ?? 3;
        for (let attempt = 1; ; attempt++) {
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
            if (response.ok) return (await response.json()) as T;

            const body = (await response.text()).slice(0, 500);
            const retryable = response.status === 429 || response.status >= 500;
            if (retryable && attempt < maxAttempts) {
                const retryAfter = Number(response.headers.get('retry-after'));
                const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** (attempt - 1);
                this.ctx.log(`HTTP ${response.status} from ${new URL(url).host}; retrying in ${Math.round(waitMs / 1000)}s`);
                await sleep(waitMs);
                continue;
            }
            if (response.status === 400 && /column|field|no-such/i.test(body)) {
                throw new SchemaError(`Dataset query rejected (${body}). The dataset's field names may have changed; run with --probe.`);
            }
            if (response.status === 401 || response.status === 403) {
                throw new SourceAccessError(`HTTP ${response.status} from ${url}; access denied, not retrying.`);
            }
            throw new Error(`HTTP ${response.status} from ${url}: ${body}`);
        }
    }
}
