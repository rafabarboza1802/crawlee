import { randomBytes } from 'node:crypto';

import type { EmailProvider, InboxMessage, OutgoingEmail, SentEmail, ThreadMessage } from './provider.js';
import { EmailAuthError } from './provider.js';

/**
 * Gmail / Google Workspace via the Gmail API with OAuth 2.0 (refresh token). No password is ever used or stored:
 * GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN come from GitHub Secrets.
 * Scopes needed: gmail.send (send) and gmail.readonly (detect replies, bounces and unsubscribe requests).
 */
export interface GmailCredentials {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
}

export function gmailCredentials(env: NodeJS.ProcessEnv = process.env): GmailCredentials | undefined {
    const clientId = env.GMAIL_CLIENT_ID?.trim();
    const clientSecret = env.GMAIL_CLIENT_SECRET?.trim();
    const refreshToken = env.GMAIL_REFRESH_TOKEN?.trim();
    return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : undefined;
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 2047 encoded-word for non-ASCII header values. */
const header = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=`);

/** Builds the raw RFC 5322 message (plain text, UTF-8). */
export function buildMime(email: OutgoingEmail, from: string, domain = from.split('@')[1] ?? 'localhost'): { raw: string; messageId: string } {
    const messageId = `<${randomBytes(12).toString('hex')}@${domain}>`;
    const lines = [
        `From: ${from}`,
        `To: ${email.to}`,
        `Subject: ${header(email.subject)}`,
        `Message-ID: ${messageId}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
    ];
    if (email.inReplyTo) lines.push(`In-Reply-To: ${email.inReplyTo}`, `References: ${email.inReplyTo}`);
    if (email.unsubscribeMailto) lines.push(`List-Unsubscribe: <mailto:${email.unsubscribeMailto}?subject=unsubscribe>`);
    return { raw: `${lines.join('\r\n')}\r\n\r\n${email.text.replace(/\r?\n/g, '\r\n')}`, messageId };
}

interface GmailHeaders {
    payload?: { headers?: { name: string; value: string }[] };
    snippet?: string;
    id?: string;
    threadId?: string;
}

export class GmailProvider implements EmailProvider {
    readonly name = 'gmail';
    private token?: { value: string; expires: number };

    constructor(
        private readonly creds: GmailCredentials,
        private readonly from: string,
        private readonly urls = { token: 'https://oauth2.googleapis.com/token', api: 'https://gmail.googleapis.com/gmail/v1/users/me' },
    ) {}

    private async accessToken(): Promise<string> {
        if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
        const res = await fetch(this.urls.token, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: this.creds.clientId, client_secret: this.creds.clientSecret, refresh_token: this.creds.refreshToken, grant_type: 'refresh_token' }),
        });
        const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
        // Never include credentials in errors; Google's error code is enough to act on.
        if (!res.ok || !json.access_token) throw new EmailAuthError(`Gmail authorization failed (${res.status} ${json.error ?? 'no access token'}). Re-authorize the mailbox and update GMAIL_REFRESH_TOKEN.`);
        this.token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
        return this.token.value;
    }

    private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
        const res = await fetch(`${this.urls.api}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' } });
        if (res.status === 401 || res.status === 403) throw new EmailAuthError(`Gmail refused the request (${res.status}). Check the mailbox authorization and scopes (gmail.send, gmail.readonly).`);
        if (!res.ok) throw new Error(`Gmail API ${path.split('?')[0]} failed with HTTP ${res.status}`);
        return (await res.json()) as T;
    }

    async whoAmI(): Promise<string> {
        const profile = await this.api<{ emailAddress?: string }>('/profile');
        return (profile.emailAddress ?? '').toLowerCase();
    }

    async send(email: OutgoingEmail): Promise<SentEmail> {
        const { raw, messageId } = buildMime(email, this.from);
        const res = await this.api<{ id: string; threadId: string }>('/messages/send', {
            method: 'POST',
            body: JSON.stringify({ raw: b64url(raw), ...(email.threadId ? { threadId: email.threadId } : {}) }),
        });
        return { messageId: res.id, threadId: res.threadId, rfcMessageId: messageId };
    }

    private toMessage(m: GmailHeaders): ThreadMessage {
        const h = (name: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? '';
        const failed = h('X-Failed-Recipients');
        return { from: h('From'), date: h('Date'), subject: h('Subject'), snippet: m.snippet ?? '', ...(failed ? { failedRecipients: failed.split(',').map((x) => x.trim().toLowerCase()) } : {}) };
    }

    async threadMessages(threadId: string): Promise<ThreadMessage[]> {
        const meta = 'format=metadata&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Subject&metadataHeaders=X-Failed-Recipients';
        const thread = await this.api<{ messages?: GmailHeaders[] }>(`/threads/${encodeURIComponent(threadId)}?${meta}`);
        return (thread.messages ?? []).map((m) => this.toMessage(m));
    }

    async search(query: string, max: number): Promise<InboxMessage[]> {
        const list = await this.api<{ messages?: { id: string; threadId: string }[] }>(`/messages?q=${encodeURIComponent(query)}&maxResults=${max}`);
        const meta = 'format=metadata&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Subject&metadataHeaders=X-Failed-Recipients';
        const out: InboxMessage[] = [];
        for (const { id, threadId } of list.messages ?? []) {
            const m = await this.api<GmailHeaders>(`/messages/${encodeURIComponent(id)}?${meta}`);
            out.push({ ...this.toMessage(m), id, threadId });
        }
        return out;
    }
}
