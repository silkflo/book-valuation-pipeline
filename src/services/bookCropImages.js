//src\services\bookCropImages.js
import path from 'node:path';
import crypto from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';

import { downloadImageToBuffer } from './tempImages.js';
import { cropBookFromImage } from './bookCropper.js';

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');
const CROP_ROOT_DIR = path.join(PUBLIC_DIR, 'uploads', 'book-crops');

function safePart(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 80);
}

function cropHash({ adsId, sourceImageUrl, imageIndex, bbox, orientation }) {
    return crypto
        .createHash('sha1')
        .update(JSON.stringify({
            adsId,
            sourceImageUrl,
            imageIndex,
            bbox,
            orientation,
        }))
        .digest('hex')
        .slice(0, 16);
}

async function fileExists(filePath) {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

function bufferHash(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
}

// Wider-context crop variants generated from the SAME source image + bbox as the
// primary crop. The primary already uses CROP_PADDING_DEFAULT (~0.15); these add
// progressively more surrounding context so admin can verify a book whose primary
// crop is too tight / shifted / shows a neighbor. padRatio is env-tunable; defaults
// are clearly wider than the primary so they are not deduped away as near-identical.
const CROP_VARIANTS = [
    {
        suffix: 'wide',
        padRatio: Number.isFinite(Number(process.env.BOOK_CROP_WIDE_PAD))
            ? Number(process.env.BOOK_CROP_WIDE_PAD)
            : 0.30,
    },
    {
        suffix: 'xwide',
        padRatio: Number.isFinite(Number(process.env.BOOK_CROP_XWIDE_PAD))
            ? Number(process.env.BOOK_CROP_XWIDE_PAD)
            : 0.50,
    },
];

const MAX_CROP_VARIANTS = 5;

export async function saveBookCropImageForUi({
    adsId,
    book,
    sourceImageUrl,
    bufferCache,
} = {}) {
    if (!adsId || !book || !sourceImageUrl) return null;

    const bbox = Array.isArray(book.bbox) ? book.bbox : null;

    if (!bbox || bbox.length !== 4) {
        return null;
    }

    const imageIndex = Number.isFinite(Number(book.image_index))
        ? Number(book.image_index)
        : 0;

    const hash = cropHash({
        adsId,
        sourceImageUrl,
        imageIndex,
        bbox,
        orientation: book.orientation || null,
    });

    const adDir = path.join(CROP_ROOT_DIR, safePart(adsId));
    const filename = `${safePart(imageIndex)}-${hash}.jpg`;
    const filePath = path.join(adDir, filename);
    const publicUrl = `/uploads/book-crops/${safePart(adsId)}/${filename}`;

    if (await fileExists(filePath)) {
        return publicUrl;
    }

    try {
        await mkdir(adDir, { recursive: true });

        if (bufferCache && !bufferCache.has(sourceImageUrl)) {
            bufferCache.set(sourceImageUrl, await downloadImageToBuffer(sourceImageUrl));
        }

        const sourceBuffer = bufferCache
            ? bufferCache.get(sourceImageUrl)
            : await downloadImageToBuffer(sourceImageUrl);

        const cropBuffer = await cropBookFromImage({
            imageBuffer: sourceBuffer,
            bbox,
            orientation: book.orientation || null,
        });

        await writeFile(filePath, cropBuffer);

        return publicUrl;
    } catch (error) {
        console.warn(
            `[ad ${adsId}] book crop image failed for "${book.title || book.isbn || 'unknown'}": ${error?.message || error}`
        );

        return null;
    }
}

// Save the primary crop PLUS 1-2 wider-context variants for one physical detected
// book, sharing the primary's stable group hash (variants only add a -wide / -xwide
// filename suffix). Returns { primaryUrl, urls } where urls[0] === primaryUrl and the
// rest are the wider variants (3-5 total). Same safety contract as the primary helper:
// invalid / tiny / whole-image bbox -> { primaryUrl: null, urls: [] }; a failed variant
// is skipped (never throws, never blocks ad processing). Near-identical variants (e.g.
// a large bbox whose padding all clamps to the full image) are deduped by output bytes.
export async function saveBookCropVariantsForUi({
    adsId,
    book,
    sourceImageUrl,
    bufferCache,
} = {}) {
    // Primary == the existing stable crop (reuses its file + all its validation).
    const primaryUrl = await saveBookCropImageForUi({ adsId, book, sourceImageUrl, bufferCache });
    if (!primaryUrl) return { primaryUrl: null, urls: [] };

    const urls = [primaryUrl];

    try {
        const bbox = Array.isArray(book.bbox) ? book.bbox : null;
        if (!bbox || bbox.length !== 4) return { primaryUrl, urls };

        const imageIndex = Number.isFinite(Number(book.image_index)) ? Number(book.image_index) : 0;
        const orientation = book.orientation || null;
        const hash = cropHash({ adsId, sourceImageUrl, imageIndex, bbox, orientation });
        const adDir = path.join(CROP_ROOT_DIR, safePart(adsId));

        const sourceBuffer = bufferCache && bufferCache.has(sourceImageUrl)
            ? bufferCache.get(sourceImageUrl)
            : await downloadImageToBuffer(sourceImageUrl);
        if (!sourceBuffer) return { primaryUrl, urls };

        // Seed dedup with the primary's content so a variant identical to it is skipped.
        const seen = new Set();
        try {
            const primaryPath = path.join(adDir, `${safePart(imageIndex)}-${hash}.jpg`);
            seen.add(bufferHash(await readFile(primaryPath)));
        } catch {
            // primary unreadable (shouldn't happen) -> dedup variants against each other only
        }

        for (const { suffix, padRatio } of CROP_VARIANTS) {
            if (urls.length >= MAX_CROP_VARIANTS) break;

            const filename = `${safePart(imageIndex)}-${hash}-${suffix}.jpg`;
            const filePath = path.join(adDir, filename);
            const publicUrl = `/uploads/book-crops/${safePart(adsId)}/${filename}`;

            try {
                if (await fileExists(filePath)) {
                    urls.push(publicUrl); // reuse stable variant from a prior run
                    continue;
                }

                const cropBuffer = await cropBookFromImage({
                    imageBuffer: sourceBuffer,
                    bbox,
                    orientation,
                    padRatio,
                });
                if (!cropBuffer || !cropBuffer.length) continue;

                const h = bufferHash(cropBuffer);
                if (seen.has(h)) continue; // near-identical to primary or another variant -> skip
                seen.add(h);

                await mkdir(adDir, { recursive: true });
                await writeFile(filePath, cropBuffer);
                urls.push(publicUrl);
            } catch (variantError) {
                console.warn(
                    `[ad ${adsId}] crop variant "${suffix}" failed for "${book.title || book.isbn || 'unknown'}": ${variantError?.message || variantError}`
                );
            }
        }
    } catch (error) {
        console.warn(
            `[ad ${adsId}] crop variants failed for "${book.title || book.isbn || 'unknown'}": ${error?.message || error}`
        );
    }

    return { primaryUrl, urls: urls.slice(0, MAX_CROP_VARIANTS) };
}
