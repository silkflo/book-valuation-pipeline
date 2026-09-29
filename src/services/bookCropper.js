// src/services/bookCropper.js
//
// Crops a single book out of an ad image using its normalized bbox, then
// rotates / upscales / normalizes / sharpens it so the second Vision pass
// can read the spine or cover text more reliably.

import sharp from 'sharp';

// Padding around the bbox (each side). Configurable via CROP_PADDING_DEFAULT
// (default 0.15); callers may override per-call (the crop-debug variants do).
const DEFAULT_PAD_RATIO = (() => {
    const v = Number(process.env.CROP_PADDING_DEFAULT);
    return Number.isFinite(v) ? v : 0.15;
})();
const TARGET_WIDTH = 1024;

function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}

// vertical_up => rotate -90, vertical_down => rotate 90, otherwise no rotation.
function rotationForOrientation(orientation) {
    if (orientation === 'vertical_up') return -90;
    if (orientation === 'vertical_down') return 90;
    return 0;
}

export async function cropBookFromImage({ imageBuffer, bbox, orientation, padRatio } = {}) {
    const PAD_RATIO = Number.isFinite(Number(padRatio)) ? Number(padRatio) : DEFAULT_PAD_RATIO;
    const metadata = await sharp(imageBuffer, { failOn: 'none' }).metadata();
    const width = metadata.width;
    const height = metadata.height;

    if (!width || !height) {
        throw new Error('Could not read image dimensions');
    }

    let [x0, y0, x1, y1] =
        Array.isArray(bbox) && bbox.length === 4 ? bbox.map(Number) : [0, 0, 1, 1];

    if (![x0, y0, x1, y1].every((value) => Number.isFinite(value))) {
        [x0, y0, x1, y1] = [0, 0, 1, 1];
    }

    // Normalize ordering so x0<x1 and y0<y1.
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];

    // Pad generously, then clamp back into [0, 1].
    const padX = (x1 - x0) * PAD_RATIO;
    const padY = (y1 - y0) * PAD_RATIO;
    x0 = clamp01(x0 - padX);
    y0 = clamp01(y0 - padY);
    x1 = clamp01(x1 + padX);
    y1 = clamp01(y1 + padY);

    let left = Math.round(x0 * width);
    let top = Math.round(y0 * height);
    let cropWidth = Math.max(1, Math.round((x1 - x0) * width));
    let cropHeight = Math.max(1, Math.round((y1 - y0) * height));

    // Keep the extract window inside the image bounds.
    left = Math.min(left, width - 1);
    top = Math.min(top, height - 1);
    if (left + cropWidth > width) cropWidth = width - left;
    if (top + cropHeight > height) cropHeight = height - top;

    if (cropWidth < 1 || cropHeight < 1) {
        throw new Error('Computed crop region is empty');
    }

    // First pass: extract only. Doing extract and rotate in the same sharp
    // pipeline can trigger "bad extract area", so we split it into two passes.
    const cropped = await sharp(imageBuffer, { failOn: 'none' })
        .extract({ left, top, width: cropWidth, height: cropHeight })
        .toBuffer();

    // Second pass: rotate (if needed), upscale, normalize, sharpen.
    let pipeline = sharp(cropped, { failOn: 'none' });

    const rotation = rotationForOrientation(orientation);
    if (rotation !== 0) {
        pipeline = pipeline.rotate(rotation);
    }

    return pipeline
        .resize({ width: TARGET_WIDTH, withoutEnlargement: false })
        .normalize()
        .sharpen()
        .jpeg({ quality: 90 })
        .toBuffer();
}
