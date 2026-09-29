// scripts/test-apify-fail-webhook.mjs
//
// Regression guard for the Apify failure-webhook SQL bug ("could not determine data type
// of parameter $2"): markApifyStartJobFailedFromWebhook passed an UNUSED null at $2 that
// the UPDATE never referenced, so Postgres couldn't infer its type. These functions are
// DB-coupled (pool.query) with no DB-mock convention, so this checks the SOURCE:
//   - every pool.query in the failure path has consistent $N placeholders vs param count
//     (no gaps, no unused params) — this is what would have caught the bug;
//   - the failure UPDATE casts its nullable params;
//   - idempotency guards exist;
//   - the route returns 200 on the failure branch and does NOT enqueue a payload job.
//   node scripts/test-apify-fail-webhook.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n)); };

function fnBody(src, signature) {
    const start = src.indexOf(signature);
    if (start < 0) return '';
    const rest = src.slice(start + signature.length);
    const next = rest.indexOf('\nexport ');
    return rest.slice(0, next < 0 ? rest.length : next);
}

// Split a JS array literal's contents on TOP-LEVEL commas (ignores commas inside (), [], {}).
function topLevelParamCount(arrayInner) {
    if (!arrayInner.trim()) return 0;
    let depth = 0, count = 1;
    for (const ch of arrayInner) {
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if (ch === ',' && depth === 0) count++;
    }
    return count;
}

// For every pool.query(`...`, [...]) in `body`, verify $N placeholders vs param count.
function checkQueryParamConsistency(label, body) {
    let i = 0;
    let queries = 0;
    let bad = 0;
    while (true) {
        const q = body.indexOf('pool.query(', i);
        if (q < 0) break;
        const tickStart = body.indexOf('`', q);
        const tickEnd = body.indexOf('`', tickStart + 1);
        if (tickStart < 0 || tickEnd < 0) break;
        const sql = body.slice(tickStart + 1, tickEnd);
        // locate the params array after the SQL backtick
        const after = body.slice(tickEnd + 1);
        const lb = after.indexOf('[');
        const rb = after.indexOf(']');
        i = tickEnd + 1 + (rb > 0 ? rb + 1 : 1);
        if (lb < 0 || rb < 0 || rb < lb) continue; // query with no array params
        const paramCount = topLevelParamCount(after.slice(lb + 1, rb));
        const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
        const maxN = placeholders.length ? Math.max(...placeholders) : 0;
        const used = new Set(placeholders);
        const allPresent = Array.from({ length: maxN }, (_, k) => k + 1).every((n) => used.has(n));
        queries++;
        const consistent = (maxN === paramCount) && allPresent;
        if (!consistent) {
            bad++;
            console.log(`     query#${queries}: maxPlaceholder=$${maxN} paramCount=${paramCount} allPresent=${allPresent}`);
        }
    }
    ok(`${label}: ${queries} pool.query block(s), all $N consistent with param count (no unused/gap params)`, queries > 0 && bad === 0);
}

const queueSrc = read('src/services/apifyStartQueue.js');
const webhookSrc = read('src/routes/apifyWebhook.js');
const failFn = fnBody(queueSrc, 'function markApifyStartJobFailedFromWebhook');

console.log('markApifyStartJobFailedFromWebhook — placeholder/param consistency:');
checkQueryParamConsistency('failure-webhook', failFn);
ok('no leftover unused null at $2 (the bug: "[job.id, null,")', !failFn.includes('[job.id, null,'));

console.log('\nfailure UPDATE casts nullable params:');
ok('ads_id COALESCE cast ($2::text)', /ads_id\s*=\s*COALESCE\(ads_id,\s*\$2::text\)/.test(failFn));
ok('apify_run_id COALESCE cast ($3::text)', /apify_run_id\s*=\s*COALESCE\(apify_run_id,\s*\$3::text\)/.test(failFn));
ok('error_code cast ($4::text)', /error_code\s*=\s*\$4::text/.test(failFn));
ok('error_message cast ($5::text)', /error_message\s*=\s*\$5::text/.test(failFn));
ok('result jsonb cast ($6::jsonb)', /\$6::jsonb/.test(failFn));
ok('renumbered: no stray $7 in the failure UPDATE', !/\$7\b/.test(failFn));

console.log('\nrequired failure state + idempotency:');
ok("sets status = 'failed'", /status\s*=\s*'failed'/.test(failFn));
ok("sets stage = 'apify_run_failed'", /stage\s*=\s*'apify_run_failed'/.test(failFn));
ok("sets apify_status = 'FAILED'", /apify_status\s*=\s*'FAILED'/.test(failFn));
ok('sets finished_at = NOW()', /finished_at\s*=\s*NOW\(\)/.test(failFn));
ok('records apify_run_failed event', /eventType:\s*'apify_run_failed'/.test(failFn));
ok('idempotent: early-return when already processed', /status\s*===\s*'processed'/.test(failFn));
ok('idempotent: early-return when already failed', /status\s*===\s*'failed'/.test(failFn));
ok("UPDATE guarded by status <> 'processed'", /WHERE id = \$1(::bigint)? AND status <> 'processed'/.test(failFn));
ok('errorCode falls back when error.code missing', /apify_run_failed'\s*\)\s*\)\.slice/.test(failFn) || /'apify_run_failed'/.test(failFn));

console.log('\nroute behaviour (apifyWebhook.js):');
const failBranch = webhookSrc.slice(webhookSrc.indexOf('isApifyFailureWebhook(req.body)'));
const branchOnly = failBranch.slice(0, failBranch.indexOf('\n        }\n'));
ok('failure branch returns HTTP 200', /res\.status\(200\)/.test(branchOnly));
ok('failure branch does NOT enqueue a payload job', !/enqueueApifyPayloadProcessingJob/.test(branchOnly));
ok('failure branch handled before the normal enqueue path', webhookSrc.indexOf('isApifyFailureWebhook(req.body)') < webhookSrc.indexOf('enqueueApifyPayloadProcessingJob('));

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
