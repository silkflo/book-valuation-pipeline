// scripts/test-provider-fanout.mjs
//
// Cost-stop regression: the "Livres collège et lycée" classics scenario.
// Same-title classics (Lorenzaccio, Les Misérables, Candide, Zadig, Yvain,
// Claude Gueux, Le Père Goriot, Vendredi) each have MANY editions on ISBNSearch.
// The cost-stop policy must:
//   - send only the ONE selected ISBN per detected book (no alternatives),
//   - exclude medium/weak candidates (no 0.4-0.6 sends),
//   - keep the send-list count small (≈ one per detected book),
//   - never trigger AI fallback verification (env-gated).
//
// DB-backed (synthetic ad, cleans up). No Scrapfly/OpenAI cost.
//   node scripts/test-provider-fanout.mjs

import { pool } from '../src/db.js';
import { getProviderEligibility, getProviderIsbnsForAd } from '../src/workflows/processApifyPayload.js';

const ADS = 'test-fanout-classics';
let failures = 0;
function check(label, cond, detail) {
    if (cond) console.log(`  OK  ${label}`);
    else { failures += 1; console.error(`FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`); }
}
async function cleanup() { await pool.query('DELETE FROM ads WHERE ads_id = $1', [ADS]); }

// One "selected" ISBN per classic + several "alternative_edition" siblings, the
// way the multi-edition resolver used to fan them out.
const CLASSICS = [
    { title: 'Lorenzaccio', selected: '9782070000101', conf: 0.9, alts: ['9782070000102', '9782070000103', '9782070000104'] },
    { title: 'Les Misérables', selected: '9782070000201', conf: 0.6, alts: ['9782070000202', '9782070000203', '9782070000204', '9782070000205'] },
    { title: 'Candide', selected: '9782070000301', conf: 0.55, alts: ['9782070000302', '9782070000303'] },
    { title: 'Zadig', selected: '9782070000401', conf: 0.45, alts: ['9782070000402', '9782070000403'] },
    { title: 'Yvain', selected: '9782070000501', conf: 0.9, alts: ['9782070000502', '9782070000503', '9782070000504', '9782070000505', '9782070000506'] },
    { title: 'Claude Gueux', selected: '9782070000601', conf: 0.82, alts: ['9782070000602', '9782070000603'] },
    { title: 'Le Père Goriot', selected: '9782070000701', conf: 0.7, alts: ['9782070000702', '9782070000703', '9782070000704'] },
    { title: 'Vendredi', selected: '9782070000801', conf: 0.95, alts: ['9782070000802', '9782070000803'] },
];

try {
    await cleanup();
    await pool.query(
        `INSERT INTO ads (ads_id, url, title, price_amount, status, raw_data, created_at, updated_at)
         VALUES ($1, 'x', 'Livres collège et lycée', 5, 'processed', '{}'::jsonb, NOW(), NOW())`,
        [ADS]
    );

    let totalRowsInserted = 0;
    for (const c of CLASSICS) {
        // Selected/main row.
        await pool.query(
            `INSERT INTO books (ads_id, isbn, title, lookup_title, cost, status, candidate_status,
                 review_status, admin_status, isbn_is_valid, isbn_confidence, isbn_source,
                 momox_price, gibert_price, best_resale_price, created_at, updated_at)
             VALUES ($1,$2,$3,$3,5,'momox_pending',$4,'pending','pending',true,$5,'isbnsearch_verified',0,0,0,NOW(),NOW())`,
            [ADS, c.selected, c.title, c.conf >= 0.8 ? 'strong_candidate' : 'medium_candidate', c.conf]
        );
        totalRowsInserted += 1;
        // Alternative editions (high score, but must NOT be sent).
        for (const alt of c.alts) {
            await pool.query(
                `INSERT INTO books (ads_id, isbn, title, lookup_title, cost, status, candidate_status,
                     review_status, admin_status, isbn_is_valid, isbn_confidence, isbn_source,
                     momox_price, gibert_price, best_resale_price, created_at, updated_at)
                 VALUES ($1,$2,$3,$3,5,'isbn_alternative_candidate','alternative_edition','manual_review','pending_edition_choice',true,0.9,'isbnsearch_verified',0,0,0,NOW(),NOW())`,
                [ADS, alt, c.title]
            );
            totalRowsInserted += 1;
        }
    }

    // In-memory eligibility: only conf >= 0.80 selected ISBNs are eligible.
    const eligibleSelected = CLASSICS.filter((c) =>
        getProviderEligibility({ isbn: c.selected, isbn_is_valid: true, isbn_confidence: c.conf }).eligible
    );
    const expectedEligible = CLASSICS.filter((c) => c.conf >= 0.80);
    check('only >=0.80 selected ISBNs eligible',
        eligibleSelected.length === expectedEligible.length, { got: eligibleSelected.map((c) => c.title) });

    // DB send list.
    const sendList = await getProviderIsbnsForAd({ adsId: ADS, limit: 100 });

    // No alternative_edition ISBN may appear.
    const allAlts = CLASSICS.flatMap((c) => c.alts);
    const leakedAlts = sendList.filter((isbn) => allAlts.includes(isbn));
    check('NO alternative editions in send list', leakedAlts.length === 0, leakedAlts);

    // Only the strong (>=0.80) selected ISBNs are sent.
    const expectedSent = CLASSICS.filter((c) => c.conf >= 0.80).map((c) => c.selected).sort();
    const sentSelected = sendList.filter((isbn) => CLASSICS.some((c) => c.selected === isbn)).sort();
    check('only strong selected ISBNs sent', JSON.stringify(sentSelected) === JSON.stringify(expectedSent),
        { sent: sentSelected, expected: expectedSent });

    // Medium/weak selected classics held back.
    const mediumWeak = CLASSICS.filter((c) => c.conf < 0.80).map((c) => c.selected);
    check('medium/weak classics NOT sent', mediumWeak.every((isbn) => !sendList.includes(isbn)), mediumWeak);

    // Fan-out is dramatically smaller than the row count.
    check(`send list small (${sendList.length}) vs rows (${totalRowsInserted})`,
        sendList.length <= CLASSICS.length, { sendList: sendList.length, rows: totalRowsInserted });

    // AI fallback must be disabled by default.
    check('AI_ISBN_FALLBACK_ENABLED is not "true"', process.env.AI_ISBN_FALLBACK_ENABLED !== 'true',
        process.env.AI_ISBN_FALLBACK_ENABLED);
} catch (error) {
    failures += 1;
    console.error('TEST CRASHED:', error);
} finally {
    await cleanup();
    await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nPROVIDER FAN-OUT COST-STOP PASSED');
process.exit(failures ? 1 : 0);
