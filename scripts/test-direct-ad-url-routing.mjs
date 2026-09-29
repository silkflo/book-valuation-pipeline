// scripts/test-direct-ad-url-routing.mjs
//
// Guards the stuck-Apify-queue root cause: a DIRECT Leboncoin ad URL
// (https://www.leboncoin.fr/ad/livres/<id>) queued as apify_start_search_page starts
// the search-page actor, whose per-item webhooks (mode=search_page_item) the backend
// cannot process -> the start job hangs at processing/apify_running/40% and, with
// APIFY_START_MAX_CONCURRENCY=1, blocks every queued Apify job behind it.
//
// Four independent layers are asserted so an ad URL can never get (or stay) stuck:
//   1. isDirectLeboncoinAdUrl classifies ad vs search URLs (pure unit tests);
//   2. enqueue-time reroute: enqueuePageRangeScrapeJobs queues direct ad URLs as
//      apify_start_manual_ad (source-level);
//   3. claim-time self-heal: the worker retypes legacy queued search-page jobs whose
//      URL is a direct ad URL, and buildActorInput throws rather than ever starting a
//      search-page run for one (unit + source-level);
//   4. recovery: mode=search_page_item terminally FAILS the parent start job (queue
//      released) while still returning 200, and the reconciler fails runs that ended
//      without a supported webhook (source-level).
//   node scripts/test-direct-ad-url-routing.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Importing src modules pulls in db.js (requires DATABASE_URL) and buildActorInput
// reads webhook env at call time. Provide inert defaults BEFORE the dynamic imports
// so this test runs anywhere without a .env; dotenv never overrides existing vars.
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.PUBLIC_WEBHOOK_BASE_URL ||= 'https://webhook.example.test';
process.env.WEBHOOK_SECRET ||= 'test-secret';

const { isDirectLeboncoinAdUrl } = await import('../src/services/leboncoinUrl.js');
const { buildActorInput } = await import('../src/services/apifyStartQueue.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n)); };

// Slice a named function body out of source (up to the next top-level `export ` or EOF).
function fnBody(src, signature) {
    const start = src.indexOf(signature);
    if (start < 0) return '';
    const rest = src.slice(start + signature.length);
    const next = rest.indexOf('\nexport ');
    return rest.slice(0, next < 0 ? rest.length : next);
}

const AD_URL_1 = 'https://www.leboncoin.fr/ad/livres/3229746275'; // incident URL
const AD_URL_2 = 'https://www.leboncoin.fr/ad/livres/3229708940'; // incident URL
const SEARCH_URL = 'https://www.leboncoin.fr/recherche?category=27&text=harry+potter';

console.log('1) isDirectLeboncoinAdUrl (pure):');
ok('incident ad URL #1 -> true', isDirectLeboncoinAdUrl(AD_URL_1) === true);
ok('incident ad URL #2 -> true', isDirectLeboncoinAdUrl(AD_URL_2) === true);
ok('ad URL with query string -> true', isDirectLeboncoinAdUrl(`${AD_URL_1}?utm_source=share`) === true);
ok('ad URL with trailing slash -> true', isDirectLeboncoinAdUrl(`${AD_URL_1}/`) === true);
ok('http + bare host -> true', isDirectLeboncoinAdUrl('http://leboncoin.fr/ad/livres/123') === true);
ok('mobile host m.leboncoin.fr -> true', isDirectLeboncoinAdUrl('https://m.leboncoin.fr/ad/livres/123') === true);
ok('other category slug -> true', isDirectLeboncoinAdUrl('https://www.leboncoin.fr/ad/bd/999') === true);
ok('search URL -> false', isDirectLeboncoinAdUrl(SEARCH_URL) === false);
ok('category browse /c/livres -> false', isDirectLeboncoinAdUrl('https://www.leboncoin.fr/c/livres') === false);
ok('legacy listing path -> false', isDirectLeboncoinAdUrl('https://www.leboncoin.fr/livres/offres') === false);
ok('non-numeric ad id -> false', isDirectLeboncoinAdUrl('https://www.leboncoin.fr/ad/livres/abc') === false);
ok('missing category segment -> false', isDirectLeboncoinAdUrl('https://www.leboncoin.fr/ad/3229746275') === false);
ok('lookalike host evil-leboncoin.fr -> false', isDirectLeboncoinAdUrl('https://evil-leboncoin.fr/ad/livres/1') === false);
ok('suffix-spoof host leboncoin.fr.evil.com -> false', isDirectLeboncoinAdUrl('https://leboncoin.fr.evil.com/ad/livres/1') === false);
ok('non-http protocol -> false', isDirectLeboncoinAdUrl('ftp://www.leboncoin.fr/ad/livres/1') === false);
ok('garbage / empty / null -> false', !isDirectLeboncoinAdUrl('not a url') && !isDirectLeboncoinAdUrl('') && !isDirectLeboncoinAdUrl(null));

console.log('\n2) buildActorInput can NEVER start a search-page run for an ad URL (unit):');
let thrown = null;
try {
    buildActorInput({ type: 'apify_start_search_page', input: { searchUrl: AD_URL_1, page: 1 } });
} catch (error) {
    thrown = error;
}
ok('search_page + direct ad URL -> throws', thrown !== null);
ok('throw message points at apify_start_manual_ad', /apify_start_manual_ad/.test(thrown?.message || ''));

const manualInput = buildActorInput({ type: 'apify_start_manual_ad', input: { adUrl: AD_URL_1 } });
ok('manual_ad input has mode=manual_ad + adUrl + startUrls', manualInput.mode === 'manual_ad' && manualInput.adUrl === AD_URL_1 && manualInput.startUrls?.[0]?.url === AD_URL_1);

const pageInput = buildActorInput({ type: 'apify_start_search_page', input: { searchUrl: SEARCH_URL, page: 2 } });
ok('genuine search URL still builds mode=page_range', pageInput.mode === 'page_range' && pageInput.fromPage === 2 && pageInput.toPage === 2);

const queueSrc = read('src/services/apifyStartQueue.js');
const workersSrc = read('src/services/apifyStartWorkers.js');
const webhookSrc = read('src/routes/apifyWebhook.js');

console.log('\n3) enqueue-time reroute (apifyStartQueue.js enqueuePageRangeScrapeJobs):');
const enqueueBody = fnBody(queueSrc, 'function enqueuePageRangeScrapeJobs');
ok('classifies the URL with isDirectLeboncoinAdUrl', /isDirectLeboncoinAdUrl\(cleanUrl\)/.test(enqueueBody));
ok('reroutes to enqueueManualAdScrapeJob', /enqueueManualAdScrapeJob\(\{ adUrl: cleanUrl/.test(enqueueBody));
ok('reroute happens BEFORE the search-page INSERT', enqueueBody.indexOf('isDirectLeboncoinAdUrl(cleanUrl)') < enqueueBody.indexOf("'apify_start_search_page'"));
ok('reroute is flagged in the result (reroutedAsManualAd)', /reroutedAsManualAd: true/.test(enqueueBody));
ok('reroute records a job_rerouted_direct_ad_url event', /job_rerouted_direct_ad_url/.test(enqueueBody));

console.log('\n4) claim-time self-heal (worker retypes legacy search-page jobs):');
const retypeBody = fnBody(queueSrc, 'function retypeSearchPageJobToManualAd');
ok('retype sets type = apify_start_manual_ad', /SET type = 'apify_start_manual_ad'/.test(retypeBody));
ok('retype guarded to search-page rows only', /AND type = 'apify_start_search_page'/.test(retypeBody));
ok('retype stores adUrl into input', /adUrl,/.test(retypeBody) && /retypedFrom: 'apify_start_search_page'/.test(retypeBody));
const runJobBody = workersSrc.slice(workersSrc.indexOf('async function runJob'), workersSrc.indexOf('async function loop'));
ok('worker checks isDirectLeboncoinAdUrl on claimed search-page jobs', /apify_start_search_page' && isDirectLeboncoinAdUrl\(/.test(runJobBody));
ok('worker retypes BEFORE starting the Apify run', runJobBody.indexOf('retypeSearchPageJobToManualAd') > -1 && runJobBody.indexOf('retypeSearchPageJobToManualAd') < runJobBody.indexOf('startApifyRunForJob'));

console.log('\n5) webhook recovery (mode=search_page_item fails the parent TERMINALLY):');
const itemBranch = webhookSrc.slice(webhookSrc.indexOf("mode === 'search_page_item'"), webhookSrc.indexOf("mode === 'search_page_completed'"));
ok('branch fails the parent via failApifyStartJobForUnsupportedWebhookMode', /failApifyStartJobForUnsupportedWebhookMode\(req\.body\)/.test(itemBranch));
ok('branch still returns 200 (no Apify retry storm)', /res\.status\(200\)/.test(itemBranch));
ok('branch still reports ignored + unsupported_webhook_mode', /ignored: true/.test(itemBranch) && /unsupported_webhook_mode/.test(itemBranch));
ok('branch never enqueues a payload job', !/enqueueApifyPayloadProcessingJob/.test(itemBranch));
ok('branch never throws to the caller (inner try/catch)', /catch \(failError\)/.test(itemBranch));

const failUnsupportedBody = fnBody(queueSrc, 'function failApifyStartJobForUnsupportedWebhookMode');
ok('parent is failed terminally (status+stage failed, finished_at)', /status = 'failed'/.test(failUnsupportedBody) && /stage = 'failed'/.test(failUnsupportedBody) && /finished_at = NOW\(\)/.test(failUnsupportedBody));
ok('error_code is unsupported_webhook_mode', /'unsupported_webhook_mode'/.test(failUnsupportedBody));
ok('UPDATE guarded to ACTIVE jobs only (idempotent)', /AND status = 'processing'\s*\n\s*AND stage IN \('starting_apify', 'apify_running'\)/.test(failUnsupportedBody));
ok('terminal run id never falls through to another job (run_already_terminal)', /run_already_terminal/.test(failUnsupportedBody));
ok('single-active fallback ONLY without identifiers', /!runId && urls\.length === 0/.test(failUnsupportedBody));
ok('records apify_webhook_unsupported_mode event', /apify_webhook_unsupported_mode/.test(failUnsupportedBody));

console.log('\n6) completion fallback hardened (apifyStartQueue.js):');
const completeBody = fnBody(queueSrc, 'function completeApifyStartJobForWebhook');
ok('late webhook for a terminal run cannot complete an unrelated run', /run_already_terminal/.test(completeBody));

console.log('\n7) stale recovery for jobs stuck at apify_running/40:');
ok('2h stale guard still present (apify_run_stale_no_webhook)', /'apify_run_stale_no_webhook'/.test(queueSrc));
const reconcileBody = fnBody(queueSrc, 'function reconcileActiveApifyRunStatus');
ok('reconciler exists and targets processing/apify_running jobs', /stage = 'apify_running'/.test(reconcileBody));
ok('reconciler recognises terminal Apify statuses', /SUCCEEDED/.test(queueSrc) && /TIMED-OUT/.test(queueSrc));
ok('reconciler fails finished-runs-without-webhook terminally', /'apify_run_terminal_no_webhook'/.test(reconcileBody));
ok('reconciler refreshes apify_status (no frozen READY)', /SET apify_status = \$2,/.test(reconcileBody));
ok('reconciler UPDATE guarded against webhook race', /WHERE id = \$1::bigint\s*\n\s*AND status = 'processing'/.test(reconcileBody));
ok('worker loop calls the reconciler', /reconcileActiveApifyRunStatus\(\)/.test(workersSrc));
ok('reconciler isolated in worker loop (own try/catch)', /catch \(reconcileError\)/.test(workersSrc));

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
