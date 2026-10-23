import type { LeadRecord } from '../leads/types.js';
import type { OutreachConfig } from './config.js';

export interface EmailContext {
    /** Recipient's first name (from the verified contact). */
    firstName: string;
    /** Company receiving the email (the buyer, e.g. the managing GC of a JV). */
    company: string;
    /** The lead the email is about, plus up to one more project of the same company. */
    lead: LeadRecord;
    otherLeads: LeadRecord[];
    sender: OutreachConfig['sender'];
}

export interface RenderedEmail {
    subject: string;
    text: string;
}

/** Plain-language scope names, as they would appear in a bid invitation. */
const SCOPE_PHRASE: Record<string, string> = {
    Demolition: 'demolition',
    'Interior demolition': 'interior demolition',
    Excavation: 'excavation',
    Grading: 'grading',
    'Sitework/earthwork': 'sitework and earthwork',
    'Land clearing': 'land clearing',
    'Concrete flatwork/removal': 'site concrete and concrete removal',
    'Underground/site utilities (drainage)': 'site utilities and drainage',
    'Sitework (retaining walls)': 'site retaining walls',
    'Hauling and debris removal': 'hauling and debris removal',
    Paving: 'paving',
    'Pavers/hardscape': 'pavers and hardscape',
};

/** Only the scopes this project actually involves (max 3), in plain words: "excavation, grading and hauling". */
export function scopePhrase(lead: LeadRecord): string {
    const phrases = [...new Set(lead.project.target_scopes.map((s) => SCOPE_PHRASE[s] ?? s.toLowerCase()))].slice(0, 3);
    if (phrases.length <= 1) return phrases[0] ?? 'site work';
    return `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`;
}

const firstClause = (s: string) => s.split(/\s+—\s+/)[0]!;
const shortProject = (lead: LeadRecord) => firstClause(lead.project.name).replace(/^New /, 'new ').replace(/^(\w)/, (c) => c.toLowerCase());
const where = (lead: LeadRecord) => [lead.project.address, lead.project.city].filter(Boolean).join(', ');

function signature(sender: OutreachConfig['sender']): string {
    return [sender.name, sender.title, sender.company, sender.phone, sender.website.replace(/^https?:\/\//, ''), sender.postalAddress].filter(Boolean).join('\n');
}

export const OPT_OUT_LINE = 'If you would rather not hear from us, reply "unsubscribe" and we will not email you again.';

/**
 * Email #1 (day 0), #2 (follow-up 1) and #3 (follow-up 2). Short, factual, and limited to what public records and the
 * verified contact show: no claims about licences, bonding, experience or past projects.
 */
export function renderEmail(step: number, ctx: EmailContext): RenderedEmail {
    const { lead } = ctx;
    const scopes = scopePhrase(lead);
    const hi = `Hi ${ctx.firstName},`;
    const subject = `${scopes.charAt(0).toUpperCase()}${scopes.slice(1)} for ${lead.project.address ?? 'your project'}`;
    const permitContractor = lead.project.permit_contractor ?? ctx.company;
    const footer = `\n\n${signature(ctx.sender)}\n\n${OPT_OUT_LINE}\n`;

    if (step === 1) {
        const also = ctx.otherLeads[0] ? ` We would be glad to look at ${where(ctx.otherLeads[0])} as well.` : '';
        return {
            subject,
            text:
                `${hi}\n\n` +
                `I'm reaching out from ${ctx.sender.company}, a California contractor. Public permit records list ${permitContractor} as the contractor on the ${shortProject(lead)} at ${where(lead)}.\n\n` +
                `We would like to bid the ${scopes} on this project. Could you add us to your bidder list for those packages, or send the bid invitation and plans when they are ready?${also}\n\n` +
                `If someone else at ${ctx.company} handles these bids, I would appreciate a pointer to the right person.` +
                footer,
        };
    }
    if (step === 2) {
        return {
            subject: `Re: ${subject}`,
            text:
                `${hi}\n\n` +
                `Following up on my note about the ${scopes} at ${where(lead)}. If bid packages for that work are going out, we would like to be on the list, and we are happy to review plans and specifications.` +
                footer,
        };
    }
    return {
        subject: `Re: ${subject}`,
        text:
            `${hi}\n\n` +
            `One last note on ${where(lead)}. If that work is already covered, no problem. If there is a better contact for ${scopes} bids, or an upcoming ${ctx.company} project where that work fits, I would be glad to hear about it.` +
            footer,
    };
}

/** First name from a full name ("Sam J. Estimator" → "Sam"). */
export const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;
