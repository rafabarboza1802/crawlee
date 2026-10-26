import type { NormalizedPermit, Service } from './types.js';

export interface ServiceMatch {
    service: Service;
    evidence: string[];
}

/** Keyword patterns per service, matched against the permit description and permit type. */
const SERVICE_PATTERNS: Record<Service, RegExp[]> = {
    demolition: [/\bdemo(?:lition|lish(?:ed|ing)?)?\b/i, /\btear[\s-]?down\b/i, /\braze\b/i],
    // Derived from `demolition` when the scope is an interior strip-out (see INTERIOR_ONLY below).
    interior_demolition: [],
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
    pavers_hardscape: [/\bpavers?\b/i, /\bhardscap\w*/i, /\bpatio\b/i, /\bwalkways?\b/i, /\bpathways?\b/i, /\bcourtyard\b/i, /\blandscap\w*/i, /\b(?:concrete|masonry|stone|brick|paver) (?:stairs|steps)\b/i],
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

/**
 * Demolition of a building, structure or site element. Any other "demo" (partitions, drywall, ductwork, bathrooms,
 * tenant fit-outs) is an interior strip-out and is reported as `interior_demolition`.
 */
const BUILDING_DEMOLITION =
    /\b(?:demo\w*|tear[\s-]?down|raze)\b[^.;]{0,40}?\b(?:buildings?|structures?|house|dwelling|garage|shed|carport|deck|patio|driveway|fence|retaining walls?|pool|foundations?|slab|cottage|residence|\d[\s-]?stor(?:y|ey)|stor(?:y|ey))\b/i;

/** "enclose/infill patio" is interior space, not hardscape. */
const ENCLOSED_PATIO = /\b(?:enclos\w*|infill|convert\w*)\b[^.;]{0,25}\bpatio\b/i;

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

    // Interior strip-outs are a smaller, different job from demolishing a building or site element.
    if (found.has('demolition') && !/demolition/.test(type) && !BUILDING_DEMOLITION.test(text)) {
        found.set('interior_demolition', found.get('demolition')!);
        found.delete('demolition');
    }
    if (found.get('pavers_hardscape')?.size === 1 && found.get('pavers_hardscape')!.has('patio') && ENCLOSED_PATIO.test(text)) {
        found.delete('pavers_hardscape');
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
/** Best Construction's core site scopes (owner, 2026-10-26) earn the most; interior, ADU and remodel work the least. */
export const SERVICE_POINTS: Record<Service, number> = {
    demolition: 35,
    excavation: 35,
    grading: 35,
    site_work: 35,
    pavers_hardscape: 34,
    paving: 34,
    concrete: 33,
    land_clearing: 33,
    retaining_walls: 32,
    drainage: 32,
    hauling_debris: 28,
    general_construction: 22,
    interior_demolition: 15,
    adu: 12,
    remodel: 10,
};

/** Core site scopes: each extra one on the same project adds to the fit score. */
export const CORE_SCOPES: Service[] = ['demolition', 'excavation', 'grading', 'site_work', 'pavers_hardscape', 'paving', 'concrete', 'land_clearing', 'retaining_walls', 'drainage', 'hauling_debris'];

export const SERVICE_LABELS: Record<Service, string> = {
    demolition: 'demolition',
    interior_demolition: 'interior demolition',
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
