// scripts/test-eligibility.mjs
//
// Offline regression for the COST-STOP provider eligibility policy. No DB,
// no network. Replaces the earlier recall-oriented work-match assertions:
// only a visible ISBN or a high-confidence (>= PROVIDER_MIN_ISBN_CONFIDENCE,
// ~0.80) selected ISBN is provider-eligible; everything else is held for
// verification.
//   node scripts/test-eligibility.mjs

import { getProviderEligibility } from '../src/workflows/processApifyPayload.js';

let failures = 0;
function check(label, cond, detail) {
    if (cond) console.log(`  OK  ${label}`);
    else { failures += 1; console.error(`FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`); }
}

// 1) L'Art de l'automobile: long verified title lowered confidence to 0.36,
//    no visible ISBN -> HELD for verification (cost-stop reversal of the old
//    "always send work-match" behaviour).
{
    const r = getProviderEligibility({
        isbn: '9782916914251', isbn_is_valid: true, isbn_confidence: 0.36,
        possible_corrected_title: "L'Art de l'automobile : chefs-d'œuvre de la collection Ralph Lauren",
        lookup_title: "L' art de l'automobile chefs d'oeuvre de la collection ralph lauren ; [...]",
    });
    check("L'Art (conf 0.36, no visible) -> HELD", r.eligible === false, r);
    check("L'Art reason needs_verification", /needs_verification/.test(r.reason), r.reason);
}

// 1b) Same book WITH a visible ISBN -> eligible (the only low-confidence exception).
check("L'Art + visible ISBN -> SEND",
    getProviderEligibility({ isbn: '9782916914251', isbn_is_valid: true, isbn_confidence: 0.36, isbn_source: 'visible_isbn' }).eligible === true);

// 2) genuinely weak, unrelated title -> HELD.
check('weak unrelated -> HELD',
    getProviderEligibility({ isbn: '9782000000001', isbn_is_valid: true, isbn_confidence: 0.3 }).eligible === false);

// 3) medium candidate (0.6) -> HELD (no 0.4-0.6 sends).
check('medium 0.6 -> HELD',
    getProviderEligibility({ isbn: '9782000000002', isbn_is_valid: true, isbn_confidence: 0.6 }).eligible === false);

// 4) threshold boundary + strong.
check('boundary 0.80 -> SEND',
    getProviderEligibility({ isbn: '9782000000003', isbn_is_valid: true, isbn_confidence: 0.80 }).eligible === true);
check('just under 0.80 -> HELD',
    getProviderEligibility({ isbn: '9782000000004', isbn_is_valid: true, isbn_confidence: 0.79 }).eligible === false);
check('strong 0.9 -> SEND',
    getProviderEligibility({ isbn: '978x', isbn_is_valid: true, isbn_confidence: 0.9 }).eligible === true);

// 5) no / invalid isbn.
check('no isbn -> HELD', getProviderEligibility({ isbn: null }).reason === 'no_isbn');
check('invalid isbn -> HELD', getProviderEligibility({ isbn: '12', isbn_is_valid: false }).reason === 'isbn_invalid');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL ELIGIBILITY CHECKS PASSED');
process.exit(failures ? 1 : 0);
