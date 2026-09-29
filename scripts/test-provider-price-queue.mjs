// scripts/test-provider-price-queue.mjs
//
// Regression guard for the async manual provider-price queue. The data layer + worker are
// DB-coupled (pool.query) with no DB-mock convention here, so this asserts at the SOURCE
// level: the endpoint enqueues + returns 202 (no inline provider call), the duplicate guard
// + FIFO claim + retry/stale semantics are present, the worker keeps the limiter, the status
// endpoint scopes to requested ids, and every pool.query has consistent $N/param counts.
//   node scripts/test-provider-price-queue.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n)); };

// Parse the param array (if any) right after a SQL closing backtick. Depth-aware bracket
// matching; ignores trailing-comma empty segments; detects `pool.query(`...`)` (no array).
function paramArrayAfter(after) {
    let j = 0;
    while (j < after.length && /\s/.test(after[j])) j++;
    if (after[j] !== ',') return { hasArray: false, count: 0 }; // pool.query(`...`) with no params
    const lb = after.indexOf('[', j);
    if (lb < 0) return { hasArray: false, count: 0 };
    let depth = 0, end = -1;
    for (let k = lb; k < after.length; k++) {
        const ch = after[k];
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end < 0) return { hasArray: false, count: 0 };
    const inner = after.slice(lb + 1, end);
    let d = 0, cur = '';
    const segs = [];
    for (const ch of inner) {
        if ('([{'.includes(ch)) { d++; cur += ch; }
        else if (')]}'.includes(ch)) { d--; cur += ch; }
        else if (ch === ',' && d === 0) { segs.push(cur); cur = ''; }
        else cur += ch;
    }
    segs.push(cur);
    return { hasArray: true, count: segs.filter((s) => s.trim().length).length };
}
function checkQueryParamConsistency(label, body) {
    let i = 0, queries = 0, bad = 0;
    while (true) {
        const q = body.indexOf('pool.query(', i);
        if (q < 0) break;
        const ts = body.indexOf('`', q);
        const te = body.indexOf('`', ts + 1);
        if (ts < 0 || te < 0) break;
        i = te + 1;
        const sql = body.slice(ts + 1, te);
        const { count: paramCount } = paramArrayAfter(body.slice(te + 1));
        const ph = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
        const maxN = ph.length ? Math.max(...ph) : 0;
        const used = new Set(ph);
        const allPresent = Array.from({ length: maxN }, (_, k) => k + 1).every((n) => used.has(n));
        queries++;
        if (maxN !== paramCount || !allPresent) { bad++; console.log(`     query#${queries}: max$${maxN} params=${paramCount} allPresent=${allPresent}`); }
    }
    ok(`${label}: ${queries} pool.query block(s), $N consistent with param count`, queries > 0 && bad === 0);
}

const jobs = read('src/services/providerPriceJobs.js');
const worker = read('src/services/providerPriceWorker.js');
const admin = read('src/routes/adminRoutes.js');
const migration = read('scripts/sql/010_provider_price_jobs.sql');
const serverSrc = read('src/server.js');

console.log('migration 010:');
ok('creates provider_price_jobs table', /CREATE TABLE IF NOT EXISTS public\.provider_price_jobs/.test(migration));
ok('partial unique index = one active job per book (duplicate guard)', /CREATE UNIQUE INDEX[\s\S]*?ON public\.provider_price_jobs \(book_id\)[\s\S]*?WHERE status IN \('queued', 'running'\)/.test(migration));

console.log('\nproviderPriceJobs.js (data layer):');
checkQueryParamConsistency('providerPriceJobs', jobs);
ok('enqueue dedups via ON CONFLICT partial index DO NOTHING', /ON CONFLICT \(book_id\) WHERE status IN \('queued', 'running'\)\s*\n?\s*DO NOTHING/.test(jobs));
ok('claim is atomic: FOR UPDATE SKIP LOCKED -> running', /FOR UPDATE SKIP LOCKED/.test(jobs) && /SET status = 'running'/.test(jobs));
ok('claim is FIFO (oldest queued first)', /ORDER BY created_at ASC/.test(jobs));
ok('processed clears errors', /status = 'processed'[\s\S]*?error_code = NULL[\s\S]*?error_message = NULL/.test(jobs));
ok('outcome: retry -> queued, else failed', /retry \? 'queued' : 'failed'/.test(jobs));
ok('stale reset requeues running jobs (or fails at max)', /status = 'running'/.test(jobs) && /WHEN attempts < max_attempts THEN 'queued' ELSE 'failed'/.test(jobs));
ok('table is feature-detected (graceful pre-migration)', /to_regclass\('public\.provider_price_jobs'\)/.test(jobs));

console.log('\nproviderPriceWorker.js:');
ok('claims one at a time by default (PROVIDER_PRICE_MAX_CONCURRENCY||1)', /PROVIDER_PRICE_MAX_CONCURRENCY \|\| 1/.test(worker));
ok('runs providers THROUGH the shared limiter (runProviderLookup)', /runProviderLookup\(/.test(worker));
ok('momox/gibert only called inside runProviderLookup (limiter not bypassed)', !/[^>]\bupdateMomoxPricesForAd\(\{/.test(worker.replace(/runProviderLookup\([^]*?updateMomoxPricesForAd\(\{[^]*?\}\)/g, '')));
ok('gates on hasProviderPriceJobsTable (skips before migration)', /hasProviderPriceJobsTable\(\)/.test(worker));
ok('resets stale running locks each tick', /resetStaleProviderPriceJobs\(/.test(worker));
ok('disable flag honored', /PROVIDER_PRICE_WORKER_ENABLED === 'false'/.test(worker));

console.log('\nadmin endpoint (async + status):');
const handler = admin.slice(admin.indexOf("router.post('/books/:bookId/request-provider-price'"));
const handlerBody = handler.slice(0, handler.indexOf('\nasync function markBookProviderPending'));
ok('endpoint enqueues a provider-price job', /enqueueProviderPriceJob\(/.test(handlerBody));
ok('endpoint returns 202 on queue', /res\.status\(202\)/.test(handlerBody));
ok('endpoint does NOT call Momox/Gibert inline in the async path', !/updateMomoxPricesForAd\(/.test(handlerBody) && !/updateGibertPricesForAd\(/.test(handlerBody));
ok('duplicate click -> alreadyQueued (no second job)', /alreadyQueued: true/.test(handlerBody));
ok('existing result -> 200 (not re-run)', /res\.status\(200\)[\s\S]*?alreadyHasResult: true/.test(handlerBody));
ok('graceful fallback to synchronous when table missing', /hasProviderPriceJobsTable\(\)[\s\S]*?runProviderPriceSynchronously/.test(handlerBody));
ok('status endpoint exists', /router\.get\('\/books\/provider-price-status'/.test(admin));
ok('status endpoint scopes to requested ids (WHERE id = ANY)', /WHERE id = ANY\(\$1::bigint\[\]\)/.test(admin));
ok('status endpoint returns per-book provider/job fields', /jobStatus:/.test(admin) && /momoxStatus:/.test(admin) && /gibertStatus:/.test(admin));

console.log('\nstartup wiring:');
ok('server starts the provider-price worker', /startProviderPriceWorker\(\)/.test(serverSrc));

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
