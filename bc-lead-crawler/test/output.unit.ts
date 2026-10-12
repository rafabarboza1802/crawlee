import { describe, expect, test } from 'vitest';

import { toCsv } from '../src/output.js';
import type { Prospect } from '../src/schema.js';

const prospect: Prospect = {
    schema_version: 1,
    prospect_id: 'evil.example',
    website: 'https://evil.example',
    company_name: '=HYPERLINK("https://evil.example","click")',
    company_name_source: 'title',
    segment_hint: 'unknown',
    segment_group: 'unclassified',
    seed_source: 'test',
    phones: [{ value: '+15105550100', source_url: 'https://evil.example/' }],
    business_emails: [],
    contact_page_urls: [],
    service_area_mentions: [],
    public_roles: [],
    social_profiles: [],
    bid_portal_links: [],
    signals: [],
    crawl_status: 'ok',
    pages: [],
    skipped: [],
    crawled_at: new Date(0).toISOString(),
};

describe('toCsv', () => {
    test('neutralizes spreadsheet formulas in scraped values', () => {
        const [, row] = toCsv([prospect]).split('\n');
        expect(row).toContain(`"'=HYPERLINK(""https://evil.example"",""click"")"`);
        expect(row).toContain(`'+15105550100`);
    });
});
