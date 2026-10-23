/** What the outreach engine needs from a mailbox. Implemented by Gmail; tests use an in-memory fake. */
export interface OutgoingEmail {
    to: string;
    subject: string;
    text: string;
    /** Continue an existing conversation (follow-ups). */
    threadId?: string;
    inReplyTo?: string;
    /** mailto: unsubscribe address for the List-Unsubscribe header. */
    unsubscribeMailto?: string;
}

export interface SentEmail {
    messageId: string;
    threadId: string;
    /** RFC 822 Message-ID header, for threading follow-ups. */
    rfcMessageId?: string;
}

export interface ThreadMessage {
    from: string;
    date: string;
    subject: string;
    snippet: string;
    /** Addresses a delivery failure notice reports (X-Failed-Recipients). */
    failedRecipients?: string[];
}

export interface InboxMessage extends ThreadMessage {
    id: string;
    threadId: string;
}

export interface EmailProvider {
    readonly name: string;
    /** Checks the credentials and returns the authenticated mailbox address. */
    whoAmI(): Promise<string>;
    send(email: OutgoingEmail): Promise<SentEmail>;
    threadMessages(threadId: string): Promise<ThreadMessage[]>;
    /** Messages matching a mailbox search (Gmail query syntax), newest first. */
    search(query: string, max: number): Promise<InboxMessage[]>;
}

export class EmailAuthError extends Error {}

/** "Sam Estimator <sam@example.com>" → "sam@example.com" */
export function addressOf(header: string): string {
    const m = /<([^>]+)>/.exec(header);
    return (m ? m[1]! : header).trim().toLowerCase();
}

const BOUNCE_SENDER = /^(?:mailer-daemon|postmaster)@/i;
export const isBounceNotice = (m: ThreadMessage) => BOUNCE_SENDER.test(addressOf(m.from)) || /delivery status notification|undeliverable|delivery has failed/i.test(m.subject);

const OPT_OUT = /\b(?:unsubscribe|remove me|opt[\s-]?out|stop emailing|do not (?:email|contact)|take me off)\b/i;
export const isOptOut = (m: Pick<ThreadMessage, 'subject' | 'snippet'>) => OPT_OUT.test(`${m.subject} ${m.snippet}`);
