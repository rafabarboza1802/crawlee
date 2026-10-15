import type { NormalizedPermit, Service } from './types.js';

export interface ServiceMatch {
    service: Service;
    evidence: string[];
}

/** Keyword patterns per service, matched against the permit description and permit type. */
const SERVICE_PATTERNS: Record<Service, RegExp[]> = {
    demolition: [/\bdemo(?:lition|lish(?:ed|ing)?)?\b/i, /\btear[\s-]?down\b/i, /\braze\b/i],
    excavation: [
        /\bexcavat\w*/i,
        /\bshoring\b/i,
        /\bunderpinning\b/i,
        /\b(?:new|lower(?:ed|ing)?|expand(?:ed|ing)?|deepen(?:ed|ing)?) basement\b/i,
        /\bbasement (?:addition|expansion|excavation)\b/i,
        /\bdig(?:ging)?\b/i,
    ],
    grading: [/\bgrading\b/i, /\bre-?grad(?:e|ing)\b/i, /\bfill\b(?! (?:in|out))/i, /\bquarry\b/i],
    concrete: [/\bconcrete\b/i, /\bfoundation\w*/i, /\bslab\b/i, /\bfootings?\b/i, /\bgrade beams?\b/i],
    pavers_hardscape: [/\bpavers?\b/i, /\bhardscap\w*/i, /\bpatio\b/i, /\bwalkways?\b/i, /\bpathways?\b/i, /\bcourtyard\b/i, /\blandscap\w*/i, /\bexterior stairs?\b/i],
    paving: [/\bdriveways?\b/i, /\bparking (?:lot|area|pad|stalls?)\b/i, /\basphalt\b/i, /\bpaving\b/i, /\bcurb cut\b/i, /\bsidewalks?\b/i],
    drainage: [/\bdrainage\b/i, /\bstorm ?water\b/i, /\bfrench drains?\b/i, /\bsump pumps?\b/i, /\bcatch basins?\b/i, /\bbio-?retention\b/i, /\bpermeable\b/i],
    retaining_walls: [/\bretaining[\s-]walls?\b/i],
    site_work: [/\bsite ?work\b/i, /\bsite improvements?\b/i, /\bsewer lateral\b/i, /\btrench\w*/i, /\bunderground utilit\w*/i, /\butility connections?\b/i],
    land_clearing: [/\bclear(?:ing)? (?:the )?(?:lot|site|land|vegetation)\b/i, /\btree removal\b/i, /\bremove (?:\w+ )?trees?\b/i, /\bbrush clearing\b/i],
    hauling_debris: [/\bdebris\b/i, /\bhaul(?:ing|-off)?\b/i, /\bsoil (?:export|removal|off-?haul)\b/i, /\boff-?haul\b/i],
    remodel: [/\bremodel\w*/i, /\brenovat\w*/i, /\btenant improvements?\b/i, /\bkitchen\b/i, /\bbath(?:room)?s?\b/i, /\balteration\w*/i, /\bseismic (?:retrofit|upgrade)\b/i],
    adu: [/\badus?\b/i, /\baccessory dwelling\b/i, /\bin-?law (?:unit|apartment)\b/i, /\bj-?adu\b/i, /\bsecondary (?:dwelling )?unit\b/i, /\bgarage conversion\b/i],
    general_construction: [/\bnew (?:\d+[\s-])?(?:story|storey)\b/i, /\bnew (?:building|construction|structure|single[\s-]family|dwelling|residence|home)\b/i, /\berect\b/i, /\b(?:horizontal|vertical|rear|side) addition\b/i, /\baddition\b/i],
};

/**
 * Work that is not Best Construction's. When the only matches are weak (remodel/general) and the description
 * is about one of these trades, the permit is dropped.
 */
const NOT_OUR_WORK = [
    /\bre-?roof\w*/i,
    /\bsolar\b/i,
    /\bphotovoltaic\b/i,
    /\bpv (?:system|panels?)\b/i,
    /\bfire (?:sprinklers?|alarms?)\b/i,
    /\bsprinklers?\b/i,
    /\bsigns?\b|\bsignage\b/i,
    /\bantennas?\b|\bwireless\b|\btelecom\w*/i,
    /\belevators?\b/i,
    /\bwindows?\b/i,
    /\bawnings?\b/i,
    /\bpaint(?:ing)?\b/i,
    /\belectrical\b|\bplumbing\b|\bhvac\b|\bmechanical\b/i,
];

/** Services that, when matched, mean the permit is a strong fit regardless of trade noise. */
const STRONG: ReadonlySet<Service> = new Set([
    'demolition',
    'excavation',
    'grading',
    'concrete',
    'pavers_hardscape',
    'paving',
    'drainage',
    'retaining_walls',
    'site_work',
    'land_clearing',
    'adu',
]);

export interface ServiceAnalysis {
    services: ServiceMatch[];
    /** Set when the permit is not relevant to Best Construction. */
    excludedReason?: string;
}

export function matchServices(permit: Pick<NormalizedPermit, 'description' | 'permitType' | 'softStoryRetrofit'>): ServiceAnalysis {
    const text = permit.description;
    const type = (permit.permitType ?? '').toLowerCase();
    const found = new Map<Service, Set<string>>();
    const add = (service: Service, evidence: string) => {
        if (!found.has(service)) found.set(service, new Set());
        found.get(service)!.add(evidence);
    };

    for (const [service, patterns] of Object.entries(SERVICE_PATTERNS) as [Service, RegExp[]][]) {
        for (const re of patterns) {
            const m = re.exec(text);
            if (m) add(service, m[0].toLowerCase());
        }
    }

    // Permit-type rules (names as used by DataSF; other jurisdictions map their types onto these words).
    if (/demolition/.test(type)) add('demolition', `permit type: ${permit.permitType}`);
    if (/grade|excavat|quarry|fill/.test(type)) {
        add('grading', `permit type: ${permit.permitType}`);
        add('excavation', `permit type: ${permit.permitType}`);
    }
    if (/new construction/.test(type)) add('general_construction', `permit type: ${permit.permitType}`);
    if (/^(?:sign|wall or painted sign)/.test(type)) return { services: [], excludedReason: `sign permit (${permit.permitType})` };
    if (permit.softStoryRetrofit || /\bsoft[\s-]?stor(?:y|ey)\b/i.test(text)) {
        add('concrete', 'soft-story retrofit (new foundations)');
        add('excavation', 'soft-story retrofit (new foundations)');
    }

    // Implied work.
    if (found.has('demolition')) add('hauling_debris', 'implied by demolition');
    if (found.has('general_construction') && /new construction/.test(type)) add('site_work', 'implied by new construction');

    const services = [...found].map(([service, evidence]) => ({ service, evidence: [...evidence] }));
    const hasStrong = services.some((s) => STRONG.has(s.service));

    if (services.length === 0) return { services, excludedReason: 'no Best Construction service mentioned' };
    if (!hasStrong) {
        // Keep real remodel/build work ("kitchen remodel; replace windows"); drop generic "alterations" that are
        // really another trade ("alterations: replace windows").
        const specific = services.some((s) => s.evidence.some((e) => !/^alteration|^permit type|^implied/.test(e)));
        const trade = NOT_OUR_WORK.map((re) => re.exec(text)?.[0]).find(Boolean);
        if (trade && !specific) return { services: [], excludedReason: `other trade (${trade.toLowerCase()})` };
    }
    return { services };
}

/** Score tier of each service (points for the service-fit factor). */
export const SERVICE_POINTS: Record<Service, number> = {
    demolition: 35,
    excavation: 35,
    grading: 35,
    retaining_walls: 35,
    site_work: 33,
    drainage: 33,
    land_clearing: 33,
    pavers_hardscape: 32,
    paving: 32,
    concrete: 30,
    adu: 28,
    general_construction: 22,
    remodel: 15,
    hauling_debris: 10,
};

export const SERVICE_LABELS: Record<Service, string> = {
    demolition: 'demolition',
    excavation: 'excavation',
    grading: 'grading',
    concrete: 'concrete',
    pavers_hardscape: 'pavers/hardscape',
    paving: 'paving/driveways',
    drainage: 'drainage',
    retaining_walls: 'retaining walls',
    site_work: 'site work',
    land_clearing: 'land clearing',
    hauling_debris: 'hauling/debris removal',
    remodel: 'remodel',
    adu: 'ADU',
    general_construction: 'general construction',
};
