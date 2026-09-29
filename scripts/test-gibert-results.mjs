// Exercise the actual provider function with synthetic HTTP responses.
// No browser session, provider API request or database is used.
import assert from 'node:assert/strict';
import { lookupGibertPricesBatch } from '../src/services/gibertScrapflyBatchService.js';

process.env.SCRAPFLY_KEY = 'test-placeholder';
process.env.SCRAPFLY_ENABLED = 'true';
const isbn = '9782070368228';
const otherIsbn = '9782092553343';
let responseBody;
let responseStatus = 200;
globalThis.fetch = async () => new Response(JSON.stringify(responseBody), {
    status: responseStatus, headers: { 'Content-Type': 'application/json' },
});
const lookup = books => lookupGibertPricesBatch({ books: books || [{ isbn }] });

responseBody = { result: { success: true, content: '<table id="product_list"></table>' } };
let result = await lookup();
assert.equal(result.ok, false, 'An empty submission result is a technical failure');
assert.equal(result.failureKind, 'scenario_form_failure');
assert.deepEqual(result.missingIsbns, [isbn]);

responseBody = { result: { success: true, content: `<table id="product_list"><tr><td>${isbn} </td><td class="non-repris">Non repris</td></tr></table>` } };
result = await lookup();
assert.equal(result.ok, true, 'An explicit no-offer row is a successful collection');
assert.equal(result.rows[0].status, 'gibert_non_repris');
assert.equal(result.rows[0].gibertPrice, 0);

responseBody = { result: { success: true, content: `<table id="product_list"><tr><td>${isbn} </td><td class="repris"><span class="price">4,50 €</span></td></tr></table>` } };
result = await lookup([{ isbn }, { isbn: otherIsbn }]);
assert.equal(result.ok, true);
assert.equal(result.rows[0].gibertPrice, 4.5);
assert.deepEqual(result.missingIsbns, [otherIsbn], 'Partial results preserve the missing ISBN');

responseStatus = 403;
responseBody = { result: { success: false, error: { message: 'Synthetic blocked request' } } };
result = await lookup();
assert.equal(result.ok, false, 'HTTP rejection is never a no-offer result');
assert.equal(result.statusCode, 403);
assert.deepEqual(result.rows, []);
console.log('Gibert: empty batch, genuine no offer, partial results and HTTP rejection passed.');
