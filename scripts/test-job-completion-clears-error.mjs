// scripts/test-job-completion-clears-error.mjs
//
// Regression guard for the stale-error-on-success bug: a processing job that completes
// successfully must clear error_code/error_message, while FAILED jobs must keep them.
// processingJobs/apifyStartQueue functions are DB-coupled (pool.query) with no DB-mock
// convention here, so this asserts at the SOURCE level on the relevant SQL blocks.
//   node scripts/test-job-completion-clears-error.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n)); };

// Slice a named function body out of source (up to the next top-level `export ` or EOF).
function fnBody(src, signature) {
    const start = src.indexOf(signature);
    if (start < 0) return '';
    const rest = src.slice(start + signature.length);
    const nextExport = rest.indexOf('\nexport ');
    return rest.slice(0, nextExport < 0 ? rest.length : nextExport);
}

const clearsErrors = (s) => /error_code\s*=\s*NULL/i.test(s) && /error_message\s*=\s*NULL/i.test(s);

const processingJobs = read('src/services/processingJobs.js');
const apifyStartQueue = read('src/services/apifyStartQueue.js');

console.log('processingJobs.js — markJobProcessed (apify_payload_processing SUCCESS):');
const processed = fnBody(processingJobs, 'function markJobProcessed');
ok('success path sets status = processed', /status\s*=\s*'processed'/.test(processed));
ok('success path CLEARS error_code + error_message', clearsErrors(processed));

console.log('\nprocessingJobs.js — markJobFailed (FAILURE path preserved):');
const failed = fnBody(processingJobs, 'function markJobFailed');
ok('failure path still SETS error_code from a param (not NULL)', /error_code\s*=\s*\$\d/.test(failed));
ok('failure path does NOT null error_code', !/error_code\s*=\s*NULL/i.test(failed));

console.log('\napifyStartQueue.js — completeApifyStartJobForWebhook (start SUCCESS):');
const complete = fnBody(apifyStartQueue, 'function completeApifyStartJobForWebhook');
ok('start-success sets status = processed', /status\s*=\s*'processed'/.test(complete));
ok('start-success CLEARS error_code + error_message', clearsErrors(complete));

console.log('\napifyStartQueue.js — stale/failure paths preserved:');
ok('stale guard still sets a non-null error_code', /error_code\s*=\s*'apify_run_stale_no_webhook'/.test(apifyStartQueue));
ok('a failure marker still sets error_code from a param', /error_code\s*=\s*\$\d/.test(apifyStartQueue));

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
