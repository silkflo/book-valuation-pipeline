// src/services/catalog/catalogImageMatcher.js
//
// Catalog image matching (Phase 3, standalone). The decisive edition-verification
// step: compare a CATALOG candidate cover (AbeBooks now; ISBNSearch/ISBNdb later)
// against the Leboncoin crop of the physical book, BEFORE any provider call.
//
// Reuses the proven building blocks from the provider image verifier without
// touching it: downloadImageToBuffer + cropBookFromImage (crop the book from the
// ad photo by bbox), the OpenAI vision compare (same prompt shape + JSON schema),
// and the MATCH_STATUSES vocabulary. It does NOT read/write the DB, call
// Momox/Gibert, or use provider images.
//
// Decision: a candidate is "selected" only when the best cover is a confident,
// above-threshold visual match AND clearly beats the second-best (so two
// look-alike editions stay needs_verification rather than a wrong auto-pick).

import fs from 'fs/promises';
import dotenv from 'dotenv';

import { openai, OPENAI_MODEL } from '../openaiClient.js';
import { trackedOpenAiCall } from '../aiUsage.js';
import { downloadImageToBuffer } from '../tempImages.js';
import { cropBookFromImage } from '../bookCropper.js';
import { mapWithConcurrency } from '../scrapflyClient.js';
import { MATCH_STATUSES } from '../verifyProviderImage.js';

dotenv.config();

function num(envName, fallback) {
    const v = Number(process.env[envName]);
    return Number.isFinite(v) ? v : fallback;
}

// Decision thresholds (env-overridable).
const MIN_SIMILARITY = num('CATALOG_MATCH_MIN_SIMILARITY', 0.8); // best cover must look this alike
const MIN_CONFIDENCE = num('CATALOG_MATCH_MIN_CONFIDENCE', 0.7); // model certainty in same_book
const MIN_GAP = num('CATALOG_MATCH_MIN_GAP', 0.15);             // best must beat 2nd by this much
const NO_MATCH_SIMILARITY = num('CATALOG_MATCH_NO_MATCH_SIM', 0.45); // below this best => no_match
const MAX_COMPARE = num('CATALOG_MATCH_MAX_COMPARE', 10);
const CONCURRENCY = num('CATALOG_MATCH_CONCURRENCY', 3);
const USD_PER_CALL = num('CATALOG_IMAGE_MATCH_USD', 0.004);

export function isCatalogImageMatchEnabled() {
    return Boolean(process.env.OPENAI_API_KEY) && process.env.ENABLE_CATALOG_IMAGE_MATCH !== 'false';
}

function mapVisionToStatus({ sameBook, confidence }) {
    const c = Number(confidence);
    if (sameBook === true) {
        if (c >= 0.85) return MATCH_STATUSES.MATCH;
        if (c >= 0.6) return MATCH_STATUSES.LIKELY;
        return MATCH_STATUSES.UNCERTAIN;
    }
    if (sameBook === false) {
        if (c >= 0.6) return MATCH_STATUSES.MISMATCH;
        return MATCH_STATUSES.UNCERTAIN;
    }
    return MATCH_STATUSES.UNCERTAIN;
}

function contentTypeForPath(path) {
    if (/\.png$/i.test(path)) return 'image/png';
    if (/\.webp$/i.test(path)) return 'image/webp';
    return 'image/jpeg';
}

/**
 * Build the Leboncoin crop image input for the vision call. Accepts (in order):
 *   - cropImagePath: local file -> base64 data URL
 *   - cropSource: { sourceImageUrl, bbox, orientation } -> download + crop by bbox
 *   - cropImageUrl: http(s) URL -> passed through (OpenAI fetches it)
 * Returns { imageUrl, cropped, label } or null.
 */
export async function buildCropImageInput({ cropImagePath, cropImageUrl, cropSource } = {}) {
    if (cropImagePath) {
        const buffer = await fs.readFile(cropImagePath);
        return {
            imageUrl: `data:${contentTypeForPath(cropImagePath)};base64,${buffer.toString('base64')}`,
            cropped: false,
            label: cropImagePath,
        };
    }

    if (cropSource?.sourceImageUrl && Array.isArray(cropSource.bbox) && cropSource.bbox.length === 4) {
        try {
            const imageBuffer = await downloadImageToBuffer(cropSource.sourceImageUrl);
            const cropBuffer = await cropBookFromImage({
                imageBuffer,
                bbox: cropSource.bbox,
                orientation: cropSource.orientation,
            });
            return {
                imageUrl: `data:image/jpeg;base64,${cropBuffer.toString('base64')}`,
                cropped: true,
                label: `${cropSource.sourceImageUrl} (bbox crop)`,
            };
        } catch (error) {
            console.warn(`catalogImageMatcher: crop failed (${error?.message || error}); using full image.`);
            return { imageUrl: cropSource.sourceImageUrl, cropped: false, label: cropSource.sourceImageUrl };
        }
    }

    if (cropImageUrl) {
        return { imageUrl: cropImageUrl, cropped: false, label: cropImageUrl };
    }

    if (cropSource?.sourceImageUrl) {
        return { imageUrl: cropSource.sourceImageUrl, cropped: false, label: cropSource.sourceImageUrl };
    }

    return null;
}

/**
 * Compare the crop against ONE candidate cover. Never throws.
 * Returns { ok, sameBook, similarity, confidence, editionMatch, matchStatus, reason }.
 */
async function compareCropToCover({ cropImageUrl, coverImageUrl, detectedTitle, candidateTitle }) {
    try {
        const response = await trackedOpenAiCall({
            callSite: 'catalog_cover_verify',
            inputKind: 'multi_image',
            imageCount: 2,
            costType: 'openai_catalog_cover_verify',
            // model resolves per call site (OPENAI_CATALOG_VERIFY_MODEL -> OPENAI_MODEL), injected into create()
            fn: (model) => openai.responses.create({
            model,
            input: [
                {
                    role: 'system',
                    content: [
                        {
                            type: 'input_text',
                            text: [
                                'You compare two images of a book to decide if they are the SAME book / same edition.',
                                'Image 1 is a crop from a Leboncoin classified-ad photo (may be a spine or an angled cover, possibly lower quality or part of a pile).',
                                'Image 2 is an official catalog cover (front cover).',
                                'Judge by cover art, layout, title wording, author, series/collection and overall design.',
                                'Different editions of the same work (different cover art) are NOT the same edition: set same_book=false and say so.',
                                'visual_similarity = how alike the two covers look (1=identical art, 0=completely different).',
                                'confidence = how certain you are about the same_book verdict.',
                                'Return only JSON.',
                            ].join(' '),
                        },
                    ],
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text:
                                `Detected title (from Leboncoin): ${detectedTitle || '(unknown)'}\n` +
                                `Catalog title: ${candidateTitle || '(unknown)'}\n` +
                                'Image 1 = Leboncoin book. Image 2 = catalog cover. Same book/edition?',
                        },
                        { type: 'input_image', image_url: cropImageUrl },
                        { type: 'input_image', image_url: coverImageUrl },
                    ],
                },
            ],
            text: {
                format: {
                    type: 'json_schema',
                    name: 'catalog_image_match',
                    strict: true,
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            same_book: { type: 'boolean' },
                            confidence: { type: 'number', minimum: 0, maximum: 1 },
                            visual_similarity: { type: 'number', minimum: 0, maximum: 1 },
                            edition_match: {
                                type: 'string',
                                enum: ['same_edition', 'different_edition', 'same_work_unknown_edition', 'unknown'],
                            },
                            reason: { type: 'string' },
                        },
                        required: ['same_book', 'confidence', 'visual_similarity', 'edition_match', 'reason'],
                    },
                },
            },
            }),
        });

        const parsed = JSON.parse(response.output_text || '{}');
        const round2 = (v) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(2)) : null);

        return {
            ok: true,
            sameBook: parsed.same_book,
            similarity: round2(parsed.visual_similarity),
            confidence: round2(parsed.confidence),
            editionMatch: parsed.edition_match || null,
            matchStatus: mapVisionToStatus({ sameBook: parsed.same_book, confidence: parsed.confidence }),
            reason: String(parsed.reason || '').slice(0, 480),
        };
    } catch (error) {
        return {
            ok: false,
            sameBook: null,
            similarity: null,
            confidence: null,
            editionMatch: null,
            matchStatus: MATCH_STATUSES.NOT_CHECKED,
            reason: `Vision compare failed: ${String(error?.message || error).slice(0, 200)}`,
        };
    }
}

// Rank: comparable first, then by visual similarity, then confidence.
function rankCandidates(candidates) {
    return [...candidates].sort((a, b) => {
        const sa = Number.isFinite(a.similarity) ? a.similarity : -1;
        const sb = Number.isFinite(b.similarity) ? b.similarity : -1;
        if (sb !== sa) return sb - sa;
        return (b.confidence || 0) - (a.confidence || 0);
    });
}

function decideCatalogMatch(ranked) {
    const scored = ranked.filter((c) => Number.isFinite(c.similarity));

    if (!scored.length) {
        return { decision: 'no_match', reason: 'No candidate cover could be compared.', selectedCandidate: null };
    }

    const best = scored[0];
    const second = scored[1] || null;
    const gap = second ? Number((best.similarity - second.similarity).toFixed(2)) : 1;

    const strong =
        best.matchStatus === MATCH_STATUSES.MATCH &&
        Number(best.confidence) >= MIN_CONFIDENCE &&
        Number(best.similarity) >= MIN_SIMILARITY;
    const uniqueEnough = !second || gap >= MIN_GAP;

    if (strong && uniqueEnough) {
        return {
            decision: 'selected',
            reason: `Best cover is a confident match (similarity ${best.similarity}, confidence ${best.confidence}) and beats 2nd by ${gap}.`,
            selectedCandidate: best,
        };
    }

    if (best.similarity < NO_MATCH_SIMILARITY) {
        return {
            decision: 'no_match',
            reason: `No cover resembles the crop (best similarity ${best.similarity} < ${NO_MATCH_SIMILARITY}).`,
            selectedCandidate: null,
        };
    }

    if (strong && !uniqueEnough) {
        return {
            decision: 'needs_verification',
            reason: `Best cover matches but 2nd-best is too close (gap ${gap} < ${MIN_GAP}) — ambiguous edition.`,
            selectedCandidate: null,
        };
    }

    return {
        decision: 'needs_verification',
        reason: `Best cover is plausible but not a confident strong match (status ${best.matchStatus}, similarity ${best.similarity}, confidence ${best.confidence}).`,
        selectedCandidate: null,
    };
}

/**
 * Match AbeBooks/catalog candidates against the Leboncoin crop.
 *
 * @param {object} options
 * @param {string} [options.cropImagePath]
 * @param {string} [options.cropImageUrl]
 * @param {object} [options.cropSource]   - { sourceImageUrl, bbox, orientation }
 * @param {string} [options.detectedTitle]
 * @param {Array}  options.candidates      - from fetchAbebooksCatalogCandidates
 * @param {number} [options.maxCompare]
 * @returns {Promise<{cropImage, candidates, selectedCandidate, decision, reason, comparedCount, costUsd, ok, error}>}
 */
export async function matchCatalogCandidates({
    cropImagePath,
    cropImageUrl,
    cropSource,
    detectedTitle = null,
    candidates = [],
    maxCompare = MAX_COMPARE,
    cache = null, // optional in-run Map: never compare the same (crop, cover) pair twice per ad
} = {}) {
    const base = {
        cropImage: null,
        candidates: [],
        selectedCandidate: null,
        decision: 'no_match',
        reason: null,
        comparedCount: 0,
        costUsd: 0,
        ok: false,
        error: null,
    };

    if (!isCatalogImageMatchEnabled()) {
        return { ...base, reason: 'Catalog image match disabled (ENABLE_CATALOG_IMAGE_MATCH=false or no OPENAI_API_KEY).' };
    }

    const cropInput = await buildCropImageInput({ cropImagePath, cropImageUrl, cropSource });
    if (!cropInput) {
        return { ...base, reason: 'No crop image input (path/url/cropSource).' };
    }

    const toCompare = candidates.filter((c) => c.imageUrl).slice(0, Math.max(1, maxCompare));

    if (!toCompare.length) {
        return { ...base, cropImage: cropInput.label, reason: 'No candidates with image URLs to compare.' };
    }

    // Stable identity for THIS crop (book), so the same crop/cover pair is never
    // re-compared within one ad run (across books and the AI-ISBN fallback).
    const cropKey = cropSource
        ? `cs:${cropSource.sourceImageUrl}|${JSON.stringify(cropSource.bbox)}|${cropSource.orientation || ''}`
        : cropImageUrl ? `cu:${cropImageUrl}` : cropImagePath ? `cp:${cropImagePath}` : 'crop:?';
    const pairCache = cache instanceof Map ? cache : null;
    let cacheHits = 0;

    const results = await mapWithConcurrency(toCompare, CONCURRENCY, async (candidate) => {
        const pairKey = `${cropKey}|cover:${candidate.imageUrl}`;
        let cmp;
        if (pairCache && pairCache.has(pairKey)) {
            cmp = pairCache.get(pairKey);
            cacheHits += 1;
        } else {
            cmp = await compareCropToCover({
                cropImageUrl: cropInput.imageUrl,
                coverImageUrl: candidate.imageUrl,
                detectedTitle,
                candidateTitle: candidate.title,
            });
            if (pairCache) pairCache.set(pairKey, cmp);
        }
        return {
            isbn13: candidate.isbn13,
            title: candidate.title || null,
            author: candidate.author || null,
            publisher: candidate.publisher || null,
            year: candidate.year ?? null,
            imageUrl: candidate.imageUrl,
            listingUrl: candidate.listingUrl || null,
            matchStatus: cmp.matchStatus,
            similarity: cmp.similarity,
            confidence: cmp.confidence,
            editionMatch: cmp.editionMatch,
            reason: cmp.reason,
        };
    });

    const ranked = rankCandidates(results);
    const { decision, reason, selectedCandidate } = decideCatalogMatch(ranked);

    return {
        cropImage: cropInput.label,
        cropped: cropInput.cropped,
        candidates: ranked,
        selectedCandidate,
        decision,
        reason,
        comparedCount: toCompare.length,
        apiCalls: toCompare.length - cacheHits, // actual vision calls (cache hits excluded)
        cacheHits,
        costUsd: Number(((toCompare.length - cacheHits) * USD_PER_CALL).toFixed(4)),
        ok: true,
        error: null,
    };
}
