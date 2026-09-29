// src/services/cropDebug.js
//
// Crop debug/audit layer (no DB writes, no provider calls). For each detected
// book it persists, under public/uploads/book-crops/debug/<adsId>/<bookIndex>/:
//   source.jpg         - downscaled source image (reference)
//   overlay.jpg        - source + the bbox rectangle + "#index — title" label
//   crop-raw.jpg       - crop with NO padding
//   crop-pad10.jpg     - crop padded 10%
//   crop-pad20.jpg     - crop padded 20%
//   crop-context30.jpg - crop padded 30% (context view)
//   crop-prod.jpg      - crop at the PRODUCTION padding (CROP_PADDING_DEFAULT) —
//                        i.e. the exact crop the extraction + cover verification use
//   metadata.json      - bbox, orientation, image_index, source url, crop dims,
//                        and which crop feeds OpenAI extraction vs cover verify
//
// Gated by DEBUG_CROPS_ENABLED (default false). Files are persistent: nothing in
// the normal workflow deletes them. cleanupOldDebugCrops() is provided for an
// opt-in retention sweep (DEBUG_CROPS_KEEP_DAYS) but is NOT auto-invoked here.

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { cropBookFromImage } from './bookCropper.js';
import { downloadImageToBuffer } from './tempImages.js';

const DEBUG_ROOT = path.join(process.cwd(), 'public', 'uploads', 'book-crops', 'debug');
// TEMPORARY crops for the Google Lens fallback: created regardless of DEBUG_CROPS_ENABLED
// and deleted per ad/run after processing (see ensureLensTempCropUrl / cleanupLensTempCrops).
const LENS_TEMP_ROOT = path.join(process.cwd(), 'public', 'uploads', 'book-crops', 'lens-temp');

export function isCropDebugEnabled() {
    return process.env.DEBUG_CROPS_ENABLED === 'true';
}

function productionPadRatio() {
    const v = Number(process.env.CROP_PADDING_DEFAULT);
    return Number.isFinite(v) ? v : 0.15;
}

function safeSeg(value) {
    return String(value ?? '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) || 'unknown';
}

function escapeXml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Draw the bbox rectangle + index/title label on a downscaled copy of the source.
async function buildOverlay(imageBuffer, bbox, label) {
    const meta = await sharp(imageBuffer, { failOn: 'none' }).metadata();
    const W = meta.width || 1000;
    const H = meta.height || 1000;
    const targetW = Math.min(1200, W);
    const targetH = Math.max(1, Math.round(H * (targetW / W)));

    let [x0, y0, x1, y1] = bbox.map(Number);
    if (![x0, y0, x1, y1].every(Number.isFinite)) [x0, y0, x1, y1] = [0, 0, 1, 1];
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];

    const rx = Math.round(Math.min(Math.max(x0, 0), 1) * targetW);
    const ry = Math.round(Math.min(Math.max(y0, 0), 1) * targetH);
    const rw = Math.max(1, Math.round((x1 - x0) * targetW));
    const rh = Math.max(1, Math.round((y1 - y0) * targetH));

    const text = escapeXml(String(label).slice(0, 48));
    const labelW = Math.min(targetW - rx, 12 + text.length * 8);
    const labelY = ry > 24 ? ry - 22 : Math.min(ry + rh, targetH - 20);

    const svg = `<svg width="${targetW}" height="${targetH}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="#FF2D2D" stroke-width="4"/>
  <rect x="${rx}" y="${labelY}" width="${Math.max(1, labelW)}" height="20" fill="#FF2D2D"/>
  <text x="${rx + 5}" y="${labelY + 15}" font-family="sans-serif" font-size="14" fill="#FFFFFF">${text}</text>
</svg>`;

    return sharp(imageBuffer, { failOn: 'none' })
        .resize({ width: targetW, withoutEnlargement: true })
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .jpeg({ quality: 85 })
        .toBuffer();
}

/**
 * Persist the debug crop set for ONE detected book. Returns { dir, files,
 * cropDims } or null when disabled / inputs are unusable. Never throws — debug
 * output must not break the workflow.
 */
export async function saveBookCropDebug({
    adsId,
    bookIndex,
    sourceImageBuffer,
    sourceImageUrl = null,
    bbox,
    orientation = null,
    title = null,         // legacy fallback for the overlay label
    detectedTitle = null, // detected/visible title from the image — the overlay label
    lookupTitle = null,   // catalog/ISBNSearch title — metadata only, NEVER the overlay
    isbn = null,
    imageIndex = null,
    usedForExtraction = null,
    usedForVerification = null,
} = {}) {
    if (!isCropDebugEnabled()) return null;
    if (!sourceImageBuffer || !Array.isArray(bbox) || bbox.length !== 4) return null;

    // Overlay label = what the model DETECTED at this bbox (audit crop->book mapping).
    // Never the lookup/catalog title — that would mask a wrong-ISBN read.
    const overlayTitle = detectedTitle ?? title ?? null;

    const dir = path.join(DEBUG_ROOT, safeSeg(adsId), safeSeg(bookIndex));
    const cropDims = {};

    try {
        await fs.mkdir(dir, { recursive: true });

        const srcMeta = await sharp(sourceImageBuffer, { failOn: 'none' }).metadata();
        await fs.writeFile(
            path.join(dir, 'source.jpg'),
            await sharp(sourceImageBuffer, { failOn: 'none' })
                .resize({ width: Math.min(1200, srcMeta.width || 1200), withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer()
        );

        await fs.writeFile(path.join(dir, 'overlay.jpg'), await buildOverlay(sourceImageBuffer, bbox, `#${bookIndex} ${overlayTitle || ''}`));

        // crop-prod uses the production padding (undefined -> CROP_PADDING_DEFAULT)
        // so the file is exactly the crop extraction + verification consume.
        const variants = [
            ['crop-raw.jpg', 0],
            ['crop-pad10.jpg', 0.10],
            ['crop-pad20.jpg', 0.20],
            ['crop-context30.jpg', 0.30],
            ['crop-prod.jpg', undefined],
        ];

        for (const [name, padRatio] of variants) {
            try {
                const buf = await cropBookFromImage({ imageBuffer: sourceImageBuffer, bbox, orientation, padRatio });
                await fs.writeFile(path.join(dir, name), buf);
                const m = await sharp(buf, { failOn: 'none' }).metadata();
                cropDims[name] = `${m.width}x${m.height}`;
            } catch (error) {
                cropDims[name] = `error: ${error?.message || error}`;
            }
        }

        const metadata = {
            adsId: String(adsId),
            bookIndex,
            title: overlayTitle,              // detected/visible title (also the overlay label)
            detectedTitle: overlayTitle,      // explicit: image-detected title, never lookup
            lookupTitle: lookupTitle ?? null, // catalog/ISBNSearch title — metadata only
            isbn: isbn || null,
            bbox,
            orientation: orientation || null,
            imageIndex: imageIndex ?? null,
            sourceImageUrl: sourceImageUrl || null,
            sourceImagePx: srcMeta.width && srcMeta.height ? `${srcMeta.width}x${srcMeta.height}` : null,
            productionPadRatio: productionPadRatio(),
            cropDims,
            usedForExtraction: usedForExtraction || 'crop-prod.jpg (cropRetryWithOpenAI -> cropBookFromImage)',
            usedForVerification: usedForVerification || 'crop-prod.jpg (catalogImageMatcher -> cropBookFromImage)',
            generatedAt: new Date().toISOString(),
        };
        await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));

        return { dir, cropDims };
    } catch (error) {
        console.warn(`[crop-debug] ad=${adsId} book=${bookIndex} debug save failed: ${error?.message || error}`);
        return null;
    }
}

/**
 * Build (overwrite) the production crop for ONE book and return its PUBLIC URL under
 * the static /uploads mount — used by the Google Lens fallback to give the actor a
 * publicly-fetchable crop image. Reuses the crop-debug path convention. Always
 * regenerates so the served file matches this book's bbox. Returns { publicUrl,
 * filePath } or { publicUrl: null } when the crop cannot be produced. Never throws.
 */
export async function ensureCropProdPublicUrl({
    adsId,
    bookIndex,
    sourceImageBuffer = null,
    sourceImageUrl = null,
    bbox,
    orientation = null,
    baseUrl = process.env.LENS_PUBLIC_BASE_URL || process.env.PUBLIC_WEBHOOK_BASE_URL || '',
} = {}) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return { publicUrl: null, filePath: null };
    const adSeg = safeSeg(adsId);
    const bookSeg = safeSeg(bookIndex);
    const dir = path.join(DEBUG_ROOT, adSeg, bookSeg);
    const filePath = path.join(dir, 'crop-prod.jpg');
    const relPath = `/uploads/book-crops/debug/${adSeg}/${bookSeg}/crop-prod.jpg`;
    const publicUrl = baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}${relPath}` : relPath;
    try {
        const buf = sourceImageBuffer || (sourceImageUrl ? await downloadImageToBuffer(sourceImageUrl) : null);
        if (!buf) return { publicUrl: null, filePath: null };
        await fs.mkdir(dir, { recursive: true });
        const crop = await cropBookFromImage({ imageBuffer: buf, bbox, orientation });
        await fs.writeFile(filePath, crop);
        return { publicUrl, filePath };
    } catch (error) {
        console.warn(`[crop-debug] ensureCropProdPublicUrl failed ad=${adsId} book=${bookIndex}: ${error?.message || error}`);
        return { publicUrl: null, filePath: null };
    }
}

/**
 * Create a TEMPORARY production crop for the Lens fallback under a dedicated per-ad/run
 * path: public/uploads/book-crops/lens-temp/<adsId>/<runId>/<bookIndex>/crop-prod.jpg.
 * Always created (independent of DEBUG_CROPS_ENABLED); deleted after the ad finishes by
 * cleanupLensTempCrops. Returns { publicUrl, filePath } or { publicUrl: null }. Never throws.
 */
export async function ensureLensTempCropUrl({
    adsId,
    runId,
    bookIndex,
    sourceImageBuffer = null,
    sourceImageUrl = null,
    bbox,
    orientation = null,
    baseUrl = process.env.LENS_PUBLIC_BASE_URL || process.env.PUBLIC_WEBHOOK_BASE_URL || '',
} = {}) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return { publicUrl: null, filePath: null };
    const adSeg = safeSeg(adsId);
    const runSeg = safeSeg(runId);
    const bookSeg = safeSeg(bookIndex);
    const dir = path.join(LENS_TEMP_ROOT, adSeg, runSeg, bookSeg);
    const filePath = path.join(dir, 'crop-prod.jpg');
    const relPath = `/uploads/book-crops/lens-temp/${adSeg}/${runSeg}/${bookSeg}/crop-prod.jpg`;
    const publicUrl = baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}${relPath}` : relPath;
    try {
        const buf = sourceImageBuffer || (sourceImageUrl ? await downloadImageToBuffer(sourceImageUrl) : null);
        if (!buf) return { publicUrl: null, filePath: null };
        await fs.mkdir(dir, { recursive: true });
        const crop = await cropBookFromImage({ imageBuffer: buf, bbox, orientation });
        await fs.writeFile(filePath, crop);
        return { publicUrl, filePath };
    } catch (error) {
        console.warn(`[lens-fallback] ensureLensTempCropUrl failed ad=${adsId} book=${bookIndex}: ${error?.message || error}`);
        return { publicUrl: null, filePath: null };
    }
}

/**
 * Delete ONLY this ad/run's Lens temp crop folder (lens-temp/<adsId>/<runId>). Strictly
 * path-scoped: refuses empty/unknown ids and any path that escapes LENS_TEMP_ROOT, so it
 * can never remove unrelated uploads. Never throws. Returns { deleted, folder }.
 */
export async function cleanupLensTempCrops({ adsId, runId } = {}) {
    const adSeg = safeSeg(adsId);
    const runSeg = safeSeg(runId);
    if (!adSeg || adSeg === 'unknown' || !runSeg || runSeg === 'unknown') {
        console.warn(`[lens-fallback] cleanup skipped (bad adsId/runId) ad=${adsId} run=${runId}`);
        return { deleted: false, folder: null };
    }
    const folder = path.join(LENS_TEMP_ROOT, adSeg, runSeg);
    const rootResolved = path.resolve(LENS_TEMP_ROOT);
    const folderResolved = path.resolve(folder);
    if (folderResolved === rootResolved || !folderResolved.startsWith(rootResolved + path.sep)) {
        console.warn(`[lens-fallback] cleanup refused (path escape) folder=${folder}`);
        return { deleted: false, folder };
    }
    try {
        await fs.rm(folder, { recursive: true, force: true });
        return { deleted: true, folder };
    } catch (error) {
        console.warn(`[lens-fallback] cleanup error folder=${folder}: ${error?.message || error}`);
        return { deleted: false, folder };
    }
}

/**
 * Opt-in retention sweep: delete debug folders older than keepDays. NOT called
 * automatically (so nothing auto-deletes while DEBUG_CROPS_ENABLED=true). Skips
 * the ad currently being processed if provided.
 */
export async function cleanupOldDebugCrops({ keepDays = Number(process.env.DEBUG_CROPS_KEEP_DAYS) || 7, currentAdsId = null } = {}) {
    const cutoff = Date.now() - Math.max(0, keepDays) * 86400000;
    let removed = 0;

    let entries;
    try {
        entries = await fs.readdir(DEBUG_ROOT, { withFileTypes: true });
    } catch {
        return { removed: 0 };
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (currentAdsId && entry.name === safeSeg(currentAdsId)) continue;
        const full = path.join(DEBUG_ROOT, entry.name);
        try {
            const st = await fs.stat(full);
            if (st.mtimeMs < cutoff) {
                await fs.rm(full, { recursive: true, force: true });
                removed += 1;
            }
        } catch { /* ignore */ }
    }

    return { removed };
}
