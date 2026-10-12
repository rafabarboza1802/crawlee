import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { extractPage, isGenericBusinessEmail, looksLikeChallenge, normalizePhone } from '../src/extract.js';

const URL_ = 'https://bayview.example/';
const html = readFileSync(new URL('./fixtures/property-manager.html', import.meta.url), 'utf8');
const findings = extractPage(html, URL_);
const values = (items: { value: string }[]) => items.map((i) => i.value);

describe('extractPage', () => {
    test('prefers the JSON-LD organization name over WebSite/og/title', () => {
        expect(findings.companyName).toEqual({ value: 'Bayview Residential Management, Inc.', source: 'json_ld' });
    });

    test('collects phones from JSON-LD, tel: links and visible text, normalized to E.164', () => {
        expect(values(findings.phones).sort()).toEqual(['+15105550142', '+19255550110']);
    });

    test('ignores phones and emails that only appear inside <script>', () => {
        expect(values(findings.phones)).not.toContain('+14155550199');
        expect(values(findings.businessEmails)).not.toContain('sales@tracking.example');
    });

    test('keeps generic business mailboxes and drops personal addresses', () => {
        expect(values(findings.businessEmails).sort()).toEqual(['info@bayview.example', 'office@bayview.example']);
    });

    test('every fact carries its source URL', () => {
        for (const e of [...findings.phones, ...findings.businessEmails, ...findings.signals]) {
            expect(e.source_url).toBe(URL_);
        }
    });

    test('reads the postal address from JSON-LD', () => {
        expect(findings.address).toMatchObject({ city: 'Oakland', region: 'CA', postal_code: '94607' });
    });

    test('finds contact pages, service area, public role titles and company social profiles', () => {
        expect(findings.contactPageUrls).toEqual(['https://bayview.example/contact-us']);
        expect(values(findings.serviceAreaMentions)).toEqual(expect.arrayContaining(['East Bay', 'Oakland', 'Walnut Creek', 'San Ramon']));
        expect(values(findings.publicRoles)).toContain('Regional Property Manager');
        expect(values(findings.socialProfiles)).toEqual(['https://www.linkedin.com/company/bayview-example']);
    });

    test('detects construction-need signals with a verifiable snippet', () => {
        const keys = findings.signals.map((s) => `${s.category}:${s.keyword}`);
        expect(keys).toEqual(
            expect.arrayContaining(['hardscape:pavers', 'hardscape:pool deck', 'paving:parking lot', 'remodel:capital improvement', 'portfolio:HOAs', 'portfolio:2,400 units']),
        );
        const pavers = findings.signals.find((s) => s.keyword === 'pavers')!;
        expect(pavers.snippet).toContain('new pavers in common areas');
    });
});

describe('helpers', () => {
    test('normalizePhone', () => {
        expect(normalizePhone('+1 (510) 555-0142')).toBe('+15105550142');
        expect(normalizePhone('555-0142')).toBeUndefined();
        expect(normalizePhone('(110) 555-0142')).toBeUndefined();
    });

    test('isGenericBusinessEmail', () => {
        expect(isGenericBusinessEmail('info@acme.com')).toBe(true);
        expect(isGenericBusinessEmail('front.desk@acme.com')).toBe(true);
        expect(isGenericBusinessEmail('john.smith@acme.com')).toBe(false);
    });

    test('looksLikeChallenge', () => {
        expect(looksLikeChallenge('<title>Just a moment...</title>')).toBe(true);
        expect(looksLikeChallenge('<div class="g-recaptcha"></div>')).toBe(true);
        expect(looksLikeChallenge('<title>Acme</title>')).toBe(false);
    });
});
