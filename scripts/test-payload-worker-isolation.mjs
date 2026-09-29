// scripts/test-payload-worker-isolation.mjs
//
// Guards the payload-worker isolation hardening: one bad job must not wedge the queue.
// normalizePayloadJobError is unit-tested (pure); the worker/claim/webhook invariants are
// DB-coupled (pool.query) so they are asserted at the SOURCE level.
//   node scripts/test-payload-worker-isolation.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePayloadJobError } from '../src/services/jobWorkers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n)); };

console.log('normalizePayloadJobError (pure):');
ok('default code', normalizePayloadJobError(new Error('boom')).code === 'apify_payload_processing_failed');
ok('timestamp -> invalid_payload_timestamp', normalizePayloadJobError(new Error('invalid input syntax for type timestamp: "x"')).code === 'invalid_payload_timestamp');
ok('unsupported mode -> unsupported_webhook_mode', normalizePayloadJobError(new Error('Unsupported mode search_page_item')).code === 'unsupported_webhook_mode');
ok('duplicate key -> duplicate_payload', normalizePayloadJobError(new Error('duplicate key value violates unique constraint')).code === 'duplicate_payload');
ok('timeout -> payload_processing_timeout', normalizePayloadJobError(new Error('socket timeout')).code === 'payload_processing_timeout');
ok('message truncated to 2000', normalizePayloadJobError(new Error('x'.repeat(5000))).message.length === 2000);
ok('null-safe', normalizePayloadJobError(null).code === 'apify_payload_processing_failed' && typeof normalizePayloadJobError(null).message === 'string');

const worker = read('src/services/jobWorkers.js');
const jobs = read('src/services/processingJobs.js');
const webhook = read('src/routes/apifyWebhook.js');
const startQueue = read('src/services/apifyStartQueue.js');

console.log('\nA) job-level isolation (jobWorkers.js runJob):');
ok('catch calls failPayloadJobSafely (not raw markJobFailed)', /catch \(error\)[\s\S]*?failPayloadJobSafely\(job, error\)/.test(worker));
ok('catch does NOT rethrow', !/catch \(error\)[\s\S]*?throw /.test(worker.slice(worker.indexOf('async function runJob'), worker.indexOf('async function tick'))));
ok('running is always decremented in finally', /finally \{\s*running -= 1;\s*\}/.test(worker));

console.log('\nB) safe failure helper:');
ok('failPayloadJobSafely exists', /async function failPayloadJobSafely\(job, error\)/.test(worker));
ok('progress never NULL (COALESCE(progress, 30))', /progress = COALESCE\(progress, 30\)/.test(worker));
ok('failure UPDATE guarded by status IN (queued, processing)', /WHERE id = \$1::bigint\s*\n\s*AND status IN \('queued', 'processing'\)/.test(worker));
ok('always releases lock (locked_by/locked_at NULL)', /locked_by = NULL,\s*\n\s*locked_at = NULL/.test(worker));
ok('records payload_processing_failed_isolated event', /eventType: 'payload_processing_failed_isolated'/.test(worker));
ok('event metadata has isolatedFailure + jobType + apifyRunId', /isolatedFailure: true/.test(worker) && /jobType: job\.type/.test(worker) && /apifyRunId: job\.apify_run_id/.test(worker));
ok('last-resort bare lock release on UPDATE failure', /bare lock release/.test(worker));

console.log('\nC) outer loop safety (tick):');
ok('stale-reset isolated so claiming still runs if it throws', /try \{\s*\n\s*await resetStaleProcessingJobs\(\);\s*\n\s*\} catch/.test(worker));
ok('claim loop has its own try/catch', /\} catch \(error\) \{\s*\n\s*console\.error\('\[job-worker\] claim loop failed/.test(worker));
ok('loop driven by setInterval (survives a tick throw)', /setInterval\(/.test(worker));

console.log('\nD) stale-lock requeue + maxed-out release (processingJobs.js):');
ok('requeue sets queued + clears lock + next_run_at NOW', /SET status = 'queued',[\s\S]*?locked_by = NULL,[\s\S]*?next_run_at = NOW\(\)/.test(jobs));
ok('maxed-out stale jobs are FAILED + released (attempts >= 3)', /attempts >= 3/.test(jobs) && /attempts_exhausted_stale_lock/.test(jobs));

console.log('\nE) unsupported webhook modes (apifyWebhook.js):');
ok('search_page_item ignored safely (no enqueue)', /mode === 'search_page_item'[\s\S]*?ignored: true[\s\S]*?unsupported_webhook_mode/.test(webhook));
ok('search_page_completed completes parent or ignores safely', /mode === 'search_page_completed'[\s\S]*?completeApifyStartJobForWebhook/.test(webhook));
ok('mode guard runs BEFORE enqueueApifyPayloadProcessingJob', webhook.indexOf("mode === 'search_page_item'") < webhook.indexOf('enqueueApifyPayloadProcessingJob('));
ok('unsupported modes return 200 success (no 500 / no retry storm)', /mode === 'search_page_item'[\s\S]*?res\.status\(200\)/.test(webhook));

console.log('\nF) markApifyStartJobFailedFromWebhook casts (apifyStartQueue.js):');
const failFn = startQueue.slice(startQueue.indexOf('function markApifyStartJobFailedFromWebhook'));
ok('id cast $1::bigint', /WHERE id = \$1::bigint/.test(failFn));
ok('text params cast ($2::text..$5::text)', /\$2::text/.test(failFn) && /\$3::text/.test(failFn) && /\$4::text/.test(failFn) && /\$5::text/.test(failFn));
ok('json patch cast $6::jsonb', /\$6::jsonb/.test(failFn));
ok('no leftover unused-null param ("[job.id, null,")', !failFn.includes('[job.id, null,'));

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
