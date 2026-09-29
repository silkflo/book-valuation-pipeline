// scripts/test-crop-quality-gate.mjs
//
// OFFLINE / $0 verification of the #5 crop-quality guard in catalogEligibilityForBook.
// No OpenAI, no Scrapfly, no providers, no DB. The poor/risky cover-verify path that
// DOES call the matcher is exercised via skipMatch:true (budget path) so the guard's
// "don't bypass on confidence" behaviour is proven without spending.
//
//   node scripts/test-crop-quality-gate.mjs

import assert from 'node:assert';
import { catalogEligibilityForBook, gateOutcomeLabel, exactMatchEligibilityOnRiskyCrop } from '../src/services/catalog/verifyCatalogForAd.js';
import { cropQualityLevel, levelFromCropClass } from '../src/services/cropQuality.js';
import { selectPersistedAlternatives } from '../src/workflows/processApifyPayload.js';

// bboxes sized to land in each crop class (TINY<0.05, LARGE>=0.30).
const BB = {
    tiny: [0.10, 0.10, 0.30, 0.30],       // area 0.04  -> poor
    borderline: [0.10, 0.10, 0.42, 0.42], // area 0.1024 -> risky
    large: [0.10, 0.10, 0.81, 0.81],      // area 0.5041 -> good
};

function book({ area, isbn = '9780000000001', conf, source = null, valid = true }) {
    return { bbox: BB[area], isbn, isbn_source: source, isbn_is_valid: valid, isbn_confidence: conf };
}

let pass = 0;
let fail = 0;
async function check(name, opts, expect) {
    const out = await catalogEligibilityForBook(opts);
    const got = { eligible: out.eligible, reason: out.reason, send: JSON.stringify(out.sendIsbns) };
    try {
        if ('eligible' in expect) assert.strictEqual(got.eligible, expect.eligible, `eligible`);
        if ('reason' in expect) assert.strictEqual(got.reason, expect.reason, `reason`);
        if ('send' in expect) assert.strictEqual(got.send, JSON.stringify(expect.send), `send`);
        console.log(`  PASS  ${name}  -> ${got.reason} send=${got.send}`);
        pass += 1;
    } catch (e) {
        console.log(`  FAIL  ${name}  -> got ${JSON.stringify(got)} | ${e.message}`);
        fail += 1;
    }
}

console.log('cropQuality unit:');
assert.strictEqual(cropQualityLevel(BB.tiny).level, 'poor');
assert.strictEqual(cropQualityLevel(BB.borderline).level, 'risky');
assert.strictEqual(cropQualityLevel(BB.large).level, 'good');
assert.strictEqual(cropQualityLevel(null).level, 'risky');
assert.strictEqual(levelFromCropClass('tiny'), 'poor');
assert.strictEqual(levelFromCropClass('borderline'), 'risky');
assert.strictEqual(levelFromCropClass('large'), 'good');
console.log('  PASS  area->level mapping (poor/risky/good)\n');

console.log('gateOutcomeLabel distinctness (logging cleanup):');
// A true unique-cover match and the guarded path B BOTH carry decision=selected_exact_isbn,
// so the label must keep them visually distinct; held books surface their hold reason.
assert.strictEqual(gateOutcomeLabel({ eligible: true, decision: 'selected_exact_isbn', reason: 'poor_crop_cover_verified' }), 'selected_exact_isbn');
assert.strictEqual(gateOutcomeLabel({ eligible: true, decision: 'selected_exact_isbn', reason: 'visible_isbn' }), 'selected_exact_isbn');
assert.strictEqual(gateOutcomeLabel({ eligible: true, decision: 'selected_exact_isbn', reason: 'cover_verified_edition_ambiguous' }), 'cover_verified_edition_ambiguous');
assert.strictEqual(gateOutcomeLabel({ eligible: false, decision: 'needs_verification', reason: 'poor_crop_needs_cover_match' }), 'poor_crop_needs_cover_match');
assert.notStrictEqual(
    gateOutcomeLabel({ eligible: true, decision: 'selected_exact_isbn', reason: 'cover_verified_edition_ambiguous' }),
    gateOutcomeLabel({ eligible: true, decision: 'selected_exact_isbn', reason: 'poor_crop_cover_verified' }),
);
console.log('  PASS  selected_exact_isbn != cover_verified_edition_ambiguous != poor_crop_needs_cover_match\n');

console.log('selected_exact_isbn metadata-confidence floor on risky/poor crops:');
const MED = 0.50; // CATALOG_MEDIUM_ISBN_MIN_CONFIDENCE default
function checkExact(name, args, expect) {
    const got = exactMatchEligibilityOnRiskyCrop({ ...args, mediumMin: MED });
    try {
        assert.strictEqual(got.eligible, expect.eligible, 'eligible');
        assert.strictEqual(got.reason, expect.reason, 'reason');
        console.log(`  PASS  ${name}  -> eligible=${got.eligible} reason=${got.reason}`);
        pass += 1;
    } catch (e) {
        console.log(`  FAIL  ${name}  -> ${JSON.stringify(got)} | ${e.message}`);
        fail += 1;
    }
}
// THE regression: Mammifères marins, isbn 9782344044537, conf 0.32, selected_exact_isbn
// present, borderline crop -> must be HELD (weak base candidate, not just a cover match).
checkExact('Mammifères marins conf=0.32 (selected_exact present)',
    { selConf: 0.32, selValid: true, imageTitle: 'Mammifères marins', catalogTitle: 'Mammifères marins' },
    { eligible: false, reason: 'poor_crop_selected_exact_low_confidence' });
checkExact('weak conf=0.49 just below MEDIUM_MIN -> held',
    { selConf: 0.49, selValid: true, imageTitle: 'X', catalogTitle: 'X' },
    { eligible: false, reason: 'poor_crop_selected_exact_low_confidence' });
checkExact('conf=0.50 at MEDIUM_MIN + title ok -> eligible',
    { selConf: 0.50, selValid: true, imageTitle: 'Mammifères marins', catalogTitle: 'Mammifères marins' },
    { eligible: true, reason: 'poor_crop_cover_verified' });
checkExact('strong conf=0.95 + title ok -> eligible',
    { selConf: 0.95, selValid: true, imageTitle: 'La jeune fille et la nuit', catalogTitle: 'La jeune fille et la nuit' },
    { eligible: true, reason: 'poor_crop_cover_verified' });
// chiffres stays blocked even at high confidence when the title semantically conflicts.
checkExact('chiffres vs couleurs conf=0.95 -> held (title conflict)',
    { selConf: 0.95, selValid: true, imageTitle: 'Mon grand livre de chiffres', catalogTitle: 'Mon grand livre des couleurs' },
    { eligible: false, reason: 'poor_crop_selected_exact_title_conflict' });
checkExact('invalid candidate -> held low_confidence',
    { selConf: 0.95, selValid: false, imageTitle: 'X', catalogTitle: 'X' },
    { eligible: false, reason: 'poor_crop_selected_exact_low_confidence' });
console.log('');

const I = '9780000000001';
const rows = new Set([I]); // catalogEligibilityForBook expects existingRowIsbns as a Set

console.log('catalog gate (#5 guard):');
// 1) visible cover ISBN is exempt from the guard even on a tiny crop.
await check('visible tiny -> send (exempt)',
    { book: book({ area: 'tiny', isbn: I, conf: 1, source: 'visible_isbn' }), sourceImageUrl: 'x', existingRowIsbns: rows },
    { eligible: true, reason: 'visible_isbn', send: [I] });

// 2) weak (below medium) holds with no cost, regardless of crop.
await check('weak tiny -> hold crop_too_small',
    { book: book({ area: 'tiny', isbn: I, conf: 0.30 }), sourceImageUrl: 'x', existingRowIsbns: rows },
    { eligible: false, reason: 'crop_too_small', send: [] });
await check('weak borderline -> hold needs_verification',
    { book: book({ area: 'borderline', isbn: I, conf: 0.30 }), sourceImageUrl: 'x', existingRowIsbns: rows },
    { eligible: false, reason: 'needs_verification', send: [] });

// 3) THE CORE REGRESSION GUARD: strong/medium on poor/risky crops must NOT bypass on
//    confidence. Under skipMatch (cover-verify unavailable) they are HELD, not sent.
//    (Previously a tiny strong ISBN was sent via strong_isbn_tiny_crop_allowed.)
await check('strong TINY + skipMatch -> HELD (no confidence bypass)',
    { book: book({ area: 'tiny', isbn: I, conf: 0.95 }), sourceImageUrl: 'x', existingRowIsbns: rows, skipMatch: true },
    { eligible: false, reason: 'catalog_budget_no_cover_proof', send: [] });
await check('medium BORDERLINE + skipMatch -> HELD (book-6 shape)',
    { book: book({ area: 'borderline', isbn: I, conf: 0.60 }), sourceImageUrl: 'x', existingRowIsbns: rows, skipMatch: true },
    { eligible: false, reason: 'catalog_budget_no_cover_proof', send: [] });

// 4) GOOD (large) crop stays lenient: strong/medium send (existing behaviour).
await check('strong LARGE + skipMatch -> send strong_isbn_budget',
    { book: book({ area: 'large', isbn: I, conf: 0.95 }), sourceImageUrl: 'x', existingRowIsbns: rows, skipMatch: true },
    { eligible: true, reason: 'strong_isbn_budget', send: [I] });
await check('medium LARGE + skipMatch -> send medium_fallback',
    { book: book({ area: 'large', isbn: I, conf: 0.60 }), sourceImageUrl: 'x', existingRowIsbns: rows, skipMatch: true },
    { eligible: true, reason: 'medium_fallback', send: [I] });

console.log('\nquality gate — identity kept, provider HELD without strong proof:');
// crop-retry mismatch forces cover-only proof even on a LARGE crop + strong ISBN:
// a good crop + strong conf that would normally send is HELD because the visual identity
// is unreliable (Pass-2 disagreed). Book is kept; just not provider-eligible.
await check('crop_retry_mismatch + strong LARGE + skipMatch -> HELD crop_retry_mismatch',
    { book: { ...book({ area: 'large', isbn: I, conf: 0.95 }), crop_retry_mismatch: true }, sourceImageUrl: 'x', existingRowIsbns: rows, skipMatch: true },
    { eligible: false, reason: 'crop_retry_mismatch', send: [] });
await check('crop_retry_mismatch + medium BORDERLINE + skipMatch -> HELD crop_retry_mismatch',
    { book: { ...book({ area: 'borderline', isbn: I, conf: 0.60 }), crop_retry_mismatch: true }, sourceImageUrl: 'x', existingRowIsbns: rows, skipMatch: true },
    { eligible: false, reason: 'crop_retry_mismatch', send: [] });
// crop_retry_mismatch must NOT override a VISIBLE cover ISBN (direct evidence stays eligible).
await check('crop_retry_mismatch + VISIBLE isbn tiny -> still send (visible_isbn)',
    { book: { ...book({ area: 'tiny', isbn: I, conf: 1, source: 'visible_isbn' }), crop_retry_mismatch: true }, sourceImageUrl: 'x', existingRowIsbns: rows },
    { eligible: true, reason: 'visible_isbn', send: [I] });
// budget-skipped cover on tiny crop (generic/title-only candidate shape): HELD, kept for review.
await check('medium TINY (generic/title-only) + skipMatch -> HELD catalog_budget_no_cover_proof',
    { book: book({ area: 'tiny', isbn: I, conf: 0.60 }), sourceImageUrl: 'x', existingRowIsbns: rows, skipMatch: true },
    { eligible: false, reason: 'catalog_budget_no_cover_proof', send: [] });

console.log('\ncandidate persistence cap (selectPersistedAlternatives):');
const alt = (isbn, { priceable = false, score = 0, conf = 0 } = {}) =>
    ({ isbn, _isPriceableAlternativeCandidate: priceable, lookup_score: score, isbn_confidence: conf });
function okp(name, cond) { cond ? (pass += 1, console.log(`  PASS  ${name}`)) : (fail += 1, console.log(`  FAIL  ${name}`)); }
{
    const many = [
        alt('A', { score: 0.10 }), alt('B', { priceable: true, score: 0.20 }),
        alt('C', { score: 0.90 }), alt('D', { priceable: true, score: 0.50 }),
        alt('E', { score: 0.40 }),
    ];
    const kept = selectPersistedAlternatives(many, 2);
    okp('caps to 2 alternatives', kept.length === 2);
    okp('priceable (exact-title) alternatives ranked first', kept.every((r) => r._isPriceableAlternativeCandidate));
    okp('higher-score priceable first (D 0.50 before B 0.20)', kept[0].isbn === 'D' && kept[1].isbn === 'B');
    okp('weak non-priceable (C 0.90) skipped despite high score', !kept.some((r) => r.isbn === 'C'));
    okp('cap=0 -> none persisted', selectPersistedAlternatives(many, 0).length === 0);
    okp('non-priceable kept only to fill the cap', selectPersistedAlternatives([alt('X', { score: 0.3 }), alt('Y', { score: 0.1 })], 1)[0].isbn === 'X');
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
