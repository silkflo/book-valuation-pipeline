// scripts/test-ai-isbn-fallback.mjs
//
// OFFLINE / $0 tests for the AI ISBN fallback phase (v2: checksum repair + AI search
// queries). All external calls (OpenAI, ISBNSearch, AbeBooks, the catalog gate) are
// injected stubs — no network, no DB, no providers.
//
//   node scripts/test-ai-isbn-fallback.mjs

import assert from 'node:assert';
import {
    shouldTriggerFallback,
    normalizeToIsbn13,
    repairIsbn13,
    resolveAiIsbn,
    isValidIsbn13,
    runAiIsbnFallback,
} from '../src/services/aiIsbnFallback.js';

let pass = 0;
let fail = 0;
function ok(name, cond) {
    if (cond) { console.log(`  PASS  ${name}`); pass += 1; }
    else { console.log(`  FAIL  ${name}`); fail += 1; }
}

// ---------------------------------------------------------------------------
console.log('trigger logic:');
ok('zero eligible -> fire', shouldTriggerFallback({ enabled: true, detectedBooks: 7, providerEligibleBooks: 0 }).trigger === true);
ok('detected>=5 & eligible<=1 -> fire (sparse 7/1)', shouldTriggerFallback({ enabled: true, detectedBooks: 7, providerEligibleBooks: 1 }).trigger === true);
ok('detected=5 & eligible=2 -> no fire', shouldTriggerFallback({ enabled: true, detectedBooks: 5, providerEligibleBooks: 2 }).trigger === false);
ok('disabled -> no fire', shouldTriggerFallback({ enabled: false, detectedBooks: 9, providerEligibleBooks: 0 }).trigger === false);

console.log('\nchecksum repair + normalize:');
ok('valid ISBN-13 kept', normalizeToIsbn13('978-2-7583-0172-1') === '9782758301721');
ok('valid ISBN-10 -> 13', isValidIsbn13(normalizeToIsbn13('2070360024')));
ok('repair 978 bad checksum -> valid', repairIsbn13('9782758301720') === '9782758301721');
ok('repair refuses non-978/979', repairIsbn13('1234567890123') === null);
ok('repair refuses wrong length', repairIsbn13('978123') === null);
ok('resolveAiIsbn repairs bad 978', (() => { const r = resolveAiIsbn('9782758301720'); return r.isbn13 === '9782758301721' && r.repaired === true; })());
ok('resolveAiIsbn keeps valid (not repaired)', (() => { const r = resolveAiIsbn('9782758301721'); return r.isbn13 === '9782758301721' && r.repaired === false; })());
ok('resolveAiIsbn rejects non-repairable', resolveAiIsbn('1234567890').isbn13 === null);

// ---------------------------------------------------------------------------
const X = '9782758301721';          // Le corps humain (valid)
const X_BAD = '9782758301720';      // repairs -> X
const C = '9788832913460';          // couleurs (wrong sibling of "chiffres")
const REPAIR_NOLOOKUP = '9781111111111'; // repairs -> 9781111111113 (not in LOOKUPS)
const BAD10 = '1234567890';         // bad ISBN-10, non-repairable
const BAD13 = '1234567890123';      // 13 digits but not 978/979, non-repairable

const LOOKUPS = {
    [X]: { title: 'Le corps humain Organes', authors: 'Coll.', publisher: 'Belin', imageUrl: 'http://x/x.jpg' },
    [C]: { title: 'Mon grand livre des couleurs', authors: 'A', publisher: 'P', imageUrl: 'http://x/c.jpg' },
};
const GATES = {
    [X]: { eligible: true, reason: 'poor_crop_cover_verified', sendIsbns: [X] },
};
const SEARCH = {
    'le corps humain belin': [{ isbn13: X }],
    'mon grand livre des couleurs': [{ isbn13: C }],
};

function makeDeps(calls) {
    return {
        askFallback: async (hb) => { calls.ai.push(hb.bookIndex); return { bookIndex: hb.bookIndex, observedTitle: hb.observedTitle, isbnCandidates: (hb._isbns || []).map((isbn) => ({ isbn13: isbn })), searchQueries: (hb._queries || []).map((q) => ({ query: q, why: '' })) }; },
        exactLookup: async (isbn) => { calls.lookup.push(isbn); return LOOKUPS[isbn] ? { ok: true, candidate: LOOKUPS[isbn] } : { ok: false, candidate: null }; },
        fetchCovers: async (isbns) => { calls.covers.push(...isbns); return isbns.map((i) => ({ isbn13: i, ok: false, imageUrl: null })); },
        searchByQuery: async ({ title }) => { calls.search.push(title); return { ok: true, candidates: SEARCH[String(title || '').toLowerCase()] || [] }; },
        runGate: async ({ book }) => { calls.gate.push(book.isbn); return { ...(GATES[book.isbn] || { eligible: false, reason: 'poor_crop_needs_cover_match', sendIsbns: [] }), consumedKeyword: true, visionUsd: 0.004, best: { similarity: 0.3 } }; },
    };
}
const hb = (i, observedTitle, { isbns = [], queries = [] }) => ({
    physicalBookKey: `k${i}`, bookIndex: i, observedTitle, bbox: [0.1, 0.1, 0.4, 0.4], orientation: 'horizontal',
    sourceImageUrl: 'http://x/src.jpg', cropQuality: 'risky', author: null, _isbns: isbns, _queries: queries,
});

// ---------------------------------------------------------------------------
console.log('\nverify chain (repair + search):');
{
    const calls = { ai: [], lookup: [], covers: [], search: [], gate: [] };
    const heldBooks = [
        hb(0, 'Le corps humain', { isbns: [X_BAD] }),                          // repaired -> lookup found -> merged
        hb(1, 'Le corps humain', { isbns: [REPAIR_NOLOOKUP] }),                // repaired -> lookup none -> held_no_lookup
        hb(2, 'Le corps humain', { isbns: [BAD10] }),                          // non-repairable -> held_checksum
        hb(3, 'Le corps humain', { isbns: [BAD13] }),                          // 13-digit non-978 -> held_checksum
        hb(4, 'Le corps humain', { isbns: [], queries: ['Le corps humain Belin'] }), // no ISBN -> search finds X -> merged
        hb(5, 'Mon grand livre de chiffres', { isbns: [C], queries: ['Mon grand livre des couleurs'] }), // sibling stays blocked
    ];
    const out = await runAiIsbnFallback({ adsId: 'TEST', heldBooks, deps: makeDeps(calls), maxSuggestionsPerBook: 3, maxSearchQueriesPerBook: 2, maxBooksPerAd: 0 });
    const byBook = (i) => out.attempted.filter((r) => r.bookIndex === i);

    ok('repaired + lookup found + gate eligible -> merged', out.recovered.has('k0') && out.recovered.get('k0').isbn13 === X && out.recovered.get('k0').repaired === true);
    ok('repair logged checksum=bad (original kept)', byBook(0)[0].checksum === 'bad' && byBook(0)[0].original === X_BAD);
    ok('repaired + lookup none -> held_no_lookup', byBook(1)[0].status === 'held_no_lookup' && byBook(1)[0].repaired === true && !out.recovered.has('k1'));
    ok('non-repairable ISBN-10 -> held_checksum', byBook(2)[0].status === 'held_checksum');
    ok('held_checksum never looked up', !calls.lookup.includes(BAD10));
    ok('13-digit non-978 -> held_checksum', byBook(3)[0].status === 'held_checksum' && !calls.lookup.includes(BAD13));
    ok('no AI ISBN but good query -> search finds candidate -> merged', out.recovered.has('k4') && out.recovered.get('k4').via === 'ai_search' && out.recovered.get('k4').isbn13 === X);
    ok('search path required exact lookup', out.recovered.get('k4').lookup && out.recovered.get('k4').lookup.source === 'isbnsearch');
    ok('chiffres -> couleurs/nombres stays blocked (held_title, isbn + search)', !out.recovered.has('k5') && byBook(5).every((r) => r.status === 'held_title' || r.status === 'held_checksum'));
    ok('chiffres: couleurs ISBN never gated', !calls.gate.includes(C));

    // Global invariant: nothing merges without exact lookup + an eligible, cover-verified gate.
    const COVER = new Set(['selected_exact_isbn', 'selected_cover_ambiguous_isbn', 'poor_crop_cover_verified', 'cover_verified_edition_ambiguous']);
    const merges = out.attempted.filter((r) => r.status === 'merged');
    ok('every merge had exact lookup + cover-verified gate (AI never direct)', merges.length > 0 && merges.every((r) => r.lookup && r.gate?.eligible && COVER.has(r.gate.reason) && (r.gate.sendIsbns || []).includes(r.isbn13)));
    ok('total merged = 2 (repaired X + search X)', out.stats.merged === 2);
}

// ---------------------------------------------------------------------------
console.log('\nmax 1 ISBN per physical book + runs on all books:');
{
    const calls = { ai: [], lookup: [], covers: [], search: [], gate: [] };
    // 5 unresolved books, each repairable to X (merged) -> all 5 recovered, 1 ISBN each.
    const heldBooks = [0, 1, 2, 3, 4].map((i) => hb(i, 'Le corps humain', { isbns: [X_BAD, X] }));
    const out = await runAiIsbnFallback({ adsId: 'TEST5', heldBooks, deps: makeDeps(calls), maxSuggestionsPerBook: 3, maxBooksPerAd: 0 });
    ok('all 5 unresolved books processed (no 3-cap)', calls.ai.length === 5 && out.recovered.size === 5);
    ok('each recovered book has exactly 1 ISBN', [...out.recovered.values()].every((r) => typeof r.isbn13 === 'string'));
    ok('2nd suggestion not evaluated after first merge (dedupe/cost-stop)', calls.gate.filter((i) => i === X).length === 5); // gated X once per book, not twice
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
