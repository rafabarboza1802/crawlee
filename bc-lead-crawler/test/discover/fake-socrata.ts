import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeSocrataOptions {
    datasets: Record<string, Record<string, unknown>[]>;
    columns?: Record<string, string[]>;
    robots?: [number, string];
    /** Respond with these statuses (in order) before serving normally. */
    failFirst?: { status: number; body?: string; retryAfter?: string }[];
}

export interface Request {
    path: string;
    params: URLSearchParams;
    headers: IncomingMessage['headers'];
}

/** A tiny local stand-in for a Socrata portal: robots.txt, /resource/<id>.json with $limit/$offset/$select/permit_number filters. */
export async function startFakeSocrata(options: FakeSocrataOptions) {
    const requests: Request[] = [];
    const failures = [...(options.failFirst ?? [])];
    const server: Server = createServer((req, res) => {
        const url = new URL(req.url!, 'http://x');
        requests.push({ path: url.pathname, params: url.searchParams, headers: req.headers });

        if (url.pathname === '/robots.txt') {
            const [status, body] = options.robots ?? [200, 'User-agent: *\nAllow: /\n'];
            res.writeHead(status, { 'content-type': 'text/plain' });
            return res.end(body);
        }
        const failure = failures.shift();
        if (failure) {
            res.writeHead(failure.status, { 'content-type': 'application/json', ...(failure.retryAfter ? { 'retry-after': failure.retryAfter } : {}) });
            return res.end(failure.body ?? '{"message":"error"}');
        }
        const views = /^\/api\/views\/([\w-]+)\.json$/.exec(url.pathname);
        if (views) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ columns: (options.columns?.[views[1]!] ?? []).map((fieldName) => ({ fieldName })) }));
        }
        const resource = /^\/resource\/([\w-]+)\.json$/.exec(url.pathname);
        const rows = resource ? options.datasets[resource[1]!] : undefined;
        if (!rows) {
            res.writeHead(404);
            return res.end();
        }
        let out = rows;
        const inList = /permit_number in \(([^)]*)\)/.exec(url.searchParams.get('$where') ?? '');
        if (inList) {
            const wanted = new Set([...inList[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]));
            out = out.filter((r) => wanted.has(String(r.permit_number)));
        }
        const select = url.searchParams.get('$select');
        if (select) {
            const fields = select.split(',');
            out = out.map((r) => Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]])));
        }
        const offset = Number(url.searchParams.get('$offset') ?? 0);
        const limit = Number(url.searchParams.get('$limit') ?? 1000);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.slice(offset, offset + limit)));
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    return {
        baseUrl: `http://localhost:${(server.address() as AddressInfo).port}`,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
