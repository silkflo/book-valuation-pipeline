// scripts/test-lens-crop-retention.mjs
//
// OFFLINE / $0 tests for Lens crop retention + production URL resolution. Uses real fs +
// sharp (a synthetic source image), no Apify, no providers, no network. Verifies the temp
// crop folder is created (independent of DEBUG_CROPS_ENABLED), the public URL precedence,
// and that cleanup is strictly scoped to the current ad/run folder.
//
//   node scripts/test-lens-crop-retention.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Env must be set BEFORE importing the modules (read at call time, but be explicit).
process.env.LENS_PUBLIC_BASE_URL = 'https://prod-backend.example.com';
process.env.PUBLIC_WEBHOOK_BASE_URL = 'https://abcd.ngrok-free.dev';
process.env.DEBUG_CROPS_ENABLED = 'false'; // debug crops OFF; lens temp crops must still work

const { ensureLensTempCropUrl, cleanupLensTempCrops, saveBookCropDebug, isCropDebugEnabled } = await import('../src/services/cropDebug.js');
const { lensPublicBaseUrl } = await import('../src/services/lensFallback.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPLOADS = path.join(projectRoot, 'public', 'uploads');
const LENS_TEMP = path.join(UPLOADS, 'book-crops', 'lens-temp');
const DEBUG_ROOT = path.join(UPLOADS, 'book-crops', 'debug');

let pass = 0;
let fail = 0;
function ok(name, cond) {
    if (cond) { console.log(`  PASS  ${name}`); pass += 1; }
    else { console.log(`  FAIL  ${name}`); fail += 1; }
}

const SRC = await sharp({ create: { width: 240, height: 360, channels: 3, background: { r: 180, g: 140, b: 90 } } }).jpeg().toBuffer();
const BBOX = [0.1, 0.1, 0.6, 0.7];
const ADS = `RET${Date.now()}`;

try {
    console.log('public URL precedence:');
    ok('LENS_PUBLIC_BASE_URL wins over PUBLIC_WEBHOOK_BASE_URL', lensPublicBaseUrl() === 'https://prod-backend.example.com');
    delete process.env.LENS_PUBLIC_BASE_URL;
    ok('falls back to PUBLIC_WEBHOOK_BASE_URL when LENS unset', lensPublicBaseUrl() === 'https://abcd.ngrok-free.dev');
    process.env.LENS_PUBLIC_BASE_URL = 'https://prod-backend.example.com';

    console.log('\ntemp crop creation (DEBUG_CROPS_ENABLED=false):');
    const r = await ensureLensTempCropUrl({ adsId: ADS, runId: 'r1', bookIndex: 'lens-0', sourceImageBuffer: SRC, bbox: BBOX, baseUrl: lensPublicBaseUrl() });
    ok('lens temp crop still created when DEBUG off', !!r.filePath && fs.existsSync(r.filePath));
    ok('temp crop lives under lens-temp (not debug)', r.filePath.includes(path.join('book-crops', 'lens-temp')) && !r.filePath.includes(path.join('book-crops', 'debug')));
    ok('public URL uses prod base + lens-temp path', r.publicUrl === `https://prod-backend.example.com/uploads/book-crops/lens-temp/${ADS}/r1/lens-0/crop-prod.jpg`);

    ok('isCropDebugEnabled() is false', isCropDebugEnabled() === false);
    const dbg = await saveBookCropDebug({ adsId: ADS, bookIndex: 0, sourceImageBuffer: SRC, bbox: BBOX, detectedTitle: 'X' });
    ok('debug crops NOT created when DEBUG off (returns null)', dbg === null);
    ok('debug crop file NOT written when DEBUG off', !fs.existsSync(path.join(DEBUG_ROOT, ADS, '0', 'crop-prod.jpg')));

    console.log('\ncleanup is scoped + safe:');
    // sentinel proves cleanup does not touch unrelated uploads
    fs.mkdirSync(UPLOADS, { recursive: true });
    const sentinel = path.join(UPLOADS, `_retention_sentinel_${ADS}.txt`);
    fs.writeFileSync(sentinel, 'keep');

    const c = await cleanupLensTempCrops({ adsId: ADS, runId: 'r1' });
    ok('cleanup deletes the ad/run temp folder (success path)', c.deleted === true && !fs.existsSync(path.join(LENS_TEMP, ADS, 'r1')));
    ok('crop file is gone after cleanup', !fs.existsSync(r.filePath));
    ok('cleanup did NOT delete public/uploads (sentinel intact)', fs.existsSync(sentinel) && fs.existsSync(UPLOADS));

    // "actor failure" path: crop created, then cleanup runs in finally -> folder gone
    const r2 = await ensureLensTempCropUrl({ adsId: ADS, runId: 'r2', bookIndex: 'lens-0', sourceImageBuffer: SRC, bbox: BBOX, baseUrl: lensPublicBaseUrl() });
    ok('temp crop created for r2', fs.existsSync(r2.filePath));
    const c2 = await cleanupLensTempCrops({ adsId: ADS, runId: 'r2' }); // as the finally would call after a failure
    ok('cleanup after (simulated) actor failure deletes r2 folder', c2.deleted === true && !fs.existsSync(path.join(LENS_TEMP, ADS, 'r2')));

    console.log('\ncleanup refuses unsafe ids:');
    ok('empty adsId/runId refused', (await cleanupLensTempCrops({ adsId: '', runId: '' })).deleted === false);
    ok('path-traversal ids refused (no escape from lens-temp)', (await cleanupLensTempCrops({ adsId: '..', runId: '..' })).deleted === false);
    ok('public/uploads still intact after refused cleanups', fs.existsSync(UPLOADS) && fs.existsSync(sentinel));

    // tidy
    try { fs.rmSync(sentinel, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(path.join(LENS_TEMP, ADS), { recursive: true, force: true }); } catch { /* ignore */ }

    console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
} catch (error) {
    console.error('TEST CRASHED:', error);
    try { fs.rmSync(path.join(LENS_TEMP, ADS), { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(1);
}
