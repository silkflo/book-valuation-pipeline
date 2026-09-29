// scripts/test-provider-semantics.mjs
//
// Offline unit tests for the price-never-NULL provider semantics helpers.
// No DB, no network.
//   node scripts/test-provider-semantics.mjs

import {
    deriveMomoxState,
    deriveGibertState,
    deriveBackendStatus,
} from '../src/services/adStatus.js';
import { perUnitScrapflyMeta } from '../src/services/costEvents.js';

let failures = 0;

function eq(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        console.log(`  OK  ${label}`);
    } else {
        failures += 1;
        console.error(`FAIL  ${label} -> got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    }
}

// ---------- perUnitScrapflyMeta (per-book batch cost division) ----------
eq('perUnit 30 credits / 3 isbns -> 10 each', perUnitScrapflyMeta(30, 3).perIsbnCredits, 10);
eq('perUnit isbnCount echoed', perUnitScrapflyMeta(30, 3).isbnCount, 3);
eq('perUnit usd computed (30*0.00015/3)', perUnitScrapflyMeta(30, 3).perIsbnUsd, Number((30 * 0.00015 / 3).toFixed(6)));
eq('perUnit null cost -> null', perUnitScrapflyMeta(null, 3).perIsbnCredits, null);
eq('perUnit zero units -> null', perUnitScrapflyMeta(30, 0).perIsbnCredits, null);

// ---------- deriveMomoxState (column present = source of truth) ----------
eq('momox(col): pending', deriveMomoxState({ momox_status: 'momox_pending', momox_price: 0 }, true), 'pending');
eq('momox(col): failed', deriveMomoxState({ momox_status: 'momox_failed', momox_price: 0 }, true), 'failed');
eq('momox(col): price_found done', deriveMomoxState({ momox_status: 'momox_price_found', momox_price: 5 }, true), 'done');
eq('momox(col): no_offer done', deriveMomoxState({ momox_status: 'momox_no_offer', momox_price: 0 }, true), 'done');
eq('momox(col): null status = not_sent (price 0 ignored)', deriveMomoxState({ momox_status: null, momox_price: 0 }, true), 'not_sent');

// ---------- deriveMomoxState (legacy, no column: price NULL = not checked) ----------
eq('momox(legacy): global pending', deriveMomoxState({ status: 'momox_pending', momox_price: null }, false), 'pending');
eq('momox(legacy): price null = not_sent', deriveMomoxState({ status: 'ready_for_resale_check', momox_price: null }, false), 'not_sent');
eq('momox(legacy): price set = done', deriveMomoxState({ status: 'whatever', momox_price: 0 }, false), 'done');
eq('momox(legacy): lookup_failed = failed', deriveMomoxState({ status: 'momox_lookup_failed', momox_price: null }, false), 'failed');

// ---------- deriveGibertState (status + checked_at, never price) ----------
eq('gibert: pending', deriveGibertState({ gibert_status: 'gibert_pending', gibert_price: 0 }), 'pending');
eq('gibert: failed', deriveGibertState({ gibert_status: 'gibert_failed', gibert_price: 0 }), 'failed');
eq('gibert: price_found done', deriveGibertState({ gibert_status: 'gibert_price_found', gibert_price: 2 }), 'done');
eq('gibert: non_repris done', deriveGibertState({ gibert_status: 'gibert_non_repris', gibert_price: 0 }), 'done');
eq('gibert: missing done', deriveGibertState({ gibert_status: 'gibert_missing', gibert_price: 0 }), 'done');
eq('gibert: no status, checked_at set = done', deriveGibertState({ gibert_status: null, gibert_checked_at: '2026-01-01', gibert_price: 0 }), 'done');
eq('gibert: no status, not checked = not_sent', deriveGibertState({ gibert_status: null, gibert_checked_at: null, gibert_price: 0 }), 'not_sent');

// ---------- deriveBackendStatus (canonical vocabulary) ----------
eq('backend: no isbn', deriveBackendStatus({ isbn: null }, 'not_sent', 'not_sent'), 'detected_no_isbn');
eq('backend: rejected', deriveBackendStatus({ isbn: '978', admin_status: 'rejected' }, 'done', 'done'), 'rejected');
eq('backend: duplicate -> needs_admin_review', deriveBackendStatus({ isbn: '978', candidate_status: 'duplicate_alternative' }, 'done', 'done'), 'needs_admin_review');
eq('backend: failed provider', deriveBackendStatus({ isbn: '978', momox_price: 0, gibert_price: 0 }, 'failed', 'done'), 'provider_failed');
eq('backend: pending -> isbn_confirmed', deriveBackendStatus({ isbn: '978', momox_price: 0, gibert_price: 0 }, 'pending', 'done'), 'isbn_confirmed');
eq('backend: price found', deriveBackendStatus({ isbn: '978', momox_price: 4.5, gibert_price: 0 }, 'done', 'done'), 'provider_price_found');
eq('backend: no offer (both 0, BOTH done)', deriveBackendStatus({ isbn: '978', momox_price: 0, gibert_price: 0 }, 'done', 'done'), 'provider_no_offer');
// point 11: never call a not_sent row provider_no_offer
eq('backend: never sent -> provider_not_sent', deriveBackendStatus({ isbn: '978', momox_price: 0, gibert_price: 0 }, 'not_sent', 'not_sent'), 'provider_not_sent');
eq('backend: one done(0) one not_sent -> incomplete not no_offer', deriveBackendStatus({ isbn: '978', momox_price: 0, gibert_price: 0 }, 'done', 'not_sent'), 'isbn_confirmed');
// point 6: strong image match confirms edition despite imperfect title
eq('backend: price + image match -> ready', deriveBackendStatus({ isbn: '978', momox_price: 13, gibert_price: 0, provider_match_status: 'match' }, 'done', 'not_sent'), 'ready_for_admin');
eq('backend: image mismatch -> needs review', deriveBackendStatus({ isbn: '978', momox_price: 13, gibert_price: 0, provider_match_status: 'mismatch' }, 'done', 'done'), 'needs_admin_review');
eq('backend: image uncertain -> needs review', deriveBackendStatus({ isbn: '978', momox_price: 13, gibert_price: 0, provider_match_status: 'uncertain' }, 'done', 'done'), 'needs_admin_review');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PROVIDER-SEMANTICS CHECKS PASSED');
process.exit(failures ? 1 : 0);
