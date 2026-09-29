// src/services/updateMomoxPrice.js

import { saveBookFromMomoxResult } from './saveBooks.js';

const TITLE_MATCH_MIN = 0.3;
const STRONG_TITLE_MATCH_MIN = 0.85;

function normalizeTitle(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function titleSimilarity(aiTitle, momoxTitle) {
    const a = normalizeTitle(aiTitle);
    const b = normalizeTitle(momoxTitle);

    if (!a || !b) return 0;
    if (a === b || a.includes(b) || b.includes(a)) return 1;

    const stop = new Set([
        'le',
        'la',
        'les',
        'un',
        'une',
        'des',
        'de',
        'du',
        'et',
        'au',
        'aux',
        'en',
        'dans',
        'tome',
        'vol',
        'volume',
        'the',
        'of',
        'and',
    ]);

    const tokens = (text) =>
        text
            .split(' ')
            .map((word) => word.trim())
            .filter((word) => word.length >= 3 && !stop.has(word));

    const A = new Set(tokens(a));
    const B = new Set(tokens(b));

    if (!A.size || !B.size) return 0;

    let intersection = 0;

    for (const word of A) {
        if (B.has(word)) {
            intersection += 1;
        }
    }

    const union = new Set([...A, ...B]).size;

    return intersection / union;
}

function parseMomoxPrice(rawPrice) {
    if (rawPrice === null || rawPrice === undefined) {
        return null;
    }

    if (typeof rawPrice === 'number') {
        return Number.isFinite(rawPrice) ? rawPrice : null;
    }

    const cleaned = String(rawPrice)
        .replace(',', '.')
        .replace(/[^\d.]/g, '');

    const number = Number(cleaned);

    return Number.isFinite(number) ? number : null;
}

function getMomoxImageUrl(payload) {
    return (
        payload.momoxImageUrl ||
        payload.momox_image_url ||
        payload.imageUrl ||
        payload.image_url ||
        payload.coverUrl ||
        payload.cover_url ||
        null
    );
}


function getMomoxDescription(payload) {
    return (
        payload.momoxDescription ||
        payload.momox_description ||
        payload.description ||
        payload.bookDescription ||
        payload.book_description ||
        null
    );
}



export function getMomoxStatus(similarity) {
    if (similarity < TITLE_MATCH_MIN) {
        return 'momox_title_mismatch';
    }

    if (similarity < STRONG_TITLE_MATCH_MIN) {
        return 'momox_price_found_needs_review';
    }

    return 'momox_price_found';
}

function getPayloadIdentity(payload) {
    return {
        isbn: payload.isbn || payload.barcode || null,
        adsId: payload.adsId || payload.ads_id || null,
        barcode: payload.barcode || null,
        aiTitle: payload.title || payload.aiTitle || payload.ai_title || null,
        momoxTitle: payload.momoxTitle || payload.momox_title || null,
        finalUrl: String(payload.finalUrl || payload.final_url || ''),
        momoxImageUrl: getMomoxImageUrl(payload),
        momoxDescription: getMomoxDescription(payload),
        aiConfidence: payload.aiConfidence ?? payload.ai_confidence ?? null,
        isbnConfidence: payload.isbnConfidence ?? payload.isbn_confidence ?? null,
        cost: payload.cost ?? null,
    };
}

export async function updateMomoxPriceFromPayload(payload) {
    const {
        isbn,
        adsId,
        barcode,
        aiTitle,
        momoxTitle,
        finalUrl,
        momoxImageUrl,
        momoxDescription,
        aiConfidence,
        isbnConfidence,
        cost,
    } = getPayloadIdentity(payload);

    if (!adsId) {
        throw new Error('Momox payload missing adsId');
    }

    if (!isbn) {
        throw new Error('Momox payload missing isbn/barcode');
    }

    if (payload.ok !== true) {
        const row = await saveBookFromMomoxResult({
            adsId,
            isbn,
            aiTitle,
            momoxTitle,
            status: 'momox_no_price',
            aiConfidence,
            isbnConfidence,
            cost,
            momoxPrice: 0,
            momoxFinalUrl: finalUrl,
            momoxImageUrl,
            momoxTitleMatchScore: null,
            momoxRawResponse: payload,
        });

        return {
            updated: 1,
            skipped: true,
            status: 'momox_no_price',
            reason: payload.reason || payload.error || 'Momox returned ok=false',
            rows: [row],
        };
    }

    const rawPrice = payload.priceNumber ?? payload.price ?? null;
    const momoxPrice = parseMomoxPrice(rawPrice);

    if (!Number.isFinite(momoxPrice) || momoxPrice <= 0) {
        const row = await saveBookFromMomoxResult({
            adsId,
            isbn,
            aiTitle,
            momoxTitle,
            status: 'momox_no_price',
            aiConfidence,
            isbnConfidence,
            cost,
            momoxPrice: 0,
            momoxFinalUrl: finalUrl,
            momoxImageUrl,
            momoxTitleMatchScore: null,
            momoxRawResponse: payload,
        });

        return {
            updated: 1,
            skipped: true,
            status: 'momox_no_price',
            reason: `Invalid or non-positive Momox price: ${rawPrice}`,
            rows: [row],
        };
    }

    const isOfferUrl = /\/offer\//.test(finalUrl);

    if (!isOfferUrl || !momoxTitle) {
        console.warn(
            `Momox price ignored because it is not a real offer adsId=${adsId} isbn=${isbn} barcode=${barcode} price=${momoxPrice} finalUrl=${finalUrl} momoxTitle=${momoxTitle}`
        );

        const row = await saveBookFromMomoxResult({
            adsId,
            isbn,
            aiTitle,
            momoxTitle,
            status: 'momox_not_real_offer',
            aiConfidence,
            isbnConfidence,
            cost,
            momoxPrice: 0,
            momoxFinalUrl: finalUrl,
            momoxImageUrl,
            momoxTitleMatchScore: null,
            momoxRawResponse: payload,
        });

        return {
            updated: 1,
            skipped: true,
            status: 'momox_not_real_offer',
            reason: 'not_a_real_offer',
            finalUrl,
            momoxTitle,
            rows: [row],
        };
    }

    const similarity = titleSimilarity(aiTitle, momoxTitle);
    const roundedSimilarity = Number(similarity.toFixed(2));
    const status = getMomoxStatus(similarity);

    if (status === 'momox_title_mismatch') {
        console.warn(
            `Momox title mismatch adsId=${adsId} isbn=${isbn} barcode=${barcode} sim=${roundedSimilarity} ai="${aiTitle}" momox="${momoxTitle}" price=${momoxPrice}`
        );
    } else if (status === 'momox_price_found_needs_review') {
        console.warn(
            `Momox price found but needs review adsId=${adsId} isbn=${isbn} barcode=${barcode} sim=${roundedSimilarity} ai="${aiTitle}" momox="${momoxTitle}" price=${momoxPrice}`
        );
    }

    const row = await saveBookFromMomoxResult({
        adsId,
        isbn,
        aiTitle,
        momoxTitle,
        status,
        aiConfidence,
        isbnConfidence,
        cost,
        momoxPrice,
        momoxFinalUrl: finalUrl,
        momoxImageUrl,
        momoxDescription,
        momoxTitleMatchScore: roundedSimilarity,
        momoxRawResponse: payload,
    });

    return {
        updated: 1,
        status,
        similarity: roundedSimilarity,
        rows: [row],
    };
}
