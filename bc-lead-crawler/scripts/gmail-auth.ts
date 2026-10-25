/**
 * One-time helper to authorize the Best Construction mailbox for the weekly job (OAuth 2.0 for a "Desktop app"
 * client, with PKCE). No password is used or stored.
 *
 *   npx tsx scripts/gmail-auth.ts
 *
 * It asks for the OAuth client ID and secret (or reads GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET), opens Google's consent
 * page in your browser, and prints the refresh token for the GMAIL_REFRESH_TOKEN GitHub Secret. Nothing is written to
 * disk. If the browser does not open, paste the short http://127.0.0.1:… link it prints (it forwards to Google).
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';

import { authorizationUrl, GOOGLE_TOKEN_URL, looksLikeClientId, pkcePair, randomState, tokenRequestBody } from '../src/outreach/oauth.js';

/** One shared reader for all questions (so fast typing or pasting is never lost between prompts). */
let muted = false;
const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY ?? false });
const rlOut = rl as unknown as { _writeToOutput: (s: string) => void };
const writeOut = rlOut._writeToOutput.bind(rl);
rlOut._writeToOutput = (s: string) => writeOut(muted ? s.replace(/[^\r\n]/g, '') : s);
const lines: string[] = [];
const waiting: ((line: string) => void)[] = [];
rl.on('line', (line) => (waiting.length ? waiting.shift()!(line) : lines.push(line)));

/** Reads one line; `hidden` keeps the secret off the screen. */
function ask(question: string, hidden = false): Promise<string> {
    stdout.write(question);
    muted = hidden;
    return new Promise<string>((resolve) => {
        const done = (line: string) => {
            muted = false;
            if (hidden) stdout.write('\n');
            resolve(line.trim());
        };
        if (lines.length) done(lines.shift()!);
        else waiting.push(done);
    });
}

function openBrowser(url: string) {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    execFile(cmd as string, args as string[], () => {});
}

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:40em;margin:3em auto"><h2>${title}</h2><p>${body}</p></body>`;

const clientId = process.env.GMAIL_CLIENT_ID?.trim() || (await ask('Paste your Google OAuth client ID (Desktop app) and press Enter: '));
if (!looksLikeClientId(clientId)) {
    rl.close();
    console.error('That does not look like a Google OAuth client ID (it ends with .apps.googleusercontent.com). Copy it from Google Cloud Console → APIs & Services → Credentials.');
    process.exit(1);
}
const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim() || (await ask('Paste the client secret (it will not be shown) and press Enter: ', true));
if (!clientSecret) {
    console.error('The client secret is required.');
    process.exit(1);
}
rl.close();

const state = randomState();
const pkce = pkcePair();
let redirectUri = '';
let googleUrl = '';

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
    }
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (!code && !error) {
        // The short start link: forward the browser to Google's consent page.
        res.writeHead(302, { location: googleUrl }).end();
        return;
    }
    if (error) {
        res.writeHead(200, { 'content-type': 'text/html' }).end(page('Authorization not completed', `Google returned "${error}". Return to the terminal.`));
        console.error(`\nGoogle returned "${error}". Nothing was saved. Run the command again to retry.`);
        server.close();
        process.exitCode = 1;
        return;
    }
    if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/html' }).end(page('Stopped', 'This response did not come from this sign-in. Run the command again.'));
        return;
    }
    const token = (await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenRequestBody({ code: code!, clientId, clientSecret, redirectUri, codeVerifier: pkce.verifier }),
    })
        .then((r) => r.json())
        .catch(() => ({ error: 'network_error' }))) as { refresh_token?: string; error?: string; error_description?: string };
    if (token.refresh_token) {
        res.writeHead(200, { 'content-type': 'text/html' }).end(page('Done', 'Authorization complete. You can close this tab and return to the terminal.'));
        console.log('\nSuccess. Add this as the GitHub Secret GMAIL_REFRESH_TOKEN (Settings → Secrets and variables → Actions),');
        console.log('then close this terminal window. Do not paste it anywhere else.\n');
        console.log(token.refresh_token);
        console.log('');
    } else {
        const why = token.error_description ?? token.error ?? 'no refresh token returned';
        res.writeHead(200, { 'content-type': 'text/html' }).end(page('Authorization failed', `${why}. Return to the terminal.`));
        console.error(`\nAuthorization failed: ${why}`);
        if (token.error === 'invalid_client') console.error('Check that the client ID and secret belong to the same OAuth client of type "Desktop app".');
        process.exitCode = 1;
    }
    server.close();
});

server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    redirectUri = `http://127.0.0.1:${port}`;
    googleUrl = authorizationUrl({ clientId, redirectUri, state, codeChallenge: pkce.challenge });
    console.log('\nOpening Google sign-in in your browser. Sign in with the Best Construction mailbox that will send the emails.');
    console.log(`If the browser does not open, paste this link into it: ${redirectUri}\n`);
    openBrowser(redirectUri);
});

// Give up after 10 minutes so the helper never keeps running in the background.
setTimeout(() => {
    console.error('\nTimed out after 10 minutes without a sign-in. Run the command again.');
    server.close();
    process.exit(1);
}, 10 * 60_000).unref();
