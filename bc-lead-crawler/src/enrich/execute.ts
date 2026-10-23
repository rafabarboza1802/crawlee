import type { Account } from './accounts.js';
import type { ApolloClient, ApolloOrg, ApolloPerson } from './apollo.js';
import { ApolloAuthError, isVerifiedBusinessEmail, nameSimilarity, parseMatchedPerson, parseOrganizations, parsePeople } from './apollo.js';
import type { EnrichConfig } from './config.js';
import type { AccountPlan } from './plan.js';
import { roleTargets, targetTitles } from './roles.js';
import type { FileCache, Ledger } from './store.js';

export interface RankedPerson extends ApolloPerson {
    roleCategory: string;
    rank: number;
}

export interface AccountResult {
    accountId: string;
    status: 'enriched' | 'no_verified_email' | 'no_people' | 'no_org_match' | 'stopped_budget' | 'stopped_auth' | 'error';
    note?: string;
    org?: ApolloOrg & { matchScore: number };
    primary?: RankedPerson;
    backups: RankedPerson[];
    creditsSpent: number;
}

export interface ExecuteOptions {
    planId: string;
    /** Credits approved for this run (the estimate's maximum). Never exceeded. */
    approvedCredits: number;
    monthlyCreditCap: number;
    now: Date;
    log: (message: string) => void;
}

/** Ranks people by the owner's role priority for this kind of company; Bay Area/California first within a role. */
export function rankPeople(people: ApolloPerson[], account: Account, max: number): RankedPerson[] {
    const targets = roleTargets(account.kind);
    const ranked: RankedPerson[] = [];
    for (const p of people) {
        const title = (p.title ?? '').toLowerCase();
        const idx = targets.findIndex((t) => t.titles.some((x) => title.includes(x.toLowerCase())));
        if (idx < 0) continue;
        const local = /\b(?:ca|california)\b/i.test(p.state ?? '') ? 0.5 : 0;
        ranked.push({ ...p, roleCategory: targets[idx]!.category, rank: idx - local });
    }
    return ranked.sort((a, b) => a.rank - b.rank).slice(0, max);
}

const inCalifornia = (org: ApolloOrg) => !org.state || /\b(?:ca|california)\b/i.test(org.state);

/**
 * Runs the approved plan: organization search → people search → business-email match for the primary contact.
 * Stops for a company as soon as a step gives nothing usable, and stops the whole run before any call that would
 * exceed the approved credits or the monthly cap.
 */
export async function executePlans(
    plans: AccountPlan[],
    config: EnrichConfig,
    client: ApolloClient,
    cache: FileCache,
    ledger: Ledger,
    options: ExecuteOptions,
): Promise<AccountResult[]> {
    const results: AccountResult[] = [];
    let spent = 0;
    let stopped: false | 'budget' | 'auth' = false;

    const paidCall = async (account: Account, path: string, credits: number, body: Record<string, unknown>) => {
        if (spent + credits > options.approvedCredits || ledger.creditsThisMonth(options.now) + credits > options.monthlyCreditCap) {
            stopped = 'budget';
            return undefined;
        }
        const res = await client.post(path, body);
        spent += credits;
        await ledger.record({ at: new Date().toISOString(), plan_id: options.planId, account_id: account.accountId, endpoint: path, credits, status: res.status });
        return res.json;
    };

    // Defense in depth: nothing but a gate-approved buyer can ever reach Apollo.
    const notBuyer = plans.find((p) => p.account.buyer?.classification !== 'buyer');
    if (notBuyer) throw new Error(`Refusing to run: ${notBuyer.account.displayName} is not classified as a buyer.`);

    for (const { account } of plans) {
        if (stopped) {
            results.push({
                accountId: account.accountId,
                status: stopped === 'auth' ? 'stopped_auth' : 'stopped_budget',
                backups: [],
                creditsSpent: 0,
                note: stopped === 'auth' ? 'Run stopped: Apollo refused the API key' : 'Budget limit reached before this company',
            });
            continue;
        }
        const before = spent;
        const result: AccountResult = { accountId: account.accountId, status: 'error', backups: [], creditsSpent: 0 };
        try {
            // 1. Organization.
            const orgKey = `apollo:org-search:${account.accountId}`;
            let orgs = cache.get<ApolloOrg[]>(orgKey);
            if (!orgs) {
                const json = await paidCall(account, 'mixed_companies/search', config.apolloCredits.organizationSearch, {
                    q_organization_name: account.searchName,
                    organization_locations: ['California, US'],
                    page: 1,
                    per_page: 5,
                });
                if (!json) {
                    results.push({ ...result, status: 'stopped_budget', note: 'Budget limit reached' });
                    continue;
                }
                orgs = parseOrganizations(json);
                await cache.set(orgKey, orgs, options.now);
            }
            const best = orgs
                .filter(inCalifornia)
                .map((o) => ({ ...o, matchScore: Math.round(nameSimilarity(account.searchName, o.name) * 100) / 100 }))
                .sort((a, b) => b.matchScore - a.matchScore)[0];
            if (!best || best.matchScore < config.minOrgMatch) {
                results.push({ ...result, status: 'no_org_match', creditsSpent: spent - before, note: best ? `Best Apollo match "${best.name}" scored ${best.matchScore}` : 'No California company found' });
                continue;
            }
            result.org = best;

            // 2. People (free per Apollo's pricing page; still cached).
            const peopleKey = `apollo:people-search:${account.accountId}:${account.kind}`;
            let people = cache.get<ApolloPerson[]>(peopleKey);
            if (!people) {
                const json = await paidCall(account, 'mixed_people/api_search', config.apolloCredits.peopleSearch, {
                    organization_ids: [best.id],
                    person_titles: targetTitles(account.kind),
                    page: 1,
                    per_page: 10,
                });
                if (!json) {
                    results.push({ ...result, status: 'stopped_budget', creditsSpent: spent - before, note: 'Budget limit reached' });
                    continue;
                }
                people = parsePeople(json);
                await cache.set(peopleKey, people, options.now);
            }
            const ranked = rankPeople(people, account, config.maxCandidatesPerAccount);
            if (!ranked.length) {
                results.push({ ...result, status: 'no_people', creditsSpent: spent - before, note: 'No one with a priority title found' });
                continue;
            }

            // 3. Business email for the primary contact (then backups, up to the configured number).
            let enriched: RankedPerson | undefined;
            for (const candidate of ranked.slice(0, config.maxEnrichedPerAccount)) {
                const personKey = `apollo:person:${candidate.id}`;
                let person = cache.get<ApolloPerson | null>(personKey);
                if (person === undefined) {
                    const json = await paidCall(account, 'people/match', config.apolloCredits.peopleMatch, {
                        id: candidate.id,
                        reveal_personal_emails: false,
                        reveal_phone_number: false,
                    });
                    if (!json) break;
                    person = parseMatchedPerson(json) ?? null;
                    await cache.set(personKey, person, options.now);
                }
                const merged: RankedPerson = { ...candidate, ...(person ?? {}), roleCategory: candidate.roleCategory, rank: candidate.rank };
                if (!isVerifiedBusinessEmail(merged)) merged.email = undefined;
                if (merged.email) {
                    enriched = merged;
                    break;
                }
            }
            result.primary = enriched ?? ranked[0];
            result.backups = ranked.filter((p) => p.id !== result.primary!.id).map(({ email: _email, ...rest }) => rest);
            result.status = enriched ? 'enriched' : stopped ? 'stopped_budget' : 'no_verified_email';
            result.creditsSpent = spent - before;
            results.push(result);
        } catch (error) {
            results.push({ ...result, creditsSpent: spent - before, note: (error as Error).message });
            if (error instanceof ApolloAuthError) {
                stopped = 'auth';
                options.log((error as Error).message);
            }
        }
    }
    return results;
}
