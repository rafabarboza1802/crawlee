import { createHash } from 'node:crypto';

import type { Account } from './accounts.js';
import type { EnrichConfig } from './config.js';
import { targetTitles } from './roles.js';
import type { LookupCache } from './store.js';

/** One Apollo request that a paid run would send. Nothing here is executed by the dry run. */
export interface PlannedCall {
    accountId: string;
    step: 1 | 2 | 3;
    provider: 'apollo';
    method: 'POST';
    endpoint: string;
    /** Request body exactly as it would be sent (the API key travels in a header and is never stored). */
    body: Record<string, unknown>;
    cacheKey: string;
    cached: boolean;
    credits: number;
    /** When this call runs. */
    condition: string;
}

export interface AccountPlan {
    account: Account;
    calls: PlannedCall[];
    creditsExpected: number;
    creditsMax: number;
}

export interface Estimate {
    planId: string;
    createdAt: string;
    accounts: number;
    calls: number;
    cachedCalls: number;
    creditsExpected: number;
    creditsMax: number;
    usdExpected: number | null;
    usdMax: number | null;
    monthlyCreditCap: number;
    monthlyBudgetUsd: number;
    withinBudget: boolean;
    assumptions: string[];
}

const APOLLO = 'https://api.apollo.io/api/v1';

/**
 * Plans the Apollo requests for each account. A paid run would execute them in order, stopping per account when a
 * step returns nothing usable, so `creditsExpected` assumes one enriched person and `creditsMax` the configured cap.
 */
export function planAccount(account: Account, config: EnrichConfig, cache: LookupCache): AccountPlan {
    const c = config.apolloCredits;
    const orgKey = `apollo:org-search:${account.accountId}`;
    const peopleKey = `apollo:people-search:${account.accountId}:${account.kind}`;
    const orgCached = cache.has(orgKey);
    const peopleCached = cache.has(peopleKey);

    const calls: PlannedCall[] = [
        {
            accountId: account.accountId,
            step: 1,
            provider: 'apollo',
            method: 'POST',
            endpoint: `${APOLLO}/mixed_companies/search`,
            body: { q_organization_name: account.searchName, organization_locations: ['California, US'], page: 1, per_page: 5 },
            cacheKey: orgKey,
            cached: orgCached,
            credits: orgCached ? 0 : c.organizationSearch,
            condition: `Always. Accept the best match only if name similarity ≥ ${config.minOrgMatch} and the company is in California; otherwise stop for this company (review_needed). Gives website, LinkedIn company page and company phone.`,
        },
        {
            accountId: account.accountId,
            step: 2,
            provider: 'apollo',
            method: 'POST',
            endpoint: `${APOLLO}/mixed_people/api_search`,
            body: { organization_ids: ['<id from step 1>'], person_titles: targetTitles(account.kind), page: 1, per_page: 10 },
            cacheKey: peopleKey,
            cached: peopleCached,
            credits: peopleCached ? 0 : c.peopleSearch,
            condition: `Only if step 1 matched. Returns names, titles and LinkedIn profile URLs (no emails). The top ${config.maxCandidatesPerAccount} by role priority are kept.`,
        },
    ];
    for (let i = 0; i < config.maxEnrichedPerAccount; i++) {
        calls.push({
            accountId: account.accountId,
            step: 3,
            provider: 'apollo',
            method: 'POST',
            endpoint: `${APOLLO}/people/match`,
            body: { id: `<apollo person id #${i + 1} from step 2>`, reveal_personal_emails: false, reveal_phone_number: false },
            cacheKey: `apollo:person:<id #${i + 1}>`,
            cached: false,
            credits: c.peopleMatch,
            condition:
                i === 0
                    ? 'Only for the primary contact (highest role priority, Bay Area first). Business email only; personal emails and phone reveals are off.'
                    : 'Only if the primary contact has no verified business email.',
        });
    }

    const step = (n: number) => calls.filter((x) => x.step === n).reduce((s, x) => s + x.credits, 0);
    const firstMatch = calls.find((x) => x.step === 3)?.credits ?? 0;
    return { account, calls, creditsExpected: step(1) + step(2) + firstMatch, creditsMax: step(1) + step(2) + step(3) };
}

export function estimate(plans: AccountPlan[], config: EnrichConfig, now: Date): Estimate {
    const calls = plans.flatMap((p) => p.calls);
    const creditsExpected = plans.reduce((s, p) => s + p.creditsExpected, 0);
    const creditsMax = plans.reduce((s, p) => s + p.creditsMax, 0);
    const usd = (credits: number) => (config.usdPerCredit === null ? null : Math.round(credits * config.usdPerCredit * 100) / 100);
    const capCredits = config.usdPerCredit === null ? config.monthlyCreditCap : Math.min(config.monthlyCreditCap, Math.floor(config.monthlyBudgetUsd / config.usdPerCredit));
    // The plan id covers exactly what would be sent and what it costs, so an approval cannot be reused for a changed plan.
    const planId = createHash('sha256')
        .update(JSON.stringify({ calls: calls.map(({ endpoint, body, cached, credits }) => ({ endpoint, body, cached, credits })), costs: config.apolloCredits }))
        .digest('hex')
        .slice(0, 12);
    return {
        planId,
        createdAt: now.toISOString(),
        accounts: plans.length,
        calls: calls.length,
        cachedCalls: calls.filter((x) => x.cached).length,
        creditsExpected,
        creditsMax,
        usdExpected: usd(creditsExpected),
        usdMax: usd(creditsMax),
        monthlyCreditCap: capCredits,
        monthlyBudgetUsd: config.monthlyBudgetUsd,
        withinBudget: creditsMax <= capCredits,
        assumptions: [
            `Organization search = ${config.apolloCredits.organizationSearch} credit/call (Apollo lists it as credit-consuming; amount to verify).`,
            `People search (api_search) = ${config.apolloCredits.peopleSearch} credits (Apollo does not list it as credit-consuming; verify).`,
            `People match = ${config.apolloCredits.peopleMatch} credit/person (credit-consuming; amount to verify).`,
            'Phone reveals and personal emails are disabled; business phone comes from the organization record.',
            config.usdPerCredit === null ? 'USD not shown: set usdPerCredit in enrich.config.json.' : `USD at $${config.usdPerCredit}/credit.`,
            'Spending is capped by the local ledger (output/enrich-ledger.json); keep automatic credit purchases off in Apollo.',
        ],
    };
}
