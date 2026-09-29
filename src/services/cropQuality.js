// src/services/cropQuality.js
//
// Area-based crop-quality assessment for a detected book's normalized bbox.
//
// Why area-based and NOT pixel content: entropy / std-dev were calibrated on real
// debug crops (2026-06-16) and do NOT separate a table-heavy / clipped crop from a
// clean cover. A wood-grain table crop ("Mon grand livre de chiffres", a known
// false positive) scored entropy 7.05 — ABOVE a legitimate book spine (6.81) and
// near clean covers (7.41-7.68). So pixel stats are not a reliable "is this crop
// actually the book" signal. Instead:
//   * crop AREA is the cheap geometric proxy for reliability — tiny / clipped crops
//     are where bbox drift produces a wrong title/ISBN read, and
//   * the catalog cover-image match is the CONTENT check that the provider gate
//     requires before sending a poor/risky crop (a clipped table crop will not
//     strongly match the real cover; a clean small cover will).
//
// level: 'good'   (large crop  -> trust pipeline confidence; lenient send)
//        'risky'  (borderline  -> require a strong catalog cover match to send)
//        'poor'   (tiny crop    -> require a strong catalog cover match to send)
//        unknown geometry -> 'risky' (treat cautiously)

function num(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) ? v : fallback;
}

// Defaults align with classifyCrop()'s CATALOG_CROP_* thresholds so the provider
// gate (verifyCatalogForAd) and the extraction Pass-1/Pass-2 merge agree on the
// same partition by default.
const POOR_AREA = num('CROP_QUALITY_POOR_AREA', num('CATALOG_CROP_TINY_AREA', 0.05));
const GOOD_AREA = num('CROP_QUALITY_GOOD_AREA', num('CATALOG_CROP_LARGE_AREA', 0.30));

/** Normalized bbox [x0,y0,x1,y1] -> area in [0,1], or null for bad geometry. */
export function bboxArea(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return null;
    const [x0, y0, x1, y1] = bbox.map(Number);
    if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
    return Math.max(0, Math.min(1, Math.abs(x1 - x0) * Math.abs(y1 - y0)));
}

/** Assess a crop's quality from its normalized bbox (area-based). */
export function cropQualityLevel(bbox) {
    const area = bboxArea(bbox);
    if (area === null) return { level: 'risky', area: null };
    if (area < POOR_AREA) return { level: 'poor', area };
    if (area >= GOOD_AREA) return { level: 'good', area };
    return { level: 'risky', area };
}

/** Map classifyCrop()'s cropClass to the crop-quality level (single source of truth). */
export function levelFromCropClass(cropClass) {
    if (cropClass === 'large') return 'good';
    if (cropClass === 'tiny') return 'poor';
    return 'risky'; // borderline / unknown geometry
}

/** True when the crop is too unreliable to trust pipeline confidence alone. */
export function isPoorOrRiskyLevel(level) {
    return level === 'poor' || level === 'risky';
}
