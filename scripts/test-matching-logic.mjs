// scripts/test-matching-logic.mjs
//
// Offline checks for the exact-title / short-title matching rules and the
// title raw-text fallback. No network, no DB writes (OPENAI key must exist in
// .env because the extraction module initializes its client on import).
//   node scripts/test-matching-logic.mjs

import { readFile } from 'node:fs/promises';
import {
    extractTitleFromRawText,
    parseIsbnSearchSearchPage,
} from '../src/services/isbnSearchScrapflyClient.js';
import {
    formatApifyIsbnSearchCandidate,
    applyGenericTitleStrictness,
} from '../src/services/extractBooksWithOpenAI.js';

let failures = 0;

function check(label, condition, detail) {
    if (condition) {
        console.log(`  OK  ${label}`);
    } else {
        failures += 1;
        console.error(`FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
    }
}

// The candidate formatter rejects checksum-invalid ISBNs, so test ISBNs must
// be real ISBN-13s: take 12 digits, append the computed check digit.
function validIsbn13(prefix12) {
    const digits = String(prefix12).replace(/\D/g, '').slice(0, 12);
    let sum = 0;

    for (let index = 0; index < 12; index += 1) {
        sum += Number(digits[index]) * (index % 2 === 0 ? 1 : 3);
    }

    return digits + String((10 - (sum % 10)) % 10);
}

// ---------- extractTitleFromRawText (patch 2) ----------
{
    check(
        'raw text: title before Author',
        extractTitleFromRawText('La grande encyclopédie des enfants Author: Collectif ISBN-13: 9782092553343') ===
            'La grande encyclopédie des enfants'
    );
    check(
        'raw text: title before ISBN-13 (no author)',
        extractTitleFromRawText('GRANDE ENCYCLOPEDIE ENFANTS ISBN-13: 9782092403259 ISBN-10: 2092403257') ===
            'GRANDE ENCYCLOPEDIE ENFANTS'
    );
    check(
        'raw text: Authors plural',
        extractTitleFromRawText('Châteaux et chevaliers Authors: Collectif; Someone ISBN-13: 9782753004382') ===
            'Châteaux et chevaliers'
    );
    check('raw text: empty input', extractTitleFromRawText('') === '');
}

// ---------- title fallback inside the search parser (patch 2) ----------
{
    // Simulated batch fragment where the /isbn/ link has NO text.
    const fragment = `
    <ul id="searchresults">
      <li>
        <div class="image"><a href="/isbn/9782753004382"><img src="/img/x.jpg" alt=""></a></div>
        <div class="bookinfo">
          <h2><a href="/isbn/9782753004382"></a></h2>
          Châteaux et chevaliers
          <p>Author: Collectif</p>
          <p>ISBN-13: 9782753004382</p>
          <p>ISBN-10: 2753004382</p>
        </div>
      </li>
    </ul>`;

    const candidates = parseIsbnSearchSearchPage(fragment);

    check('fragment: candidate parsed', candidates.length === 1, candidates.length);
    check(
        'fragment: title from raw text when link text empty',
        candidates[0]?.title === 'Châteaux et chevaliers',
        candidates[0]?.title
    );
    check('fragment: accents preserved (UTF-8)', /Châteaux/.test(candidates[0]?.title || ''));
}

// ---------- exact / article-insensitive flags (patch 3 + 4) ----------
{
    const queryContext = {
        title: 'Châteaux et chevaliers',
        author: null,
        rawVisibleText: null,
        possibleCorrectedTitle: null,
        query: 'Châteaux et chevaliers',
    };

    const editions = [
        { isbn13: validIsbn13('978209255307'), title: 'Chateaux et chevaliers' },
        { isbn13: validIsbn13('978275300438'), title: 'Châteaux et chevaliers' },
        { isbn13: validIsbn13('978209249547'), title: 'Châteaux et chevaliers' },
        { isbn13: validIsbn13('978275307316'), title: 'Châteaux et chevaliers' },
        { isbn13: validIsbn13('978209250965'), title: 'CHATEAUX ET CHEVALIERS' },
        { isbn13: validIsbn13('978221512345'), title: 'Le grand livre des châteaux et chevaliers' },
    ];

    const formatted = editions.map((edition) =>
        formatApifyIsbnSearchCandidate(
            { ...edition, isbn: edition.isbn13, authors: null, imageUrl: null, resultUrl: null, source: 'isbnsearch_scrapfly' },
            queryContext
        )
    );

    const exactCount = formatted.filter((candidate) => candidate.exactTitleMatch).length;

    check('all 5 edition variants flagged exact (caps + accent-free included)', exactCount === 5, exactCount);
    check(
        'loose "Le grand livre des..." NOT exact',
        formatted[5].exactTitleMatch === false && formatted[5].articleInsensitiveTitleMatch === false,
        { exact: formatted[5].exactTitleMatch, article: formatted[5].articleInsensitiveTitleMatch }
    );
    check('exact editions score >= 0.8', formatted.slice(0, 5).every((candidate) => candidate.score >= 0.8));
}

// ---------- short-title strictness (patch 4) ----------
{
    const makeCandidates = (titles) =>
        titles.map((title, index) =>
            formatApifyIsbnSearchCandidate(
                { isbn13: validIsbn13(`97820925530${index}`), isbn: null, title, authors: null, imageUrl: null, resultUrl: null, source: 'isbnsearch_scrapfly' },
                { title: 'Chevaux', author: null, rawVisibleText: null, possibleCorrectedTitle: null, query: 'Chevaux' }
            )
        ).filter(Boolean);

    const book = { title: 'Chevaux', possible_corrected_title: null, raw_visible_text: null };

    const candidates = makeCandidates([
        'Chevaux',                 // exact
        'Les chevaux',             // article-insensitive
        'Chevaux et poneys',       // loose -> reject
        'Le grand livre des chevaux', // loose -> reject
    ]);

    const strict = applyGenericTitleStrictness(book, candidates);

    check('short title: 2 of 4 kept', strict.length === 2, strict.map((candidate) => candidate.googleTitle));
    check('short title: exact kept first', strict[0]?.googleTitle === 'Chevaux', strict[0]?.googleTitle);

    const exact = strict.find((candidate) => candidate.googleTitle === 'Chevaux');
    const article = strict.find((candidate) => candidate.googleTitle === 'Les chevaux');

    check('short title: article-insensitive kept', Boolean(article));
    check(
        'short title: article-insensitive scored slightly lower than exact',
        Boolean(exact && article) && article.score < exact.score,
        { exact: exact?.score, article: article?.score }
    );
    check(
        'short title: loose matches rejected',
        !strict.some((candidate) => /poneys|grand livre/i.test(candidate.googleTitle || ''))
    );

    // "Le cirque": multiple page-1 rows titled exactly "Le cirque" all pass.
    const cirqueBook = { title: 'Le cirque', possible_corrected_title: null, raw_visible_text: null };
    const cirqueCandidates = makeCandidates([]) // reuse formatter with cirque context below
        .concat(
            ['Le cirque', 'Le cirque', 'Le cirque Calder'].map((title, index) =>
                formatApifyIsbnSearchCandidate(
                    { isbn13: validIsbn13(`97827530043${index}`), isbn: null, title, authors: null, imageUrl: null, resultUrl: null, source: 'isbnsearch_scrapfly' },
                    { title: 'Le cirque', author: null, rawVisibleText: null, possibleCorrectedTitle: null, query: 'Le cirque' }
                )
            )
        )
        .filter(Boolean);

    const cirqueStrict = applyGenericTitleStrictness(cirqueBook, cirqueCandidates);

    check(
        'le cirque: all exact rows kept, "Le cirque Calder" rejected',
        cirqueStrict.length === 2 && cirqueStrict.every((candidate) => candidate.googleTitle === 'Le cirque'),
        cirqueStrict.map((candidate) => candidate.googleTitle)
    );
}

// ---------- UTF-8 through the synthetic fixture ----------
{
    const html = await readFile('test/fixtures/isbnsearch-title.html', 'utf8');
    const candidates = parseIsbnSearchSearchPage(html);

    check(
        'fixture: accented title structure parsed',
        /^La grande encyclop.+die des enfants$/.test(candidates[0]?.title || ''),
        candidates[0]?.title
    );
    check(
        'fixture: NFC normalized (no decomposed accents)',
        !/é/.test(candidates[0]?.title || '')
    );
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL MATCHING-LOGIC CHECKS PASSED');
process.exit(failures ? 1 : 0);
