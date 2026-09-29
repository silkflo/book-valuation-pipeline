// scripts/test-not-sent-semantics.mjs
//
// Offline regression for the price/status semantics after the cost-conservative
// ISBN strategy:
//   NULL price = provider not called / not sent  (status 'not_sent')
//   0    price = provider called, returned no offer
//   > 0  price = provider found a resale price
//   failed status = provider technical failure
//
// Guards: deriveMomoxState / deriveGibertState handle the explicit 'not_sent'
// status; deriveBackendStatus separates not_sent / no_offer / price_found /
// failed; normalizeNotSentReason maps the held-confidence cases onto the
// documented vocabulary. No DB, no network.
//   node scripts/test-not-sent-semantics.mjs

import {
    deriveMomoxState,
    deriveGibertState,
    deriveBackendStatus,
} from '../src/services/adStatus.js';
import { normalizeNotSentReason } from '../src/workflows/processApifyPayload.js';

let failures = 0;
function check(label, cond, detail) {
    if (cond) console.log(`  OK  ${label}`);
    else { failures += 1; console.error(`FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`); }
}

// --- deriveMomoxState ---------------------------------------------------------
// Explicit 'not_sent' status -> not_sent (was wrongly falling through to 'done').
check("momox 'not_sent' status -> not_sent",
    deriveMomoxState({ momox_status: 'not_sent', momox_price: null }, true) === 'not_sent');
check('momox NULL status (column present) -> not_sent',
    deriveMomoxState({ momox_status: null, momox_price: null }, true) === 'not_sent');
check("momox 'momox_pending' -> pending",
    deriveMomoxState({ momox_status: 'momox_pending', momox_price: null }, true) === 'pending');
check("momox 'momox_no_offer' (price 0) -> done",
    deriveMomoxState({ momox_status: 'momox_no_offer', momox_price: 0 }, true) === 'done');
check("momox 'momox_failed' -> failed",
    deriveMomoxState({ momox_status: 'momox_failed', momox_price: null }, true) === 'failed');
// Legacy path (no status column): NULL price still means not_sent.
check('momox legacy NULL price -> not_sent',
    deriveMomoxState({ momox_price: null, status: 'ready_for_resale_check' }, false) === 'not_sent');

// --- deriveGibertState --------------------------------------------------------
check("gibert 'not_sent' status -> not_sent",
    deriveGibertState({ gibert_status: 'not_sent' }) === 'not_sent');
check("gibert 'gibert_pending' -> pending",
    deriveGibertState({ gibert_status: 'gibert_pending' }) === 'pending');
check("gibert 'gibert_non_repris' -> done",
    deriveGibertState({ gibert_status: 'gibert_non_repris' }) === 'done');
check("gibert 'gibert_failed' -> failed",
    deriveGibertState({ gibert_status: 'gibert_failed' }) === 'failed');

// --- deriveBackendStatus: the four canonical provider outcomes ----------------
// not_sent (held, NULL prices) -> provider_not_sent, NOT provider_no_offer.
{
    const row = { isbn: '9782070000101', momox_status: 'not_sent', gibert_status: 'not_sent', momox_price: null, gibert_price: null };
    const backend = deriveBackendStatus(row, deriveMomoxState(row, true), deriveGibertState(row));
    check('held not_sent row -> provider_not_sent', backend === 'provider_not_sent', backend);
}
// no ISBN -> detected_no_isbn.
check('no-isbn row -> detected_no_isbn',
    deriveBackendStatus({ isbn: null }, 'not_sent', 'not_sent') === 'detected_no_isbn');
// Both providers ran, no price (0) -> provider_no_offer.
{
    const row = { isbn: 'x', momox_status: 'momox_no_offer', gibert_status: 'gibert_non_repris', momox_price: 0, gibert_price: 0 };
    const backend = deriveBackendStatus(row, deriveMomoxState(row, true), deriveGibertState(row));
    check('both ran, 0 price -> provider_no_offer', backend === 'provider_no_offer', backend);
}
// Price found -> provider_price_found.
{
    const row = { isbn: 'x', momox_status: 'momox_price_found', gibert_status: 'gibert_non_repris', momox_price: 5.5, gibert_price: 0 };
    const backend = deriveBackendStatus(row, deriveMomoxState(row, true), deriveGibertState(row));
    check('price found -> provider_price_found', backend === 'provider_price_found', backend);
}
// Technical failure -> provider_failed (distinct from no_offer).
{
    const row = { isbn: 'x', momox_status: 'momox_failed', gibert_status: 'gibert_pending', momox_price: null, gibert_price: null };
    const backend = deriveBackendStatus(row, deriveMomoxState(row, true), deriveGibertState(row));
    check('failed provider -> provider_failed', backend === 'provider_failed', backend);
}

// --- normalizeNotSentReason ---------------------------------------------------
check("'needs_verification_low' -> isbn_confidence_below_threshold",
    normalizeNotSentReason('needs_verification_low') === 'isbn_confidence_below_threshold');
check("'needs_verification_medium' -> isbn_confidence_below_threshold",
    normalizeNotSentReason('needs_verification_medium') === 'isbn_confidence_below_threshold');
check("'no_isbn' preserved", normalizeNotSentReason('no_isbn') === 'no_isbn');
check("'isbn_invalid' preserved", normalizeNotSentReason('isbn_invalid') === 'isbn_invalid');
check('null/undefined -> not_eligible', normalizeNotSentReason(undefined) === 'not_eligible');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nNOT-SENT SEMANTICS PASSED');
process.exit(failures ? 1 : 0);
