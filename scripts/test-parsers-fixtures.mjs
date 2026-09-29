// scripts/test-parsers-fixtures.mjs
//
// Offline checks: run the new Scrapfly parsers against the minimal synthetic
// fixtures in test/fixtures/. No network, no DB writes.
//   node scripts/test-parsers-fixtures.mjs

import { readFile } from 'node:fs/promises';
import {
    parseIsbnSearchSearchPage,
    parseIsbnSearchIsbnPage,
} from '../src/services/isbnSearchScrapflyClient.js';

let failures = 0;

function check(label, condition, detail) {
    if (condition) {
        console.log(`  OK  ${label}`);
    } else {
        failures += 1;
        console.error(`FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
    }
}

// ---------- ISBNSearch title search page ----------
{
    const html = await readFile('test/fixtures/isbnsearch-title.html', 'utf8');
    const candidates = parseIsbnSearchSearchPage(html);

    console.log(`\nISBNSearch search page: ${candidates.length} candidates`);
    console.log(JSON.stringify(candidates.slice(0, 3), null, 2));

    check('search: parses multiple candidates', candidates.length >= 3, `got ${candidates.length}`);

    const first = candidates[0] || {};
    check('search: first candidate isbn13', first.isbn13 === '9782092553343', first.isbn13);
    check('search: first candidate isbn10', first.isbn10 === '2092553348', first.isbn10);
    check(
        'search: first candidate title',
        /grande encyclop/i.test(first.title || ''),
        first.title
    );
    check('search: first candidate author', /collectif/i.test(first.authors || ''), first.authors);
    check(
        'search: image url absolute',
        (first.imageUrl || '').startsWith('http'),
        first.imageUrl
    );
    check(
        'search: result url absolute',
        (first.resultUrl || '') === 'https://isbnsearch.org/isbn/9782092553343',
        first.resultUrl
    );
}

// ---------- ISBNSearch /isbn/{isbn} page ----------
{
    const html = await readFile('test/fixtures/isbnsearch-isbn.html', 'utf8');
    const candidate = parseIsbnSearchIsbnPage(html, '9782092553343');

    console.log('\nISBNSearch isbn page candidate:');
    console.log(JSON.stringify(candidate, null, 2));

    check('isbn: candidate parsed', Boolean(candidate));
    check('isbn: isbn13', candidate?.isbn13 === '9782092553343', candidate?.isbn13);
    check('isbn: title', /grande encyclop/i.test(candidate?.title || ''), candidate?.title);
    check('isbn: author', /benton/i.test(candidate?.authors || ''), candidate?.authors);
    check('isbn: publisher', /nathan/i.test(candidate?.publisher || ''), candidate?.publisher);
    check('isbn: published date', /2011/.test(candidate?.publishedDate || ''), candidate?.publishedDate);
}

// ---------- Momox batch scenario result extraction ----------
{
    const raw = JSON.parse(
        await readFile('test/fixtures/momox-batch-fetch-3-fixed.json', 'utf8')
    );

    // Same logic as momoxScrapflyBatchService.extractScenarioReturnValue
    // (not exported; re-validate the path shape here).
    const steps = raw?.result?.browser_data?.js_scenario?.steps;
    const executeStep = Array.isArray(steps)
        ? steps.find((step) => step?.action === 'execute' && step?.result)
        : null;

    const scenarioResult = executeStep?.result || null;
    const entries = Array.isArray(scenarioResult?.results) ? scenarioResult.results : [];

    console.log(`\nMomox scenario entries: ${entries.length}`);

    check('momox: scenario result found', Boolean(scenarioResult));
    check('momox: 3 entries', entries.length === 3, `got ${entries.length}`);

    const byCode = new Map(entries.map((entry) => [entry.code, entry]));

    const offer = byCode.get('9782824625256');
    check('momox: offer entry ok', offer?.ok === true && offer?.data?.status === 'offer');
    check('momox: offer price', offer?.data?.price === '4.50', offer?.data?.price);
    check('momox: offer title', offer?.data?.product?.title === "L'intruse", offer?.data?.product?.title);
    check(
        'momox: offer full-size image priority',
        (offer?.data?.product?.full_size_image_url || '').includes('momox.de'),
        offer?.data?.product?.full_size_image_url
    );

    const noOffer = byCode.get('9782070368228');
    check('momox: no_offer status', noOffer?.data?.status === 'no_offer', noOffer?.data?.status);
    check(
        'momox: no_offer still has title (1984)',
        noOffer?.data?.product?.title === '1984',
        noOffer?.data?.product?.title
    );
    check(
        'momox: no_offer still has image',
        Boolean(noOffer?.data?.product?.image_url),
        noOffer?.data?.product?.image_url
    );

    const cheapOffer = byCode.get('9782092553343');
    check('momox: low offer price 0.75', cheapOffer?.data?.price === '0.75', cheapOffer?.data?.price);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL FIXTURE CHECKS PASSED');
process.exit(failures ? 1 : 0);
