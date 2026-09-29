// scripts/test-lart-provider-send.mjs
//
// Cost-stop provider policy for the L'Art de l'automobile case (ISBN 9782916914251).
// NOTE: this reverses the earlier "always send L'Art" behaviour. Under the
// immediate-cost-stop policy, a low/medium-confidence work-match (no visible
// ISBN) is HELD for verification, NOT fanned out to providers. It IS sent only
// when it has a visible ISBN or its selected-ISBN confidence >= threshold.
//
// DB-backed (writes a synthetic ad, cleans up). No Scrapfly/OpenAI cost.
//   node scripts/test-lart-provider-send.mjs

import { pool } from '../src/db.js';
import { getProviderEligibility, getProviderIsbnsForAd } from '../src/workflows/processApifyPayload.js';

const ADS = 'test-lart-send';
const LART = '9782916914251';

let failures = 0;
function check(label, cond, detail) {
    if (cond) console.log(`  OK  ${label}`);
    else { failures += 1; console.error(`FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`); }
}

async function cleanup() {
    await pool.query('DELETE FROM ads WHERE ads_id = $1', [ADS]);
}

try {
    // 1) Low-confidence work-match, NO visible ISBN -> HELD (not eligible).
    const weakBook = {
        isbn: LART, isbn_is_valid: true, isbn_confidence: 0.31,
        possible_corrected_title: "L'art de l'automobile : chefs d’œuvre de la collection Ralph Lauren",
        lookup_title: "L' art de l'automobile chefs d'oeuvre de la collection Ralph Lauren ; [...]",
    };
    const elig = getProviderEligibility(weakBook);
    check('L\'Art conf 0.31 (no visible) -> HELD (not eligible)', elig.eligible === false, elig);

    // 1b) Same ISBN but a VISIBLE ISBN read off the cover -> eligible.
    check('L\'Art with visible ISBN -> eligible',
        getProviderEligibility({ ...weakBook, isbn_source: 'visible_isbn' }).eligible === true);

    // 1c) Same ISBN at >= 0.80 confidence -> eligible.
    check('L\'Art at conf 0.85 -> eligible',
        getProviderEligibility({ ...weakBook, isbn_confidence: 0.85 }).eligible === true);

    // 2) DB send query: a weak_candidate row (even if a stale gibert_pending
    //    marker exists) must NOT be sent under the cost-stop policy.
    await cleanup();
    await pool.query(
        `INSERT INTO ads (ads_id, url, title, price_amount, status, raw_data, created_at, updated_at)
         VALUES ($1, 'x', 'Lot de livres de voiture', 10, 'processed', '{}'::jsonb, NOW(), NOW())`,
        [ADS]
    );
    await pool.query(
        `INSERT INTO books (ads_id, isbn, title, lookup_title, cost,
             status, candidate_status, review_status, admin_status,
             isbn_is_valid, isbn_confidence, isbn_source, gibert_status,
             momox_price, gibert_price, best_resale_price, created_at, updated_at)
         VALUES ($1, $2, 'L''ART DE L''AUTOMOBILE', $3, 10,
             'isbn_weak', 'weak_candidate', 'manual_review', 'pending',
             true, 0.31, NULL, 'gibert_pending',
             0, 0, 0, NOW(), NOW())`,
        [ADS, LART, weakBook.lookup_title]
    );
    const sendList = await getProviderIsbnsForAd({ adsId: ADS, limit: 30 });
    check('weak L\'Art NOT in DB send list (cost-stop)', !sendList.includes(LART), sendList);

    // 3) A strong selected ISBN (>= threshold) IS in the send list.
    await pool.query(
        `INSERT INTO books (ads_id, isbn, title, cost, status, candidate_status,
             review_status, admin_status, isbn_is_valid, isbn_confidence, isbn_source,
             momox_price, gibert_price, best_resale_price, created_at, updated_at)
         VALUES ($1, '9780785343134', 'Strong', 10, 'momox_pending', 'strong_candidate',
             'pending', 'pending', true, 0.98, 'isbnsearch_verified', 0, 0, 0, NOW(), NOW())`,
        [ADS]
    );
    // 3b) A visible-ISBN row (low confidence) IS in the send list.
    await pool.query(
        `INSERT INTO books (ads_id, isbn, title, cost, status, candidate_status,
             review_status, admin_status, isbn_is_valid, isbn_confidence, isbn_source,
             momox_price, gibert_price, best_resale_price, created_at, updated_at)
         VALUES ($1, '9782000000010', 'Visible', 10, 'momox_pending', 'weak_candidate',
             'pending', 'pending', true, 0.3, 'visible_isbn', 0, 0, 0, NOW(), NOW())`,
        [ADS]
    );
    const sendList2 = await getProviderIsbnsForAd({ adsId: ADS, limit: 30 });
    check('strong selected ISBN sent', sendList2.includes('9780785343134'), sendList2);
    check('visible-ISBN (low conf) sent', sendList2.includes('9782000000010'), sendList2);
    check('weak L\'Art still excluded', !sendList2.includes(LART), sendList2);
} catch (error) {
    failures += 1;
    console.error('TEST CRASHED:', error);
} finally {
    await cleanup();
    await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nL\'ART COST-STOP POLICY PASSED');
process.exit(failures ? 1 : 0);
