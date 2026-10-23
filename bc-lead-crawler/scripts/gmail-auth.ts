/**
 * One-time helper to authorize the Best Construction mailbox for the weekly job (OAuth 2.0, no password).
 * Run on your own computer: GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... npx tsx scripts/gmail-auth.ts
 * Sign in with the sending mailbox in the browser window; the refresh token is printed for the GMAIL_REFRESH_TOKEN
 * GitHub Secret. It is never written to a file.
 */
import { createServer } from 'node:http';

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
    console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (from Google Cloud Console → Credentials → OAuth client, type "Desktop app").');
    process.exit(1);
}
const scopes = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const code = url.searchParams.get('code');
    if (!code) return void res.end('Waiting for Google…');
    const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const token = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
    }).then((r) => r.json() as Promise<{ refresh_token?: string; error?: string }>);
    res.end(token.refresh_token ? 'Done. You can close this window and return to the terminal.' : `Failed: ${token.error}`);
    if (token.refresh_token) console.log(`\nGMAIL_REFRESH_TOKEN (paste into the GitHub Secret, then clear this terminal):\n${token.refresh_token}\n`);
    else console.error(`Authorization failed: ${token.error ?? 'no refresh token'}`);
    server.close();
});
server.listen(0, '127.0.0.1', () => {
    const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: scopes.join(' '), access_type: 'offline', prompt: 'consent' }).toString();
    console.log(`Open this link and sign in with the Best Construction sending mailbox:\n${auth.href}`);
});
