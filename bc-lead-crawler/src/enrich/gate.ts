import type { Account } from './accounts.js';
import { accountIdFor, searchNameFor } from './accounts.js';
import type { BuyerDecision, BuyerRegistry } from './buyers.js';
import { classifyFromHistory, classifyFromRegistry, competitorRiskSignal } from './buyers.js';
import type { PermitHistory } from './research.js';
import type { FileCache } from './store.js';

export interface GateResult {
    buyers: Account[];
    blocked: Account[];
    /** Not enriched: owner decision (e.g. a JV partner that is not the bidding contact) or a small, non-target contractor. */
    excluded: Account[];
    review: Account[];
}

export type HistoryLookup = (license: string) => Promise<PermitHistory>;

/**
 * Classifies every company before enrichment. Buyers continue (renamed to the canonical company, or to a joint
 * venture's managing GC); competitors are blocked; everything else stops for manual review. Never uses Apollo.
 */
export async function applyBuyerGate(
    accounts: Account[],
    registry: BuyerRegistry,
    lookupHistory: HistoryLookup,
    cache: FileCache,
    now: Date,
): Promise<GateResult> {
    const buyers = new Map<string, Account>();
    const blocked: Account[] = [];
    const excluded: Account[] = [];
    const review: Account[] = [];

    for (const account of accounts) {
        let decision: BuyerDecision | undefined = classifyFromRegistry(registry, account.displayName, account.license);
        if (!decision) {
            const riskSignal = competitorRiskSignal(registry, account.displayName);
            if (!account.license) {
                decision = {
                    classification: 'uncertain',
                    reason: `Unknown company with no licence number to research: manual review.${riskSignal ? ` Competitor-risk word in name ("${riskSignal}").` : ''}`,
                    evidence: [],
                    source: 'permit_research',
                    ...(riskSignal ? { riskSignal } : {}),
                };
            } else {
                const key = `research:sf-permits:${account.license}`;
                let history = cache.get<PermitHistory>(key);
                if (!history) {
                    try {
                        history = await lookupHistory(account.license);
                        await cache.set(key, history, now);
                    } catch {
                        history = undefined;
                    }
                }
                const projectValue = Math.max(0, ...account.opportunities.map((o) => o.estimated_value ?? 0));
                decision = classifyFromHistory(account.displayName, history, riskSignal, projectValue);
            }
        }

        if (decision.classification !== 'buyer') {
            const bucket = { competitor: blocked, do_not_enrich: excluded, not_target: excluded, uncertain: review }[decision.classification];
            bucket.push({ ...account, buyer: decision });
            continue;
        }

        // Buyer: enrich the canonical company (for a JV, the managing GC), merging permits that resolve to it.
        const name = decision.resolvedName ?? account.displayName;
        const accountId = accountIdFor(name);
        const existing = buyers.get(accountId);
        if (existing) {
            existing.opportunities.push(...account.opportunities);
            existing.bestScore = Math.max(existing.bestScore, account.bestScore);
            continue;
        }
        buyers.set(accountId, {
            ...account,
            accountId,
            displayName: decision.jointVenture ? `${name} (managing GC of ${decision.jointVenture})` : name,
            searchName: searchNameFor(name),
            // A JV's licence belongs to the JV, not to the managing GC.
            license: decision.jointVenture ? undefined : account.license,
            buyer: decision,
        });
    }
    return { buyers: [...buyers.values()], blocked, excluded, review };
}
