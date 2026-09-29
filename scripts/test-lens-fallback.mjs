// scripts/test-lens-fallback.mjs
//
// OFFLINE / $0 tests for the Google Lens visual fallback. The Apify actor, ISBNSearch
// lookup, and catalog gate are injected stubs — no network, no Apify, no providers,
// no DB. Validates ISBN extraction, noise filtering, and the verify/merge chain.
//
//   node scripts/test-lens-fallback.mjs

import assert from 'node:assert';

// Token test must see both tokens distinct BEFORE the module reads them at call time.
process.env.APIFY_TOKEN = 'PRIMARY_TOKEN';
process.env.APIFY_TOKEN2 = 'SECOND_TOKEN';

const {
    lensApifyToken,
    extractIsbnCandidates,
    normalizeLensItems,
    isGoogleNoise,
    isLensTriggerReason,
    shouldRunLensForBook,
    selectLensCandidates,
    mapItemsToInputs,
    runLensFallback,
} = await import('../src/services/lensFallback.js');

let pass = 0;
let fail = 0;
function ok(name, cond) {
    if (cond) { console.log(`  PASS  ${name}`); pass += 1; }
    else { console.log(`  FAIL  ${name}`); fail += 1; }
}

const ISBN = '9782215141464';       // valid ISBN-13 (Le corps humain de l'enfant, Cultura)
const ISBN10 = '2215141468';        // its ISBN-10 (Amazon /dp) -> converts to ISBN
const COULEURS = '9788832913460';   // valid, but wrong title for a "chiffres" book
const VALID979_NOLOOKUP = '9791234567896'; // valid checksum, no metadata
const BAD13 = '9782215141460';      // bad checksum
const BAD10 = '1234567890';         // bad checksum
const COVER_VERIFIED = new Set(['selected_exact_isbn', 'selected_cover_ambiguous_isbn', 'poor_crop_cover_verified', 'cover_verified_edition_ambiguous']);

// ---------------------------------------------------------------------------
console.log('token + trigger:');
ok('lensApifyToken uses APIFY_TOKEN2, not APIFY_TOKEN', lensApifyToken() === 'SECOND_TOKEN' && lensApifyToken() !== process.env.APIFY_TOKEN);
ok('trigger reasons include held crop reasons', isLensTriggerReason('poor_crop_needs_cover_match') && isLensTriggerReason('poor_crop_selected_exact_low_confidence') && isLensTriggerReason('needs_verification') && isLensTriggerReason('not_eligible'));
ok('non-held reason not a trigger', !isLensTriggerReason('selected_exact_isbn'));

console.log('\nISBN extraction:');
ok('1. Cultura URL extracts ISBN-13', extractIsbnCandidates({ matches: [{ link: `https://www.cultura.com/p/le-corps-humain-${ISBN}.html`, title: 'Le corps humain' }] }).some((c) => c.isbn13 === ISBN));
ok('2. Amazon /dp ISBN-10 -> ISBN-13', (() => { const c = extractIsbnCandidates({ matches: [{ link: `https://www.amazon.fr/dp/${ISBN10}`, title: 'x' }] }); return c.length === 1 && c[0].isbn13 === ISBN && c[0].via === 'amazon_dp'; })());
ok('3. invalid ISBNs ignored', extractIsbnCandidates({ matches: [{ link: `https://x/p/${BAD13}`, title: BAD10 }] }).length === 0);
ok('4. google homepage/doodle links ignored (even w/ ISBN in title)', extractIsbnCandidates({ matches: [{ link: 'https://www.google.com/', title: ISBN }, { link: 'https://www.google.com/doodles/today', title: `Le corps humain ${ISBN}` }, { link: 'https://lens.google.com/search', title: 'x' }] }).length === 0);
ok('aiSummary ISBN extracted', extractIsbnCandidates({ matches: [], aiSummary: `Ce livre a l'ISBN ${ISBN}.` }).some((c) => c.via === 'lens_ai_summary' && c.isbn13 === ISBN));
ok('isGoogleNoise flags doodle/homepage', isGoogleNoise('https://www.google.com/') && isGoogleNoise('https://www.google.com/doodles/x') && !isGoogleNoise('https://www.cultura.com/p/x.html'));
ok('normalizeLensItems flattens match arrays + aiSummary', (() => { const n = normalizeLensItems([{ visualMatches: [{ link: 'a', title: 't' }], exactMatches: [{ link: 'b' }], aiMatches: [], aiSummary: 'S' }]); return n.matches.length === 2 && n.aiSummary === 'S'; })());

// ---------------------------------------------------------------------------
// Orchestrator stubs.
const LOOKUPS = {
    [ISBN]: { title: 'Le corps humain', authors: 'X', publisher: 'Cultura', imageUrl: 'http://x/cover.jpg' },
    [COULEURS]: { title: 'Mon grand livre des couleurs', authors: 'A', publisher: 'P', imageUrl: 'http://x/c.jpg' },
};
const GATES = {
    [ISBN]: { eligible: true, reason: 'poor_crop_cover_verified', sendIsbns: [ISBN] },
};
// item CONTENT per crop URL (the batch stub wraps each with imageUrl for mapping).
const LENS_OUTPUT = {
    'u-happy': { visualMatches: [{ link: `https://www.cultura.com/p/le-corps-humain-${ISBN}.html`, title: 'Le corps humain', source: 'Cultura' }] },
    'u-noisbn': { visualMatches: [{ link: 'https://www.babelio.com/livres/corps/123', title: 'Le corps humain' }] }, // title match, no ISBN
    'u-wrong': { exactMatches: [{ link: `https://www.amazon.fr/x/${COULEURS}`, title: 'couleurs' }] },                 // wrong-title ISBN
    'u-nolook': { visualMatches: [{ link: `https://x/p/${VALID979_NOLOOKUP}`, title: 'Unknown' }] },                   // valid ISBN, no metadata
};

function makeDeps(calls) {
    return {
        // Batch stub: ONE call with all imageUrls -> one dataset item per url (carries imageUrl).
        runActor: async ({ imageUrls }) => { calls.actor.push([...imageUrls]); return { items: imageUrls.map((u) => ({ imageUrl: u, ...(LENS_OUTPUT[u] || {}) })) }; },
        exactLookup: async (isbn) => { calls.lookup.push(isbn); return LOOKUPS[isbn] ? { ok: true, candidate: LOOKUPS[isbn] } : { ok: false, candidate: null }; },
        runGate: async ({ book }) => { calls.gate.push(book.isbn); return { ...(GATES[book.isbn] || { eligible: false, reason: 'poor_crop_needs_cover_match', sendIsbns: [] }), consumedKeyword: true, visionUsd: 0.004, best: { similarity: 0.3 } }; },
    };
}
const hb = (i, key, cropUrl, observedTitle) => ({ physicalBookKey: key, bookIndex: i, cropUrl, observedTitle, bbox: [0.1, 0.1, 0.4, 0.4], orientation: 'horizontal', sourceImageUrl: 'http://x/src.jpg' });

// ---------------------------------------------------------------------------
console.log('\nverify + merge chain:');
{
    const calls = { actor: [], lookup: [], gate: [] };
    const heldBooks = [
        hb(0, 'kA', 'u-happy', 'Le corps humain'),                    // 7. merges after lookup + gate
        hb(1, 'kB', 'u-noisbn', 'Le corps humain'),                   // 5. correct title but no ISBN -> no merge
        hb(2, 'kC', 'u-wrong', 'Mon grand livre de chiffres'),        // 6. wrong title -> no merge
        hb(3, 'kD', 'u-nolook', 'Unknown Title'),                     // valid ISBN but lookup none -> no merge
    ];
    const out = await runLensFallback({ adsId: 'TEST', heldBooks, deps: makeDeps(calls), maxBooksPerAd: 0 });
    const byBook = (i) => out.attempted.filter((r) => r.bookIndex === i);

    ok('7. Lens candidate merges only after exact lookup + gate', out.recovered.has('kA') && out.recovered.get('kA').isbn13 === ISBN && out.recovered.get('kA').lookup && out.recovered.get('kA').gate.eligible);
    ok('merged candidate carries provenance (source/via)', out.recovered.get('kA').via === 'lens_url' && /cultura/.test(out.recovered.get('kA').source || ''));
    ok('5. correct title but no ISBN -> no merge', !out.recovered.has('kB') && byBook(1).length === 0);
    ok('6. wrong title -> held_title, not merged', !out.recovered.has('kC') && byBook(2)[0].status === 'held_title');
    ok('wrong-title ISBN never reached the gate', !calls.gate.includes(COULEURS));
    ok('valid ISBN but lookup none -> held_no_lookup', !out.recovered.has('kD') && byBook(3)[0].status === 'held_no_lookup');
    ok('lookup-none ISBN never reached the gate (Lens never direct)', !calls.gate.includes(VALID979_NOLOOKUP));

    const merges = out.attempted.filter((r) => r.status === 'merged');
    ok('8. every merge had exact lookup + cover-verified gate', merges.length === 1 && merges.every((r) => r.lookup && r.gate?.eligible && COVER_VERIFIED.has(r.gate.reason) && (r.gate.sendIsbns || []).includes(r.isbn13)));
    ok('max 1 ISBN per physical book', [...out.recovered.values()].every((r) => typeof r.isbn13 === 'string'));
    ok('5. batched: ONE actor call for all 4 crop urls', calls.actor.length === 1 && calls.actor[0].length === 4);
    ok('5. batch results mapped back per imageUrl (happy merged, wrong held)', out.recovered.has('kA') && byBook(2)[0].status === 'held_title');
}

// ---------------------------------------------------------------------------
console.log('\nper-book Lens decision (decoupled from global trigger):');
{
    const usable = (i, reason) => ({ bbox: [0.1, 0.1, 0.4, 0.4], reason, observedTitle: 'Some Book', sent: false, _i: i });
    // 1. detected=14, sent=4, held=10 with usable crops + recoverable reasons => run=yes
    const held10 = Array.from({ length: 10 }, (_, i) => usable(i, i % 2 ? 'poor_crop_needs_cover_match' : 'needs_verification'));
    const d1 = selectLensCandidates(held10);
    ok('1. held=10 usable/recoverable -> decision run=yes (all 10)', d1.run === true && d1.candidates.length === 10);

    // 2. held book already sent to provider => not selected
    ok('2. already-sent book not selected', shouldRunLensForBook({ bbox: [0.1, 0.1, 0.4, 0.4], reason: 'poor_crop_needs_cover_match', sent: true }).ok === false);

    // 3. crop_too_small with no useful evidence => not selected
    ok('3. crop_too_small no evidence -> not selected', shouldRunLensForBook({ bbox: [0.1, 0.1, 0.2, 0.2], reason: 'crop_too_small', observedTitle: '', rawText: '', confidence: 0 }).ok === false);

    // 4. crop_too_small with title + high confidence => selected (when configured on)
    ok('4. crop_too_small + title + high conf -> selected', shouldRunLensForBook({ bbox: [0.1, 0.1, 0.2, 0.2], reason: 'crop_too_small', observedTitle: 'Mammifères marins', confidence: 0.9 }, { includeCropTooSmall: true }).ok === true);
    ok('4b. crop_too_small excluded when configured off', shouldRunLensForBook({ bbox: [0.1, 0.1, 0.2, 0.2], reason: 'crop_too_small', observedTitle: 'X', confidence: 0.9 }, { includeCropTooSmall: false }).ok === false);
    ok('non-recoverable reason + no bbox rejected', shouldRunLensForBook({ reason: 'visible_isbn', bbox: null }).ok === false);
}

// ---------------------------------------------------------------------------
console.log('\nbatch mapping + per-image fallback:');
{
    // map by imageUrl field
    const m1 = mapItemsToInputs([{ imageUrl: 'b', x: 2 }, { imageUrl: 'a', x: 1 }], ['a', 'b']);
    ok('mapItemsToInputs maps by imageUrl field', m1[0][0].x === 1 && m1[1][0].x === 2);
    // map by index when counts match + no url field
    const m2 = mapItemsToInputs([{ x: 1 }, { x: 2 }], ['a', 'b']);
    ok('mapItemsToInputs maps by index when counts match', m2[0][0].x === 1 && m2[1][0].x === 2);
    // unreliable (count mismatch, no url) -> null
    ok('mapItemsToInputs returns null when unreliable', mapItemsToInputs([{ x: 1 }], ['a', 'b']) === null);

    // orchestrator per-image fallback: stub returns ONE unmappable item for a batch of 2.
    const calls = { actor: [] };
    const deps = {
        runActor: async ({ imageUrls }) => { calls.actor.push([...imageUrls]); return { items: [{ visualMatches: [] }] }; }, // 1 item, no imageUrl, count!=inputs
        exactLookup: async () => ({ ok: false, candidate: null }),
        runGate: async () => ({ eligible: false, reason: 'poor_crop_needs_cover_match', sendIsbns: [] }),
    };
    const out = await runLensFallback({ adsId: 'FB', heldBooks: [hb(0, 'k0', 'u0', 'A'), hb(1, 'k1', 'u1', 'B')], deps });
    ok('per-image fallback: 1 batch + 2 per-image actor calls', calls.actor.length === 3 && calls.actor[0].length === 2 && calls.actor[1].length === 1);
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
