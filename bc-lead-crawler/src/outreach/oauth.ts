import { createHash, randomBytes } from 'node:crypto';

/**
 * Google OAuth 2.0 for an installed ("Desktop app") client: loopback redirect, authorization-code flow with PKCE.
 * Used once by scripts/gmail-auth.ts to obtain the GMAIL_REFRESH_TOKEN for the weekly job.
 * https://developers.google.com/identity/protocols/oauth2/native-app
 */
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Send emails, and read the mailbox only to detect replies, bounces and unsubscribe requests. */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE pair (S256). */
export function pkcePair(): { verifier: string; challenge: string } {
    const verifier = b64url(randomBytes(48));
    return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export const randomState = () => b64url(randomBytes(16));

/**
 * The consent-page URL. `response_type=code` comes first so it survives even if a long link is cut short;
 * `access_type=offline` + `prompt=consent` make Google return a refresh token.
 */
export function authorizationUrl(o: { clientId: string; redirectUri: string; state: string; codeChallenge: string; loginHint?: string }): string {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: o.clientId,
        redirect_uri: o.redirectUri,
        scope: GMAIL_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state: o.state,
        code_challenge: o.codeChallenge,
        code_challenge_method: 'S256',
    });
    if (o.loginHint) params.set('login_hint', o.loginHint);
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Body of the authorization-code → tokens exchange. */
export function tokenRequestBody(o: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier: string }): URLSearchParams {
    return new URLSearchParams({
        grant_type: 'authorization_code',
        code: o.code,
        client_id: o.clientId,
        client_secret: o.clientSecret,
        redirect_uri: o.redirectUri,
        code_verifier: o.codeVerifier,
    });
}

/** Client IDs of Google OAuth clients look like "123-abc.apps.googleusercontent.com". */
export const looksLikeClientId = (id: string) => /^[\w-]+\.apps\.googleusercontent\.com$/.test(id.trim());
