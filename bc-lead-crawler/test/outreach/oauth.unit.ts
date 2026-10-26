import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { authorizationUrl, GMAIL_SCOPES, looksLikeClientId, pkcePair, tokenRequestBody } from '../../src/outreach/oauth.js';

const CLIENT = '1234-abc.apps.googleusercontent.com';

describe('Google OAuth for the Desktop-app client', () => {
    test('consent URL has every required parameter, response_type=code first', () => {
        const url = new URL(authorizationUrl({ clientId: CLIENT, redirectUri: 'http://127.0.0.1:5555', state: 's1', codeChallenge: 'c1' }));
        expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect([...url.searchParams.keys()][0]).toBe('response_type');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            response_type: 'code',
            client_id: CLIENT,
            redirect_uri: 'http://127.0.0.1:5555',
            scope: GMAIL_SCOPES.join(' '),
            access_type: 'offline',
            prompt: 'consent',
            include_granted_scopes: 'true',
            state: 's1',
            code_challenge: 'c1',
            code_challenge_method: 'S256',
        });
    });

    test('PKCE challenge is the S256 of the verifier; token exchange sends the verifier and the same redirect URI', () => {
        const { verifier, challenge } = pkcePair();
        expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
        const body = Object.fromEntries(tokenRequestBody({ code: 'x', clientId: CLIENT, clientSecret: 's', redirectUri: 'http://127.0.0.1:5555', codeVerifier: verifier }));
        expect(body).toEqual({ grant_type: 'authorization_code', code: 'x', client_id: CLIENT, client_secret: 's', redirect_uri: 'http://127.0.0.1:5555', code_verifier: verifier });
    });

    test('client ID format check', () => {
        expect(looksLikeClientId(CLIENT)).toBe(true);
        expect(looksLikeClientId('GOCSPX-secret')).toBe(false);
    });

    test('the helper serves a short local link that forwards to the complete Google URL, and rejects foreign responses', async () => {
        // node + tsx loader directly (not npx), so killing the child really stops the helper.
        const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/gmail-auth.ts'], {
            cwd: new URL('../..', import.meta.url).pathname,
            env: { ...process.env, GMAIL_CLIENT_ID: CLIENT, GMAIL_CLIENT_SECRET: 'test-secret', PATH: process.env.PATH },
        });
        try {
            const link = await new Promise<string>((resolve, reject) => {
                let out = '';
                child.stdout.on('data', (d: Buffer) => {
                    out += d.toString();
                    const m = /paste this link into it: (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
                    if (m) resolve(m[1]!);
                });
                child.on('exit', () => reject(new Error(`helper exited: ${out}`)));
            });
            const start = await fetch(link, { redirect: 'manual' });
            expect(start.status).toBe(302);
            const google = new URL(start.headers.get('location')!);
            expect(google.searchParams.get('response_type')).toBe('code');
            expect(google.searchParams.get('client_id')).toBe(CLIENT);
            expect(google.searchParams.get('redirect_uri')).toBe(link);
            expect(google.searchParams.get('code_challenge_method')).toBe('S256');
            expect(google.toString()).not.toContain('test-secret');
            const forged = await fetch(`${link}/?code=abc&state=wrong`);
            expect(forged.status).toBe(400);
        } finally {
            child.kill();
        }
    }, 30_000);
});
