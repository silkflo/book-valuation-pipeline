// src/services/verifyProviderImage.js
//
// Provider IMAGE verification (Phase B). After Momox/Gibert results are
// persisted, we confirm the provider returned the SAME book/edition the
// Leboncoin photo shows — this fixes long-title / wrong-edition false matches
// (e.g. "L'Art de l'automobile" whose verified title is very long, lowering
// the text score, but whose cover image confirms the same book).
//
// Strategy:
//   - Crop the single book out of the Leboncoin ad photo using its stored bbox
//     (bookCropper); fall back to the full ad image when no bbox.
//   - Prefer the Momox cover image, else the Gibert cover image.
//   - Ask OpenAI vision whether the two images are the same book/edition.
//   - With no provider image, fall back to a title-only signal.
//
// Never throws: returns { provider_match_status, provider_image_match_score,
// provider_match_reason, provider_match_source } plus a costEvent descriptor.

import dotenv from 'dotenv';
import { openai, OPENAI_MODEL } from './openaiClient.js';
import { trackedOpenAiCall } from './aiUsage.js';
import { downloadImageToBuffer } from './tempImages.js';
import { cropBookFromImage } from './bookCropper.js';

dotenv.config();

const MATCH_STATUSES = {
    MATCH: 'match',
    LIKELY: 'likely_match',
    UNCERTAIN: 'uncertain',
    MISMATCH: 'mismatch',
    NO_IMAGE: 'no_provider_image',
    NOT_CHECKED: 'not_checked',
};

function normalizeTitle(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function isProviderImageVerifyEnabled() {
    return Boolean(process.env.OPENAI_API_KEY) && process.env.ENABLE_PROVIDER_IMAGE_VERIFY !== 'false';
}

// Choose the provider cover to compare against: Momox first, then Gibert.
function pickProviderImage({ momoxImageUrl, gibertImageUrl, momoxPrice, gibertPrice }) {
    if (momoxImageUrl) {
        return { url: momoxImageUrl, source: 'momox_image', price: momoxPrice };
    }
    if (gibertImageUrl) {
        return { url: gibertImageUrl, source: 'gibert_image', price: gibertPrice };
    }
    return { url: null, source: null, price: null };
}

async function buildLeboncoinImageInput({ sourceImageUrl, bbox, orientation, bufferCache }) {
    if (!sourceImageUrl) return null;

    const hasBbox = Array.isArray(bbox) && bbox.length === 4;

    if (!hasBbox) {
        // No localization -> send the full ad image as a URL.
        return { image_url: sourceImageUrl, cropped: false };
    }

    try {
        if (bufferCache && !bufferCache.has(sourceImageUrl)) {
            bufferCache.set(sourceImageUrl, await downloadImageToBuffer(sourceImageUrl));
        }
        const imageBuffer = bufferCache
            ? bufferCache.get(sourceImageUrl)
            : await downloadImageToBuffer(sourceImageUrl);

        const cropBuffer = await cropBookFromImage({ imageBuffer, bbox, orientation });

        return {
            image_url: `data:image/jpeg;base64,${cropBuffer.toString('base64')}`,
            cropped: true,
        };
    } catch (error) {
        console.warn(
            `verifyProviderImage: crop failed (${error?.message || error}); using full image.`
        );
        return { image_url: sourceImageUrl, cropped: false };
    }
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

// Title-only fallback when there is no provider image: cheap, non-AI signal.
function titleOnlyResult({ detectedTitle, providerTitle }) {
    const d = normalizeTitle(detectedTitle);
    const p = normalizeTitle(providerTitle);

    let score = 0;
    let reason = 'No provider image; titles unavailable.';

    if (d && p) {
        if (p === d || p.startsWith(`${d} `) || d.startsWith(`${p} `)) {
            score = 0.6;
            reason = 'No provider image; provider title contains the detected main title.';
        } else {
            const dt = new Set(d.split(' ').filter((w) => w.length > 2));
            const pt = new Set(p.split(' ').filter((w) => w.length > 2));
            const inter = [...dt].filter((w) => pt.has(w)).length;
            const denom = Math.max(dt.size, pt.size) || 1;
            score = Number((inter / denom).toFixed(2));
            reason = `No provider image; title token overlap ${score}.`;
        }
    }

    return {
        provider_match_status: MATCH_STATUSES.NO_IMAGE,
        // No provider image -> no visual similarity; the title overlap is a weak
        // textual signal only, reported separately.
        provider_image_match_score: null,
        provider_visual_similarity_score: null,
        provider_match_confidence: null,
        provider_title_overlap_score: d && p ? score : null,
        provider_match_reason: reason,
        provider_match_source: d && p ? 'title_only' : 'none',
        costEvent: null,
    };
}

/**
 * Verify a single book row against its provider result image.
 * @param {object} row - { source_image_url, bbox, orientation, detectedTitle,
 *   momox_image_url, gibert_image_url, momox_title, gibert_title, momox_price, gibert_price }
 * @param {object} [options] - { bufferCache?: Map }
 */
export async function verifyProviderImageForRow(row, options = {}) {
    if (!isProviderImageVerifyEnabled()) {
        return {
            provider_match_status: MATCH_STATUSES.NOT_CHECKED,
            provider_image_match_score: null,
            provider_visual_similarity_score: null,
            provider_match_confidence: null,
            provider_match_reason: 'Image verification disabled (ENABLE_PROVIDER_IMAGE_VERIFY=false or no OPENAI_API_KEY).',
            provider_match_source: 'none',
            costEvent: null,
        };
    }

    const provider = pickProviderImage({
        momoxImageUrl: row.momox_image_url,
        gibertImageUrl: row.gibert_image_url,
        momoxPrice: row.momox_price,
        gibertPrice: row.gibert_price,
    });

    const providerTitle =
        provider.source === 'gibert_image'
            ? row.gibert_title || row.momox_title
            : row.momox_title || row.gibert_title;

    const detectedTitle = row.detectedTitle || row.lookup_title || row.title || null;

    // No provider image -> title-only fallback (point 6).
    if (!provider.url) {
        return titleOnlyResult({ detectedTitle, providerTitle });
    }

    const leboncoinImage = await buildLeboncoinImageInput({
        sourceImageUrl: row.source_image_url,
        bbox: row.bbox,
        orientation: row.orientation,
        bufferCache: options.bufferCache,
    });

    if (!leboncoinImage) {
        // We have a provider image but no Leboncoin image to compare it to.
        return titleOnlyResult({ detectedTitle, providerTitle });
    }

    try {
        const response = await trackedOpenAiCall({
            callSite: 'provider_image_verify',
            inputKind: 'multi_image',
            imageCount: 2,
            persistCost: false, // providerImageVerifyForAd persists this call's costEvent
            // model resolves per call site (OPENAI_PROVIDER_IMAGE_VERIFY_MODEL -> OPENAI_MODEL), injected into create()
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
                                'Image 1 is a crop from a Leboncoin classified-ad photo (may be a spine or an angled cover, possibly lower quality).',
                                'Image 2 is the official catalog cover from a resale provider.',
                                'Judge by cover art, layout, title wording, author, series and overall design.',
                                'Different editions of the same work (different cover art) are NOT the same edition: set same_book=false but say so in the reason.',
                                'Account for the detected title and provider title text given. A long provider title that starts with the detected title is usually the same work.',
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
                                `Provider title: ${providerTitle || '(unknown)'}\n` +
                                'Image 1 = Leboncoin book. Image 2 = provider cover. Are they the same book/edition?',
                        },
                        { type: 'input_image', image_url: leboncoinImage.image_url },
                        { type: 'input_image', image_url: provider.url },
                    ],
                },
            ],
            text: {
                format: {
                    type: 'json_schema',
                    name: 'provider_image_match',
                    strict: true,
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            same_book: { type: 'boolean' },
                            // How CONFIDENT the model is in the same_book verdict.
                            confidence: { type: 'number', minimum: 0, maximum: 1 },
                            // How visually SIMILAR the two covers look (1=identical
                            // art, 0=completely different). Distinct from confidence:
                            // a mismatch can have low similarity but high confidence.
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
        const status = mapVisionToStatus({ sameBook: parsed.same_book, confidence: parsed.confidence });

        const round2 = (v) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(2)) : null);
        const confidence = round2(parsed.confidence);          // certainty of the verdict
        const visualSimilarity = round2(parsed.visual_similarity); // how alike the covers look

        const usdPerCall = Number(process.env.PROVIDER_IMAGE_VERIFY_USD || 0.004);

        return {
            provider_match_status: status,
            // provider_image_match_score now means SIMILARITY (high=alike), so a
            // mismatch is consistently LOW. Confidence is reported separately.
            provider_image_match_score: visualSimilarity,
            provider_visual_similarity_score: visualSimilarity,
            provider_match_confidence: confidence,
            provider_match_reason: String(parsed.reason || '').slice(0, 480),
            provider_match_source: provider.source,
            editionMatch: parsed.edition_match || null,
            leboncoinCropped: leboncoinImage.cropped,
            costEvent: {
                costType: 'provider_image_verify',
                provider: 'openai',
                amount: usdPerCall,
                currency: 'USD',
                unitCount: 1,
                unitType: 'image_compare',
                metadata: {
                    providerSource: provider.source,
                    sameBook: parsed.same_book,
                    confidence,
                    visualSimilarity,
                    editionMatch: parsed.edition_match,
                    leboncoinCropped: leboncoinImage.cropped,
                },
            },
        };
    } catch (error) {
        console.warn(`verifyProviderImage: vision call failed (${error?.message || error}).`);
        return {
            provider_match_status: MATCH_STATUSES.NOT_CHECKED,
            provider_image_match_score: null,
            provider_visual_similarity_score: null,
            provider_match_confidence: null,
            provider_match_reason: `Vision verification failed: ${String(error?.message || error).slice(0, 200)}`,
            provider_match_source: provider.source || 'none',
            costEvent: null,
        };
    }
}

export { MATCH_STATUSES };
