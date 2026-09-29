// scripts/test-book-crop-variants.mjs
//
// OFFLINE / $0 tests for multi-variant book crops (books.crop_image_urls). Uses real fs +
// sharp (a synthetic NOISE source image so different crop windows produce different bytes),
// no network, no providers. The buffer cache is pre-seeded with the source so the helper
// never calls downloadImageToBuffer.
//
// Asserts: one physical book -> 3-5 variants; primary is first and == crop_image_url;
// variants share the primary's stable group hash (only a suffix differs); URLs are stable
// across runs (reuse); invalid bbox -> no crops; near-duplicate variants are deduped; and
// candidate rows spread from the same book share the SAME crop_image_urls array.
//
//   node scripts/test-book-crop-variants.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// CROP_VARIANTS padding is read at module-eval time -> set BEFORE importing the module.
process.env.BOOK_CROP_WIDE_PAD = '0.30';
process.env.BOOK_CROP_XWIDE_PAD = '0.50';
process.env.CROP_PADDING_DEFAULT = '0.15';

const { saveBookCropVariantsForUi } = await import('../src/services/bookCropImages.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CROP_ROOT = path.join(projectRoot, 'public', 'uploads', 'book-crops');

let pass = 0;
let fail = 0;
function ok(name, cond) {
    if (cond) { console.log(`  PASS  ${name}`); pass += 1; }
    else { console.log(`  FAIL  ${name}`); fail += 1; }
}

// Gaussian-noise source: every region differs, so distinct crop windows -> distinct bytes
// (a solid-colour image would collapse all variants into one via the dedup guard).
const SRC = await sharp({
    create: { width: 320, height: 480, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } },
}).jpeg().toBuffer();
const SRC_URL = 'https://example.com/source.jpg';

const ADS = `CV${Date.now()}`;
const adDir = path.join(CROP_ROOT, ADS);

function freshCache() {
    const c = new Map();
    c.set(SRC_URL, SRC); // pre-seed -> no network download
    return c;
}

try {
    console.log('one physical book -> 3-5 variants, primary first:');
    const book = { title: 'Distinct Book', isbn: '9781111111111', image_index: 2, bbox: [0.30, 0.30, 0.55, 0.62], orientation: null };
    const r = await saveBookCropVariantsForUi({ adsId: ADS, book, sourceImageUrl: SRC_URL, bufferCache: freshCache() });

    ok('returns a primaryUrl', typeof r.primaryUrl === 'string' && r.primaryUrl.length > 0);
    ok('urls is an array of 3-5 entries', Array.isArray(r.urls) && r.urls.length >= 3 && r.urls.length <= 5);
    ok('primary is first in urls', r.urls[0] === r.primaryUrl);
    ok('all urls are relative /uploads paths', r.urls.every((u) => u.startsWith(`/uploads/book-crops/${ADS}/`)));
    ok('all urls are unique', new Set(r.urls).size === r.urls.length);

    const base = r.primaryUrl.replace(/\.jpg$/, '');
    ok('primary has no variant suffix', /\/2-[0-9a-f]{16}\.jpg$/.test(r.primaryUrl));
    ok('variants share primary group hash (+ -wide/-xwide suffix)', r.urls.slice(1).every((u) => u === `${base}-wide.jpg` || u === `${base}-xwide.jpg`));
    ok('all variant files exist on disk', r.urls.every((u) => fs.existsSync(path.join(projectRoot, 'public', u.replace(/^\/uploads/, 'uploads')))));

    console.log('\nvariant URLs are stable across runs (reuse, no duplication):');
    const r2 = await saveBookCropVariantsForUi({ adsId: ADS, book: { ...book }, sourceImageUrl: SRC_URL, bufferCache: freshCache() });
    ok('same primaryUrl on re-run', r2.primaryUrl === r.primaryUrl);
    ok('identical urls array on re-run', JSON.stringify(r2.urls) === JSON.stringify(r.urls));

    console.log('\ncandidate rows for the same physical book share the same crop set:');
    // Mirrors buildAdminCandidateRows: row objects are {...book} spreads of the resolved book.
    const resolved = { ...book, crop_image_url: r.primaryUrl, crop_image_urls: r.urls };
    const rows = [{ ...resolved, isbn: 'A' }, { ...resolved, isbn: 'B' }, { ...resolved, isbn: 'C' }];
    ok('every candidate row has the same crop_image_url', rows.every((row) => row.crop_image_url === r.primaryUrl));
    ok('every candidate row has the same crop_image_urls array (by value)', rows.every((row) => JSON.stringify(row.crop_image_urls) === JSON.stringify(r.urls)));

    console.log('\ninvalid bbox -> no crops (same contract as the primary helper):');
    const bad1 = await saveBookCropVariantsForUi({ adsId: ADS, book: { ...book, bbox: null }, sourceImageUrl: SRC_URL, bufferCache: freshCache() });
    ok('bbox=null -> { primaryUrl:null, urls:[] }', bad1.primaryUrl === null && bad1.urls.length === 0);
    const bad2 = await saveBookCropVariantsForUi({ adsId: ADS, book: { ...book, bbox: [0, 0, 1] }, sourceImageUrl: SRC_URL, bufferCache: freshCache() });
    ok('bbox length!=4 -> no crops', bad2.primaryUrl === null && bad2.urls.length === 0);
    const bad3 = await saveBookCropVariantsForUi({ adsId: ADS, book: { ...book }, sourceImageUrl: '', bufferCache: freshCache() });
    ok('missing source url -> no crops', bad3.primaryUrl === null && bad3.urls.length === 0);

    console.log('\nnear-identical variants are deduped (large bbox clamps all to full image):');
    const bigBook = { ...book, image_index: 9, bbox: [0.002, 0.002, 0.998, 0.998] };
    const big = await saveBookCropVariantsForUi({ adsId: ADS, book: bigBook, sourceImageUrl: SRC_URL, bufferCache: freshCache() });
    ok('primary still produced for near-full bbox', typeof big.primaryUrl === 'string');
    ok('wide/xwide deduped away (only the primary remains)', big.urls.length === 1 && big.urls[0] === big.primaryUrl);

    // tidy
    try { fs.rmSync(adDir, { recursive: true, force: true }); } catch { /* ignore */ }

    console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
} catch (error) {
    console.error('TEST CRASHED:', error);
    try { fs.rmSync(adDir, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(1);
}
