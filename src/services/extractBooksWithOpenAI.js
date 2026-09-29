// src/services/extractBooksWithOpenAI.js

import { openai, OPENAI_MODEL } from './openaiClient.js';
import { trackedOpenAiCall, getOpenAiModelForCallSite } from './aiUsage.js';
import * as cheerio from 'cheerio';
import { mkdir, writeFile } from 'node:fs/promises';
import { runIsbnSearchLookup } from './isbnSearchLookup.js';
import {
    fetchIsbnSearchIsbnPage,
    isIsbnSearchScrapflyEnabled,
} from './isbnSearchScrapflyClient.js';
import { saveTechnicalCostEvent } from './costEvents.js';
import { cropQualityLevel } from './cropQuality.js';

function openAiInputUsdPer1M() {
    const n = Number(process.env.OPENAI_INPUT_USD_PER_1M || 0);
    return Number.isFinite(n) ? n : 0;
}

function openAiOutputUsdPer1M() {
    const n = Number(process.env.OPENAI_OUTPUT_USD_PER_1M || 0);
    return Number.isFinite(n) ? n : 0;
}

function getOpenAiUsage(response) {
    const usage = response?.usage || {};

    const inputTokens =
        Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;

    const outputTokens =
        Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;

    const totalTokens =
        Number(usage.total_tokens ?? inputTokens + outputTokens) || 0;

    return {
        inputTokens,
        outputTokens,
        totalTokens,
        rawUsage: usage,
    };
}

function estimateOpenAiUsd(response) {
    const usage = getOpenAiUsage(response);

    const inputUsd = (usage.inputTokens / 1_000_000) * openAiInputUsdPer1M();
    const outputUsd = (usage.outputTokens / 1_000_000) * openAiOutputUsdPer1M();

    return {
        ...usage,
        amountUsd: Number((inputUsd + outputUsd).toFixed(6)),
    };
}

async function saveOpenAiCostEvent({
    adsId,
    costType,
    response,
    model = OPENAI_MODEL,
    metadata = {},
}) {
    const cost = estimateOpenAiUsd(response);

    await saveTechnicalCostEvent({
        adsId,
        costType,
        provider: 'openai',
        amount: cost.amountUsd,
        amountUsd: cost.amountUsd,
        currency: 'USD',
        unitCount: cost.totalTokens,
        unitType: 'tokens',
        metadata: {
            model,
            inputTokens: cost.inputTokens,
            outputTokens: cost.outputTokens,
            totalTokens: cost.totalTokens,
            rawUsage: cost.rawUsage,
            ...metadata,
        },
    });
}
/* ============================================================================
 * Book extraction strategy
 *
 * Flow:
 * 1. OpenAI analyzes one or multiple ad images.
 * 2. OpenAI returns visible book title, raw visible text, title candidates,
 *    author, position, bbox, language hint, and confidence.
 * 3. Backend resolves ISBN using:
 *    - visible ISBN if actually seen in image
 *    - Google Books API search using multiple fuzzy title variants
 * 4. Backend validates ISBN checksum.
 * 5. Backend returns:
 *    - resolvedBooks: all detected/resolved books
 *    - validBooks: books eligible for Momox/Gibert testing
 *    - skippedBooks: books not eligible yet
 *
 * Why:
 * - AI visual reading is imperfect on small book spines.
 * - We need to keep all candidates for Phase 2 admin review.
 * - Momox/Gibert + admin validation will handle final precision.
 * ========================================================================== */

/* ------------------------------- ISBN utils -------------------------------- */

function cleanIsbn(value) {
    if (!value) return null;

    const cleaned = String(value)
        .replace(/[^0-9Xx]/g, '')
        .toUpperCase();

    return cleaned || null;
}

function isValidIsbn10(isbn) {
    if (!isbn || isbn.length !== 10) return false;

    let sum = 0;

    for (let i = 0; i < 10; i += 1) {
        const char = isbn[i];

        let value;
        if (char === 'X' && i === 9) {
            value = 10;
        } else if (/^\d$/.test(char)) {
            value = Number(char);
        } else {
            return false;
        }

        sum += value * (10 - i);
    }

    return sum % 11 === 0;
}

function isValidIsbn13(isbn) {
    if (!isbn || isbn.length !== 13 || !/^\d{13}$/.test(isbn)) {
        return false;
    }

    const sum = isbn
        .slice(0, 12)
        .split('')
        .reduce((acc, digit, index) => {
            return acc + Number(digit) * (index % 2 === 0 ? 1 : 3);
        }, 0);

    const checkDigit = (10 - (sum % 10)) % 10;

    return checkDigit === Number(isbn[12]);
}

function convertIsbn10ToIsbn13(isbn10) {
    if (!isValidIsbn10(isbn10)) return null;

    const base = `978${isbn10.slice(0, 9)}`;

    const sum = base
        .split('')
        .reduce((acc, digit, index) => {
            return acc + Number(digit) * (index % 2 === 0 ? 1 : 3);
        }, 0);

    const checkDigit = (10 - (sum % 10)) % 10;

    return `${base}${checkDigit}`;
}

function isGenericOrIncompleteTitle(title) {
    const normalized = normalizeText(title);

    // Only block known risky/incomplete titles.
    // Do NOT block every short title, because many real books have short titles:
    // "Délivrance", "Mindhunter", "Ragdoll", "Vox", etc.
    const genericTitles = new Set([
        'alex cross',
        'cupid',
        'cupidon',
    ]);

    return genericTitles.has(normalized);
}

function convertIsbn13ToIsbn10(isbn13) {
    if (!isValidIsbn13(isbn13) || !isbn13.startsWith('978')) return null;

    const core = isbn13.slice(3, 12);

    let sum = 0;
    for (let i = 0; i < 9; i += 1) {
        sum += Number(core[i]) * (10 - i);
    }

    const check = (11 - (sum % 11)) % 11;
    const checkChar = check === 10 ? 'X' : String(check);

    return `${core}${checkChar}`;
}

function normalizeBestIsbn({ isbn13, isbn10, isbn }) {
    const cleaned13 = cleanIsbn(isbn13);
    const cleaned10 = cleanIsbn(isbn10);
    const legacy = cleanIsbn(isbn);

    if (isValidIsbn13(cleaned13)) return cleaned13;
    if (isValidIsbn13(legacy)) return legacy;

    if (isValidIsbn10(cleaned10)) return convertIsbn10ToIsbn13(cleaned10);
    if (isValidIsbn10(legacy)) return convertIsbn10ToIsbn13(legacy);

    return null;
}

/* ----------------------------- text matching ------------------------------ */

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenSet(value) {
    const stopWords = new Set([
        'le',
        'la',
        'les',
        'un',
        'une',
        'des',
        'du',
        'de',
        'd',
        'l',
        'et',
        'a',
        'au',
        'aux',
        'en',
        'the',
        'of',
        'and',
    ]);

    return new Set(
        normalizeText(value)
            .split(' ')
            .map((token) => token.trim())
            .filter((token) => token.length > 1 && !stopWords.has(token))
    );
}

function mainTitlePart(value) {
    return String(value || '').split(/[:;(\[]/)[0];
}

function isSafeExpandedTitleMatch(a, b) {
    const left = normalizeText(mainTitlePart(a));
    const right = normalizeText(mainTitlePart(b));

    if (!left || !right) return false;
    if (Math.min(left.length, right.length) < 12) return false;

    if (left === right) return true;
    if (right.startsWith(`${left} `)) return true;
    if (left.startsWith(`${right} `)) return true;

    return false;
}

function tokenSimilarity(a, b) {
    const setA = tokenSet(a);
    const setB = tokenSet(b);

    if (!setA.size || !setB.size) return 0;

    let intersection = 0;
    for (const token of setA) {
        if (setB.has(token)) intersection += 1;
    }

    const strictSimilarity = intersection / Math.max(setA.size, setB.size);

    // Important: verified ISBN pages often expand a real title with a subtitle.
    // Example:
    //   "La lecture rapide"
    //   "La lecture rapide lisez plus, apprenez davantage..."
    // This must not collapse from 1.0 to 0.25.
    if (isSafeExpandedTitleMatch(a, b)) {
        return Math.max(strictSimilarity, 0.9);
    }

    // Containment is safe only when there are at least 2 meaningful tokens.
    // It helps cases where the shorter detected title is fully contained inside
    // a longer verified bibliographic title.
    const smallerSize = Math.min(setA.size, setB.size);
    const containmentSimilarity = smallerSize >= 2 ? intersection / smallerSize : 0;

    if (containmentSimilarity >= 0.85) {
        return Math.max(strictSimilarity, containmentSimilarity);
    }

    return strictSimilarity;
}

function normalizeConfidence(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) return null;

    if (number > 1 && number <= 100) {
        return Number((number / 100).toFixed(2));
    }

    if (number >= 0 && number <= 1) {
        return Number(number.toFixed(2));
    }

    return null;
}

function bestTitleForBook(book) {
    return (
        book.possible_corrected_title ||
        book.title ||
        book.raw_visible_text ||
        ''
    );
}

function dedupeDetectedBooks(books) {
    const seen = new Set();
    const deduped = [];

    for (const book of books) {
        const key = `${normalizeText(bestTitleForBook(book))}|${normalizeText(book.author)}`;

        if (!bestTitleForBook(book) || seen.has(key)) {
            continue;
        }

        seen.add(key);
        deduped.push(book);
    }

    return deduped;
}

/* --------------------------- Google Books API ----------------------------- */

function getGoogleBooksApiKey() {
    const key = process.env.GOOGLE_BOOKS_API_KEY || null;

    if (!key) {
        console.warn('GOOGLE_BOOKS_API_KEY is missing. Google Books lookup will run without a key.');
    }

    return key;
}

function extractGoogleBooksIdentifiers(volumeInfo) {
    const identifiers = Array.isArray(volumeInfo?.industryIdentifiers)
        ? volumeInfo.industryIdentifiers
        : [];

    let isbn13 = null;
    let isbn10 = null;

    for (const identifier of identifiers) {
        const type = identifier?.type;
        const value = cleanIsbn(identifier?.identifier);

        if (type === 'ISBN_13' && isValidIsbn13(value)) {
            isbn13 = value;
        }

        if (type === 'ISBN_10' && isValidIsbn10(value)) {
            isbn10 = value;
        }
    }

    const bestIsbn = normalizeBestIsbn({ isbn13, isbn10 });

    return {
        isbn: bestIsbn,
        isbn13: bestIsbn,
        isbn10: bestIsbn ? convertIsbn13ToIsbn10(bestIsbn) : null,
        rawIsbn13: isbn13,
        rawIsbn10: isbn10,
    };
}

function buildGoogleBooksQueries({
    title,
    author,
    rawVisibleText,
    possibleCorrectedTitle,
    titleCandidates,
    publisherOrCollection,
    seriesName,
}) {
    const cleanTitle = String(title || '').trim();
    const cleanAuthor = String(author || '').trim();
    const cleanRawVisibleText = String(rawVisibleText || '').trim();
    const cleanCorrectedTitle = String(possibleCorrectedTitle || '').trim();
    const cleanPublisherOrCollection = String(publisherOrCollection || '').trim();
    const cleanSeriesName = String(seriesName || '').trim();

    const candidates = Array.isArray(titleCandidates)
        ? titleCandidates.map((value) => String(value || '').trim()).filter(Boolean)
        : [];

    const titleInputs = [
        cleanCorrectedTitle,
        cleanTitle,
        cleanRawVisibleText,
        ...candidates,
    ].filter(Boolean);

    const queries = [];

    for (const titleInput of titleInputs) {
        if (titleInput && cleanAuthor) {
            queries.push(`${titleInput} ${cleanAuthor}`);
            queries.push(`intitle:${titleInput} inauthor:${cleanAuthor}`);
        }

        if (titleInput) {
            queries.push(titleInput);
            queries.push(`intitle:${titleInput}`);
        }
    }

    // Useful for cases like:
    // seriesName = "Dragon Girls"
    // rawVisibleText = "Dragon Girls Amira le dragon d'or"
    if (cleanSeriesName && cleanRawVisibleText) {
        queries.push(`${cleanSeriesName} ${cleanRawVisibleText}`);
    }

    if (cleanPublisherOrCollection && cleanTitle) {
        queries.push(`${cleanPublisherOrCollection} ${cleanTitle}`);
    }

    return Array.from(new Set(queries))
        .map((query) => query.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 12);
}

function summarizeLookupCandidates(candidates) {
    // Page 1 of ISBNSearch holds ~10 results; keep them all so multi-edition
    // exact matches survive into lookup_candidates for resale + admin review.
    return candidates.slice(0, 10).map((candidate, index) => ({
        rank: index + 1,
        isbn: candidate.isbn || null,
        isbn13: candidate.isbn13 || null,
        isbn10: candidate.isbn10 || null,
        title: candidate.googleTitle || null,
        authors: candidate.googleAuthors || null,
        publisher: candidate.publisher || null,
        publishedDate: candidate.publishedDate || null,
        language: candidate.language || null,
        score: candidate.score ?? null,
        titleSimilarity: candidate.titleSimilarity ?? null,
        rawTextSimilarity: candidate.rawTextSimilarity ?? null,
        correctedTitleSimilarity: candidate.correctedTitleSimilarity ?? null,
        bestTitleSimilarity: candidate.bestTitleSimilarity ?? null,
        authorSimilarity: candidate.authorSimilarity ?? null,
        exactTitleMatch: candidate.exactTitleMatch ?? false,
        articleInsensitiveTitleMatch: candidate.articleInsensitiveTitleMatch ?? false,
        query: candidate.query || null,
        source: candidate.source || 'google_books',
        imageUrl: candidate.isbnSearchImageUrl || null,
        resultUrl: candidate.isbnSearchUrl || null,
        selected: index === 0,
    }));
}


/* ----------------------------- ISBNSearch HTML ----------------------------- */

const isbnSearchQueryCache = new Map();
const isbnSearchIsbnCache = new Map();

// AI ISBN guesses below this confidence are NOT verified (each verification
// is a paid Scrapfly call), unless the book carries a visible ISBN fragment
// (strong signal that an ISBN really exists on the cover/spine).
const AI_ISBN_FALLBACK_MIN_CONFIDENCE = 0.3;

// Per-ad cost cap: how many books per ad may trigger AI ISBN recovery (each is
// one OpenAI call + ISBNSearch verification credits). ISBNSearch title-search
// itself is batched once per ad and bounded by ISBNSEARCH_SCRAPFLY_MAX_CALLS.
const MAX_AI_ISBN_RECOVERY_PER_AD = Math.min(
    Math.max(Number(process.env.MAX_AI_ISBN_RECOVERY_PER_AD || 8), 0),
    50
);

// The AI ISBN is never trusted directly.
// After verification on ISBNSearch, the verified title must still match the detected book.
const AI_VERIFIED_TITLE_MATCH_MIN = 0.65;

// If author exists but does not match, require a very strong title match.
const AI_VERIFIED_TITLE_MATCH_WITH_AUTHOR_MISMATCH_MIN = 0.9;

// Minimum verified lookup score before we allow the candidate to become usable.
const VERIFIED_AI_ISBN_MIN_SCORE = 0.5;

// If AI gives a checksum-valid ISBN and ISBNSearch Apify confirms the ISBN,
// we raise it enough to pass the normal Momox eligibility gate,
// but only after title/author safety checks.
const AI_VERIFIED_ISBN_ACCEPTANCE_SCORE = 0.55;

function absoluteIsbnSearchUrl(value) {
    if (!value) return null;

    const text = String(value).trim();

    if (text.startsWith('http://') || text.startsWith('https://')) {
        return text;
    }

    if (text.startsWith('/')) {
        return `https://isbnsearch.org${text}`;
    }

    return `https://isbnsearch.org/${text}`;
}


async function saveIsbnSearchDebugHtml({ query, title, html }) {
    if (process.env.DEBUG_ISBNSEARCH_HTML !== 'true') {
        return;
    }

    try {
        const dir = './debug/isbnsearch';
        await mkdir(dir, { recursive: true });

        const safeName = normalizeText(`${title || 'book'} ${query || 'query'}`)
            .replace(/\s+/g, '-')
            .slice(0, 120);

        const filePath = `${dir}/${Date.now()}-${safeName || 'empty'}.html`;

        await writeFile(filePath, html || '', 'utf8');

        console.log(`ISBNSearch debug HTML saved: ${filePath}`);
    } catch (error) {
        console.warn('Failed to save ISBNSearch debug HTML:', error?.message || error);
    }
}

function buildIsbnSearchQueries({
    title,
    author,
    rawVisibleText,
    possibleCorrectedTitle,
    titleCandidates,
    seriesName,
}) {
    const cleanTitle = String(title || '').trim();
    const cleanAuthor = String(author || '').trim();
    const cleanRawVisibleText = String(rawVisibleText || '').trim();
    const cleanCorrectedTitle = String(possibleCorrectedTitle || '').trim();
    const cleanSeriesName = String(seriesName || '').trim();

    const candidates = Array.isArray(titleCandidates)
        ? titleCandidates.map((value) => String(value || '').trim()).filter(Boolean)
        : [];

    const titleInputs = [
        cleanCorrectedTitle,
        cleanTitle,
        cleanRawVisibleText,
        ...candidates,
    ].filter(Boolean);

    const queries = [];

    for (const titleInput of titleInputs) {
        queries.push(titleInput);

        if (cleanAuthor) {
            queries.push(`${titleInput} ${cleanAuthor}`);
        }
    }

    if (cleanSeriesName && cleanRawVisibleText) {
        queries.push(`${cleanSeriesName} ${cleanRawVisibleText}`);
    }

    return Array.from(new Set(queries))
        .map((query) => query.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 6);
}

function extractFirstMeaningfulTitleFromText(text) {
    const lines = String(text || '')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

    for (const line of lines) {
        if (/^view this book$/i.test(line)) continue;
        if (/^authors?:/i.test(line)) continue;
        if (/^isbn-?13:/i.test(line)) continue;
        if (/^isbn-?10:/i.test(line)) continue;
        if (/^search results$/i.test(line)) continue;

        return line;
    }

    return null;
}

function parseIsbnSearchResults(html, queryContext) {
    const $ = cheerio.load(html);
    const candidates = [];
    const seen = new Set();

    $('li').each((_, element) => {
        const container = $(element);
        const text = container.text() || '';

        if (!/ISBN-?13:/i.test(text) && !/ISBN-?10:/i.test(text)) {
            return;
        }

        const titleLink = container.find('.bookinfo h2 a[href*="/isbn/"]').first();
        const image = container.find('.image img').first();

        const href =
            titleLink.attr('href') ||
            container.find('a[href*="/isbn/"]').first().attr('href') ||
            '';

        const isbnFromHref = cleanIsbn(href.match(/\/isbn\/([0-9Xx-]+)/)?.[1]);

        const isbn13FromText = cleanIsbn(
            text.match(/ISBN-?13:\s*([0-9Xx-]+)/i)?.[1]
        );

        const isbn10FromText = cleanIsbn(
            text.match(/ISBN-?10:\s*([0-9Xx-]+)/i)?.[1]
        );

        const bestIsbn = normalizeBestIsbn({
            isbn13: isbn13FromText,
            isbn10: isbn10FromText,
            isbn: isbnFromHref,
        });

        if (!bestIsbn || seen.has(bestIsbn)) {
            return;
        }

        seen.add(bestIsbn);

        const resultTitle =
            titleLink.text().replace(/\s+/g, ' ').trim() ||
            extractFirstMeaningfulTitleFromText(text);

        const authors =
            text.match(/Authors?:\s*([^\n\r]+)/i)?.[1]?.replace(/\s+/g, ' ').trim() ||
            text.match(/Author:\s*([^\n\r]+)/i)?.[1]?.replace(/\s+/g, ' ').trim() ||
            null;

        const imageUrl = absoluteIsbnSearchUrl(image.attr('src'));
        const resultUrl = absoluteIsbnSearchUrl(href);

        const queryTitleForScoring =
            queryContext.possibleCorrectedTitle ||
            queryContext.title ||
            queryContext.rawVisibleText ||
            '';

        const titleSimilarity = tokenSimilarity(queryTitleForScoring, resultTitle);

        const rawTextSimilarity = queryContext.rawVisibleText
            ? tokenSimilarity(queryContext.rawVisibleText, resultTitle)
            : 0;

        const correctedTitleSimilarity = queryContext.possibleCorrectedTitle
            ? tokenSimilarity(queryContext.possibleCorrectedTitle, resultTitle)
            : 0;

        const authorSimilarity = queryContext.author
            ? tokenSimilarity(queryContext.author, authors)
            : 0;

        const bestTitleSimilarity = Math.max(
            titleSimilarity,
            rawTextSimilarity,
            correctedTitleSimilarity
        );

        let score = bestTitleSimilarity * 0.8;

        if (queryContext.author) {
            score += authorSimilarity * 0.2;
        } else if (bestTitleSimilarity >= 0.9) {
            score += 0.1;
        }

        score = Math.min(1, Number(score.toFixed(2)));

        candidates.push({
            isbn: bestIsbn,
            isbn13: bestIsbn,
            isbn10: convertIsbn13ToIsbn10(bestIsbn),
            rawIsbn13: isbn13FromText || bestIsbn,
            rawIsbn10: isbn10FromText || convertIsbn13ToIsbn10(bestIsbn),

            googleTitle: resultTitle || null,
            googleAuthors: authors || null,
            publisher: null,
            publishedDate: null,
            language: null,

            isbnSearchImageUrl: imageUrl,
            isbnSearchUrl: resultUrl,

            source: 'isbnsearch',
            titleSimilarity,
            rawTextSimilarity,
            correctedTitleSimilarity,
            bestTitleSimilarity,
            authorSimilarity,
            score,
            query: queryContext.query,
        });
    });

    return candidates;
}


function parseIsbnSearchBookPage(html, queryContext, requestedIsbn) {
    const $ = cheerio.load(html);
    const pageText = $('body').text() || '';

    const isbn13FromText = cleanIsbn(
        pageText.match(/ISBN-?13:\s*([0-9Xx-]+)/i)?.[1]
    );

    const isbn10FromText = cleanIsbn(
        pageText.match(/ISBN-?10:\s*([0-9Xx-]+)/i)?.[1]
    );

    const bestIsbn = normalizeBestIsbn({
        isbn13: isbn13FromText,
        isbn10: isbn10FromText,
        isbn: requestedIsbn,
    });

    if (!bestIsbn) {
        return null;
    }

    const title =
        $('.bookinfo h1').first().text().replace(/\s+/g, ' ').trim() ||
        $('h1').first().text().replace(/\s+/g, ' ').trim() ||
        $('h2').first().text().replace(/\s+/g, ' ').trim() ||
        null;

    const authors =
        pageText.match(/Authors?:\s*([^\n\r]+)/i)?.[1]?.replace(/\s+/g, ' ').trim() ||
        pageText.match(/Author:\s*([^\n\r]+)/i)?.[1]?.replace(/\s+/g, ' ').trim() ||
        null;

    const publisher =
        pageText.match(/Publisher:\s*([^\n\r]+)/i)?.[1]?.replace(/\s+/g, ' ').trim() ||
        null;

    const publishedDate =
        pageText.match(/Published:\s*([^\n\r]+)/i)?.[1]?.replace(/\s+/g, ' ').trim() ||
        pageText.match(/Publication Date:\s*([^\n\r]+)/i)?.[1]?.replace(/\s+/g, ' ').trim() ||
        null;

    const imageUrl = absoluteIsbnSearchUrl(
        $('.image img').first().attr('src') ||
        $('img[src*="media-amazon"]').first().attr('src') ||
        $('img').first().attr('src')
    );

    const resultUrl = `https://isbnsearch.org/isbn/${bestIsbn}`;

    const queryTitleForScoring =
        queryContext.possibleCorrectedTitle ||
        queryContext.title ||
        queryContext.rawVisibleText ||
        '';

    const titleSimilarity = tokenSimilarity(queryTitleForScoring, title);
    const rawTextSimilarity = queryContext.rawVisibleText
        ? tokenSimilarity(queryContext.rawVisibleText, title)
        : 0;

    const correctedTitleSimilarity = queryContext.possibleCorrectedTitle
        ? tokenSimilarity(queryContext.possibleCorrectedTitle, title)
        : 0;

    const authorSimilarity = queryContext.author
        ? tokenSimilarity(queryContext.author, authors)
        : 0;

    const bestTitleSimilarity = Math.max(
        titleSimilarity,
        rawTextSimilarity,
        correctedTitleSimilarity
    );

    let score = bestTitleSimilarity * 0.85;

    if (queryContext.author) {
        score += authorSimilarity * 0.15;
    } else if (bestTitleSimilarity >= 0.9) {
        score += 0.1;
    }

    score = Math.min(1, Number(score.toFixed(2)));

    return {
        isbn: bestIsbn,
        isbn13: bestIsbn,
        isbn10: convertIsbn13ToIsbn10(bestIsbn),
        rawIsbn13: isbn13FromText || bestIsbn,
        rawIsbn10: isbn10FromText || convertIsbn13ToIsbn10(bestIsbn),

        googleTitle: title || null,
        googleAuthors: authors || null,
        publisher,
        publishedDate,
        language: null,

        isbnSearchImageUrl: imageUrl,
        isbnSearchUrl: resultUrl,

        source: 'ai_isbn_verified_isbnsearch',
        titleSimilarity,
        rawTextSimilarity,
        correctedTitleSimilarity,
        bestTitleSimilarity,
        authorSimilarity,
        score,
        query: `isbn:${bestIsbn}`,
    };
}

async function verifyIsbnOnIsbnSearch(isbn, queryContext) {
    const bestIsbn = normalizeBestIsbn({
        isbn13: isbn,
        isbn10: isbn,
        isbn,
    });

    if (!bestIsbn) {
        return null;
    }

    if (isbnSearchIsbnCache.has(bestIsbn)) {
        const cached = isbnSearchIsbnCache.get(bestIsbn);
        return cached;
    }

    const url = `https://isbnsearch.org/isbn/${bestIsbn}`;

    console.log(`ISBNSearch ISBN verification: ${bestIsbn}`);
    console.log(`ISBNSearch ISBN URL: ${url}`);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'text/html,application/xhtml+xml',
                'User-Agent':
                    'Mozilla/5.0 (compatible; BooksSellBot/1.0; +https://localhost)',
            },
        });

        const html = await response.text();

        if (!response.ok) {
            console.warn(
                `ISBNSearch ISBN verification failed for "${bestIsbn}" (${response.status}): ${html.slice(0, 300)}`
            );
            isbnSearchIsbnCache.set(bestIsbn, null);
            return null;
        }

        const candidate = parseIsbnSearchBookPage(html, queryContext, bestIsbn);

        if (!candidate) {
            isbnSearchIsbnCache.set(bestIsbn, null);
            return null;
        }

        console.log(
            `ISBNSearch ISBN verified ${bestIsbn}: title="${candidate.googleTitle}" score=${candidate.score}`
        );

        isbnSearchIsbnCache.set(bestIsbn, candidate);
        return candidate;
    } catch (error) {
        console.warn(
            `ISBNSearch ISBN verification error for "${bestIsbn}":`,
            error?.message || error
        );
        isbnSearchIsbnCache.set(bestIsbn, null);
        return null;
    }
}

async function searchIsbnSearch({
    title,
    author,
    rawVisibleText,
    possibleCorrectedTitle,
    titleCandidates,
    seriesName,
}) {
    const queries = buildIsbnSearchQueries({
        title,
        author,
        rawVisibleText,
        possibleCorrectedTitle,
        titleCandidates,
        seriesName,
    });

    if (!queries.length) {
        return [];
    }

    const allCandidates = [];

    for (const query of queries) {
        const cacheKey = normalizeText(query);

        if (isbnSearchQueryCache.has(cacheKey)) {
            const cached = isbnSearchQueryCache.get(cacheKey);
            allCandidates.push(...cached);
            continue;
        }

        const url = `https://isbnsearch.org/search?s=${encodeURIComponent(query)}`;

        console.log(`ISBNSearch lookup for "${title}" / "${author || ''}"`);
        console.log(`ISBNSearch query: ${query}`);
        console.log(`ISBNSearch URL: ${url}`);

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    Accept: 'text/html,application/xhtml+xml',
                    'User-Agent':
                        'Mozilla/5.0 (compatible; BooksSellBot/1.0; +https://localhost)',
                },
            });

            const html = await response.text();

            if (!response.ok) {
                console.warn(
                    `ISBNSearch lookup failed for "${title}" (${response.status}): ${html.slice(0, 300)}`
                );
                isbnSearchQueryCache.set(cacheKey, []);
                continue;
            }

            const candidates = parseIsbnSearchResults(html, {
                title,
                author,
                rawVisibleText,
                possibleCorrectedTitle,
                query,
            });


            if (!candidates.length) {
                await saveIsbnSearchDebugHtml({
                    query,
                    title,
                    html,
                });
            }

            console.log(
                `ISBNSearch result for "${title}" query="${query}": candidates=${candidates.length}`
            );

            isbnSearchQueryCache.set(cacheKey, candidates);
            allCandidates.push(...candidates);
        } catch (error) {
            console.warn(
                `ISBNSearch lookup error for "${title}":`,
                error?.message || error
            );
            isbnSearchQueryCache.set(cacheKey, []);
        }
    }

    const bestByIsbn = new Map();

    for (const candidate of allCandidates) {
        const existing = bestByIsbn.get(candidate.isbn);

        if (!existing || candidate.score > existing.score) {
            bestByIsbn.set(candidate.isbn, candidate);
        }
    }

    const finalCandidates = [...bestByIsbn.values()].sort((a, b) => b.score - a.score);

    console.log(
        `ISBNSearch final candidates for "${title}" / "${author || ''}": ${finalCandidates.length}`
    );

    if (finalCandidates.length) {
        console.log(
            JSON.stringify(
                finalCandidates.slice(0, 5).map((candidate) => ({
                    title: candidate.googleTitle,
                    authors: candidate.googleAuthors,
                    isbn: candidate.isbn,
                    score: candidate.score,
                    titleSimilarity: candidate.titleSimilarity,
                    rawTextSimilarity: candidate.rawTextSimilarity,
                    correctedTitleSimilarity: candidate.correctedTitleSimilarity,
                    bestTitleSimilarity: candidate.bestTitleSimilarity,
                    authorSimilarity: candidate.authorSimilarity,
                    query: candidate.query,
                    image: candidate.isbnSearchImageUrl,
                    url: candidate.isbnSearchUrl,
                })),
                null,
                2
            )
        );
    }

    return finalCandidates;
}


export function formatApifyIsbnSearchCandidate(candidate, queryContext) {
    const bestIsbn = normalizeBestIsbn({
        isbn13: candidate?.isbn13,
        isbn10: candidate?.isbn10,
        isbn: candidate?.isbn,
    });

    if (!bestIsbn) {
        return null;
    }

    const resultTitle = String(candidate?.title || '').replace(/\s+/g, ' ').trim();
    const authors = String(candidate?.authors || '').replace(/\s+/g, ' ').trim() || null;

    if (!resultTitle || /please verify to continue/i.test(resultTitle)) {
        return null;
    }

    const queryTitleForScoring =
        queryContext.possibleCorrectedTitle ||
        queryContext.title ||
        queryContext.rawVisibleText ||
        '';

    const titleSimilarity = tokenSimilarity(queryTitleForScoring, resultTitle);

    const rawTextSimilarity = queryContext.rawVisibleText
        ? tokenSimilarity(queryContext.rawVisibleText, resultTitle)
        : 0;

    const correctedTitleSimilarity = queryContext.possibleCorrectedTitle
        ? tokenSimilarity(queryContext.possibleCorrectedTitle, resultTitle)
        : 0;

    const authorSimilarity = queryContext.author
        ? tokenSimilarity(queryContext.author, authors)
        : 0;

    const bestTitleSimilarity = Math.max(
        titleSimilarity,
        rawTextSimilarity,
        correctedTitleSimilarity
    );

    // Exact normalized title match against any detected title variant
    // ("CHATEAUX ET CHEVALIERS" === "Châteaux et chevaliers" after
    // normalization). Article-insensitive: same meaningful tokens
    // ("Les chevaux" ~ "chevaux"). These flags drive multi-edition resale
    // candidate selection and the short-title strictness rule.
    const queryTitleVariants = [
        queryContext.possibleCorrectedTitle,
        queryContext.title,
        queryContext.rawVisibleText,
    ].filter(Boolean);

    const normalizedResultTitle = normalizeText(resultTitle);
    const resultTokenKey = sortedMeaningfulTokenKey(resultTitle);

    const exactTitleMatch = Boolean(
        normalizedResultTitle &&
        queryTitleVariants.some((variant) => normalizeText(variant) === normalizedResultTitle)
    );

    const articleInsensitiveTitleMatch = Boolean(
        !exactTitleMatch &&
        resultTokenKey &&
        queryTitleVariants.some((variant) => sortedMeaningfulTokenKey(variant) === resultTokenKey)
    );

    let score = bestTitleSimilarity * 0.8;

    if (queryContext.author) {
        score += authorSimilarity * 0.2;
    } else if (bestTitleSimilarity >= 0.9) {
        score += 0.1;
    }

    score = Math.min(1, Number(score.toFixed(2)));

    return {
        isbn: bestIsbn,
        isbn13: bestIsbn,
        isbn10: convertIsbn13ToIsbn10(bestIsbn),
        rawIsbn13: candidate?.isbn13 || bestIsbn,
        rawIsbn10: candidate?.isbn10 || convertIsbn13ToIsbn10(bestIsbn),

        googleTitle: resultTitle || null,
        googleAuthors: authors || null,
        publisher: candidate?.publisher || null,
        publishedDate: candidate?.publishedDate || null,
        language: null,

        isbnSearchImageUrl: candidate?.imageUrl || null,
        isbnSearchUrl: candidate?.resultUrl || null,

        source: candidate?.source || 'isbnsearch_apify',
        titleSimilarity,
        rawTextSimilarity,
        correctedTitleSimilarity,
        bestTitleSimilarity,
        authorSimilarity,
        exactTitleMatch,
        articleInsensitiveTitleMatch,
        score,
        query: queryContext.query,
    };
}

function searchIsbnSearchFromLookup({
    title,
    author,
    rawVisibleText,
    possibleCorrectedTitle,
    titleCandidates,
    seriesName,
    candidatesByQuery,
}) {
    if (!(candidatesByQuery instanceof Map)) {
        return [];
    }

    const queries = buildIsbnSearchQueries({
        title,
        author,
        rawVisibleText,
        possibleCorrectedTitle,
        titleCandidates,
        seriesName,
    });

    const allCandidates = [];

    for (const query of queries) {
        const queryKey = normalizeText(query);
        const rawCandidates = candidatesByQuery.get(queryKey) || [];

        for (const rawCandidate of rawCandidates) {
            const candidate = formatApifyIsbnSearchCandidate(rawCandidate, {
                title,
                author,
                rawVisibleText,
                possibleCorrectedTitle,
                query,
            });

            if (candidate) {
                allCandidates.push(candidate);
            }
        }
    }

    const bestByIsbn = new Map();

    for (const candidate of allCandidates) {
        const existing = bestByIsbn.get(candidate.isbn);

        if (!existing || candidate.score > existing.score) {
            bestByIsbn.set(candidate.isbn, candidate);
        }
    }

    const finalCandidates = [...bestByIsbn.values()].sort((a, b) => b.score - a.score);

    console.log(
        `ISBNSearch lookup final candidates for "${title}" / "${author || ''}": ${finalCandidates.length}`
    );

    if (finalCandidates.length) {
        console.log(
            JSON.stringify(
                finalCandidates.slice(0, 5).map((candidate) => ({
                    title: candidate.googleTitle,
                    authors: candidate.googleAuthors,
                    isbn: candidate.isbn,
                    score: candidate.score,
                    titleSimilarity: candidate.titleSimilarity,
                    rawTextSimilarity: candidate.rawTextSimilarity,
                    correctedTitleSimilarity: candidate.correctedTitleSimilarity,
                    bestTitleSimilarity: candidate.bestTitleSimilarity,
                    authorSimilarity: candidate.authorSimilarity,
                    query: candidate.query,
                    image: candidate.isbnSearchImageUrl,
                    url: candidate.isbnSearchUrl,
                    source: candidate.source,
                })),
                null,
                2
            )
        );
    }

    return finalCandidates;
}

/* ----------------- strict matching for short / generic titles ----------------- */

function bookQueryTitle(book) {
    return (
        book.possible_corrected_title ||
        book.title ||
        book.raw_visible_text ||
        ''
    );
}

function sortedMeaningfulTokenKey(value) {
    return [...tokenSet(value)].sort().join(' ');
}

function isShortOrGenericBookTitle(book) {
    const queryTitle = bookQueryTitle(book);

    if (isGenericOrIncompleteTitle(queryTitle)) {
        return true;
    }

    // "chevaux", "équitation", "le cirque", "cuisine", ... all collapse to a
    // single meaningful token once stopwords are removed.
    return tokenSet(queryTitle).size <= 1;
}

/**
 * ISBNSearch search behaves like a broad "contains" search, so for short or
 * generic titles ("chevaux", "le cirque", ...) page 1 is full of unrelated
 * books. Page 1 is already paid for, so we still inspect it, but ONLY:
 *   - exact normalized matches pass at full confidence
 *     ("Le cirque" detected -> every page-1 row titled exactly "Le cirque"),
 *   - article-insensitive matches pass at slightly lower confidence
 *     ("Chevaux" detected -> "Les chevaux"),
 *   - loose matches NEVER pass ("Chevaux et poneys", "Le grand livre des
 *     chevaux").
 * No reliable match -> empty list -> manual review. We never fetch page 2+.
 */
export function applyGenericTitleStrictness(book, candidates) {
    if (!Array.isArray(candidates) || !candidates.length) {
        return candidates || [];
    }

    if (!isShortOrGenericBookTitle(book)) {
        return candidates;
    }

    const queryTitle = bookQueryTitle(book);

    const strictCandidates = candidates
        .filter((candidate) => candidate.exactTitleMatch || candidate.articleInsensitiveTitleMatch)
        .map((candidate) => {
            if (candidate.exactTitleMatch) {
                return candidate;
            }

            // Article-insensitive only: keep, but mark confidence slightly lower.
            return {
                ...candidate,
                score: Math.max(0, Number(((candidate.score ?? 0) - 0.05).toFixed(2))),
            };
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    if (!strictCandidates.length) {
        console.log(
            `Generic/short title "${queryTitle}": no exact page-1 match among ${candidates.length} candidates -> needs manual review (no deeper pagination).`
        );
    } else {
        console.log(
            `Generic/short title "${queryTitle}": kept ${strictCandidates.length}/${candidates.length} exact/article-insensitive page-1 matches.`
        );
    }

    return strictCandidates;
}

/* --------------------- final ISBN verification (Scrapfly) --------------------- */

const TITLE_SEARCH_SOURCES = new Set([
    'isbnsearch',
    'isbnsearch_apify',
    'isbnsearch_scrapfly',
    'isbnsearch_candidate',
]);

/**
 * Verify the final selected ISBN against its /isbn/{isbn} page and re-score
 * the candidate against the canonical page title. Verification:
 *   - replaces snippet-derived metadata with the canonical page metadata,
 *   - lowers the score (and therefore triggers manual review downstream) when
 *     the verified title does not match the detected book,
 *   - is skipped for visible-ISBN and AI-verified candidates (those already
 *     come from an /isbn page),
 *   - never rejects on pure technical failure (the page-1 data stays).
 */
async function verifyFinalIsbnCandidate(book, candidate, adsId = null) {
    if (!candidate?.isbn) {
        return candidate;
    }

    if (process.env.ISBNSEARCH_VERIFY_FINAL === 'false') {
        return candidate;
    }

    if (!isIsbnSearchScrapflyEnabled()) {
        return candidate;
    }

    if (!TITLE_SEARCH_SOURCES.has(candidate.source)) {
        return candidate;
    }

    let verification;

    try {
        verification = await fetchIsbnSearchIsbnPage(candidate.isbn);
    } catch (error) {
        console.warn(
            `ISBN verification crashed for ${candidate.isbn} (keeping page-1 candidate):`,
            error?.message || error
        );
        return candidate;
    }

    if (verification.costEvent) {
        try {
            await saveTechnicalCostEvent({
                adsId,
                ...verification.costEvent,
            });
        } catch {
            // cost tracking must never block resolution
        }
    }

    if (!verification.ok) {
        console.warn(
            `ISBN verification failed technically for ${candidate.isbn} (keeping page-1 candidate): ${verification.reason}`
        );
        return candidate;
    }

    if (!verification.candidate) {
        // The /isbn page does not exist -> the search hit was bogus.
        console.warn(
            `ISBN verification: isbnsearch.org has no page for ${candidate.isbn}, rejecting candidate.`
        );
        return null;
    }

    const verified = formatApifyIsbnSearchCandidate(verification.candidate, {
        title: book.title,
        author: book.author,
        rawVisibleText: book.raw_visible_text,
        possibleCorrectedTitle: book.possible_corrected_title,
        query: candidate.query || `isbn:${candidate.isbn}`,
    });

    if (!verified) {
        console.warn(
            `ISBN verification: page for ${candidate.isbn} unparsable, rejecting candidate.`
        );
        return null;
    }

    verified.source = 'isbnsearch_scrapfly_verified';
    verified.verified = true;

    // Keep the search-page image if the /isbn page has none.
    if (!verified.isbnSearchImageUrl && candidate.isbnSearchImageUrl) {
        verified.isbnSearchImageUrl = candidate.isbnSearchImageUrl;
    }

    if ((verified.bestTitleSimilarity ?? 0) < (candidate.bestTitleSimilarity ?? 0)) {
        console.warn(
            `ISBN verification lowered title match for ${candidate.isbn}: ` +
            `search="${candidate.googleTitle}" (${candidate.bestTitleSimilarity}) vs ` +
            `verified="${verified.googleTitle}" (${verified.bestTitleSimilarity}).`
        );
    }

    return verified;
}

function isUsefulIsbnSearchQuery(query) {
    const normalized = normalizeText(query);

    if (!normalized) return false;

    const blocked = new Set([
        'aucune idee',
        'unknown',
        'inconnu',
        'titre inconnu',
        'je ne sais pas',
    ]);

    if (blocked.has(normalized)) return false;

    const meaningful = meaningfulTokens(query);

    return meaningful.length >= 2;
}

async function askAiForIsbnCandidates(book, adsId = null) {
    const titleContext = {
        title: book.title || '',
        rawVisibleText: book.raw_visible_text || '',
        possibleCorrectedTitle: book.possible_corrected_title || '',
        titleCandidates: Array.isArray(book.title_candidates) ? book.title_candidates : [],
        author: book.author || '',
        publisherOrCollection: book.publisher_or_collection || '',
        seriesName: book.series_name || '',
        languageHint: book.language_hint || 'unknown',
    };

    console.log(
        `AI ISBN fallback for "${titleContext.possibleCorrectedTitle || titleContext.title || titleContext.rawVisibleText}"`
    );

    const response = await trackedOpenAiCall({
        callSite: 'ai_isbn_inline',
        adsId,
        inputKind: 'text',
        imageCount: 0,
        persistCost: false, // already records its own cost event below
        // model resolves per call site (OPENAI_AI_ISBN_INLINE_MODEL -> OPENAI_MODEL), injected into create()
        fn: (model) => openai.responses.create({
        model,
        input: [
            {
                role: 'system',
                content: [
                    {
                        type: 'input_text',
                        text: [
                            'You are a bibliographic assistant.',
                            'Your task is to suggest possible ISBN candidates for a book.',
                            'Return plausible ISBNs even when you are not fully certain.',
                            'It is acceptable to return low-confidence candidates.',
                            'The backend will verify every ISBN against isbnsearch.org before using it.',
                            'Do not return explanations outside JSON.',
                        ].join(' '),
                    },
                ],
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: `
The normal ISBN title search did not produce a good usable ISBN candidate. It may have returned no result, weak results, or failed because the search provider was blocked or unavailable.

Book context:
${JSON.stringify(titleContext, null, 2)}

Return possible ISBN candidates for the exact published book.
Rules:
- Prefer ISBN-13.
- Include ISBN-10 if known.
- Candidate must correspond to the exact title/series/author, not just a similar book.
- If the visible title is a subtitle from a series, include the full likely published title.
- If uncertain, still return plausible candidates with low confidence.
- The backend will verify every ISBN, so recall is more important than precision.
- Do not explain outside JSON.
`.trim(),
                    },
                ],
            },
        ],
        text: {
            format: {
                type: 'json_schema',
                name: 'ai_isbn_candidates',
                strict: true,
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        candidates: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    title: {
                                        type: 'string',
                                    },
                                    author: {
                                        type: 'string',
                                    },
                                    isbn13: {
                                        type: 'string',
                                    },
                                    isbn10: {
                                        type: 'string',
                                    },
                                    confidence: {
                                        type: 'number',
                                        minimum: 0,
                                        maximum: 1,
                                    },
                                    reason: {
                                        type: 'string',
                                    },
                                },
                                required: [
                                    'title',
                                    'author',
                                    'isbn13',
                                    'isbn10',
                                    'confidence',
                                    'reason',
                                ],
                            },
                        },
                    },
                    required: ['candidates'],
                },
            },
        },
    }),
    });

    await saveOpenAiCostEvent({
        adsId,
        costType: 'openai_ai_isbn_fallback',
        response,
        model: getOpenAiModelForCallSite('ai_isbn_inline'),
        metadata: {
            title: book.title || null,
            rawVisibleText: book.raw_visible_text || null,
            possibleCorrectedTitle: book.possible_corrected_title || null,
        },
    });


    let parsed;
    try {
        parsed = JSON.parse(response.output_text);
    } catch (error) {
        console.warn('AI ISBN fallback JSON parse failed:', response.output_text);
        return [];
    }

    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];

    return candidates
        .map((candidate) => {
            const isbn = normalizeBestIsbn({
                isbn13: candidate.isbn13,
                isbn10: candidate.isbn10,
                isbn: candidate.isbn13 || candidate.isbn10,
            });

            return {
                title: String(candidate.title || '').trim(),
                author: String(candidate.author || '').trim(),
                isbn,
                isbn13: isbn,
                isbn10: isbn ? convertIsbn13ToIsbn10(isbn) : null,
                confidence: normalizeConfidence(candidate.confidence) ?? 0,
                reason: String(candidate.reason || '').trim(),
            };
        })
        .filter((candidate) => {
            return (
                candidate.isbn &&
                isValidIsbn13(candidate.isbn)
            );
        })
        .slice(0, 5);
}


function aiVerifiedCandidatePassesSafetyGate(candidate, aiCandidate, book) {
    const bestTitleSimilarity = Number(candidate.bestTitleSimilarity ?? 0);
    const authorSimilarity = Number(candidate.authorSimilarity ?? 0);
    const aiConfidence = normalizeConfidence(aiCandidate.confidence) ?? 0;

    const hasAnyAuthor = Boolean(
        String(book.author || '').trim() ||
        String(aiCandidate.author || '').trim()
    );

    if (aiConfidence < AI_ISBN_FALLBACK_MIN_CONFIDENCE) {
        return {
            ok: false,
            reason: `AI ISBN confidence too low: ${aiConfidence}`,
        };
    }

    if (bestTitleSimilarity < AI_VERIFIED_TITLE_MATCH_MIN) {
        return {
            ok: false,
            reason: `Verified ISBN title similarity too low: ${bestTitleSimilarity}`,
        };
    }

    if (
        hasAnyAuthor &&
        authorSimilarity === 0 &&
        bestTitleSimilarity < AI_VERIFIED_TITLE_MATCH_WITH_AUTHOR_MISMATCH_MIN
    ) {
        return {
            ok: false,
            reason:
                `Verified ISBN author mismatch and title is not strong enough: ` +
                `titleSimilarity=${bestTitleSimilarity}, authorSimilarity=${authorSimilarity}`,
        };
    }

    return {
        ok: true,
        reason: null,
    };
}

async function recoverIsbnWithAiAndVerify(book, adsId = null) {
    let aiCandidates = [];

    try {
        aiCandidates = await askAiForIsbnCandidates(book, adsId);
    } catch (error) {
        console.warn(
            `AI ISBN fallback failed for "${book.possible_corrected_title || book.title || book.raw_visible_text}":`,
            error?.message || error
        );
        return [];
    }

    if (!aiCandidates.length) {
        console.log('AI ISBN fallback returned no usable ISBN candidates.');
        return [];
    }

    // Cost guard: verifying an AI guess costs a Scrapfly call. Low-confidence
    // guesses are only worth it when a visible ISBN fragment (unvalidated
    // digits seen on the book) corroborates that a specific edition exists.
    const hasVisibleIsbnFragment = Boolean(String(book.visible_isbn || '').trim());

    const verifiableCandidates = aiCandidates.filter((candidate) => {
        const confidence = normalizeConfidence(candidate.confidence) ?? 0;
        return confidence >= AI_ISBN_FALLBACK_MIN_CONFIDENCE || hasVisibleIsbnFragment;
    });

    const skippedLowConfidence = aiCandidates.length - verifiableCandidates.length;

    if (skippedLowConfidence > 0) {
        console.log(
            `AI ISBN fallback: skipped ${skippedLowConfidence} candidate(s) below confidence ${AI_ISBN_FALLBACK_MIN_CONFIDENCE} (no visible ISBN fragment).`
        );
    }

    if (!verifiableCandidates.length) {
        return [];
    }

    const aiIsbns = Array.from(
        new Set(
            verifiableCandidates
                .map((candidate) => candidate.isbn)
                .filter(Boolean)
        )
    );

    if (!aiIsbns.length) {
        console.log('AI ISBN fallback returned no checksum-valid ISBNs.');
        return [];
    }

    console.log(
        `AI ISBN fallback candidates:`,
        JSON.stringify(
            aiCandidates.map((candidate) => ({
                title: candidate.title,
                author: candidate.author,
                isbn: candidate.isbn,
                confidence: candidate.confidence,
                reason: candidate.reason,
            })),
            null,
            2
        )
    );

    const maxAiIsbnVerifications = Math.min(
        Math.max(Number(process.env.AI_ISBN_FALLBACK_MAX_VERIFICATIONS || 5), 1),
        15
    );

    let isbnSearchLookupResult;

    try {
        // AI guesses never trigger the Apify fallback: a guessed ISBN is not
        // worth a second paid provider when Scrapfly is down.
        isbnSearchLookupResult = await runIsbnSearchLookup({
            queries: [],
            isbns: aiIsbns.slice(0, maxAiIsbnVerifications),
            maxCandidatesPerQuery: 3,
            adsId,
            allowApifyFallback: false,
        });
    } catch (error) {
        console.warn(
            `AI ISBN fallback verification via ISBNSearch failed:`,
            error?.message || error
        );
        return [];
    }

    const candidatesByIsbn =
        isbnSearchLookupResult?.candidatesByIsbn instanceof Map
            ? isbnSearchLookupResult.candidatesByIsbn
            : new Map();

    const verified = [];

    for (const aiCandidate of verifiableCandidates) {
        const rawCandidates = candidatesByIsbn.get(aiCandidate.isbn) || [];

        if (!rawCandidates.length) {
            console.warn(
                `AI ISBN candidate not verified on ISBNSearch Apify: isbn=${aiCandidate.isbn}, title="${aiCandidate.title}"`
            );
            continue;
        }

        for (const rawCandidate of rawCandidates) {
            const candidate = formatApifyIsbnSearchCandidate(rawCandidate, {
                title: book.title,
                author: book.author || aiCandidate.author,
                rawVisibleText: book.raw_visible_text,
                possibleCorrectedTitle: book.possible_corrected_title || aiCandidate.title,
                query: `isbn:${aiCandidate.isbn}`,
            });

            if (!candidate) {
                continue;
            }

            candidate.source = 'ai_isbn_verified_isbnsearch_apify';

            candidate.aiSuggestedTitle = aiCandidate.title;
            candidate.aiSuggestedAuthor = aiCandidate.author;
            candidate.aiSuggestedConfidence = aiCandidate.confidence;
            candidate.aiSuggestedReason = aiCandidate.reason;

            const safety = aiVerifiedCandidatePassesSafetyGate(candidate, aiCandidate, book);

            if (!safety.ok) {
                console.warn(
                    `AI ISBN verified candidate rejected: isbn=${candidate.isbn}, ` +
                    `verifiedTitle="${candidate.googleTitle}", aiTitle="${aiCandidate.title}", reason="${safety.reason}"`
                );
                continue;
            }

            if ((candidate.score ?? 0) < VERIFIED_AI_ISBN_MIN_SCORE) {
                console.warn(
                    `AI ISBN verified candidate rejected because verified score is too low: ` +
                    `isbn=${candidate.isbn}, verifiedTitle="${candidate.googleTitle}", score=${candidate.score}`
                );
                continue;
            }

            candidate.originalVerificationScore = candidate.score;

            // Only after checksum + ISBNSearch verification + title safety gate
            // do we raise it enough to pass the normal Momox eligibility gate.
            candidate.score = Math.max(candidate.score || 0, AI_VERIFIED_ISBN_ACCEPTANCE_SCORE);

            verified.push(candidate);
        }
    }

    const bestByIsbn = new Map();

    for (const candidate of verified) {
        const existing = bestByIsbn.get(candidate.isbn);

        if (!existing || candidate.score > existing.score) {
            bestByIsbn.set(candidate.isbn, candidate);
        }
    }

    const finalVerified = [...bestByIsbn.values()].sort((a, b) => {
        const aScore = (a.score || 0) + ((a.aiSuggestedConfidence || 0) * 0.1);
        const bScore = (b.score || 0) + ((b.aiSuggestedConfidence || 0) * 0.1);
        return bScore - aScore;
    });

    console.log(
        `AI ISBN fallback verified candidates after title safety gate: ${finalVerified.length}`
    );

    if (finalVerified.length) {
        console.log(
            JSON.stringify(
                finalVerified.slice(0, 5).map((candidate) => ({
                    title: candidate.googleTitle,
                    authors: candidate.googleAuthors,
                    isbn: candidate.isbn,
                    score: candidate.score,
                    originalVerificationScore: candidate.originalVerificationScore,
                    bestTitleSimilarity: candidate.bestTitleSimilarity,
                    authorSimilarity: candidate.authorSimilarity,
                    aiSuggestedTitle: candidate.aiSuggestedTitle,
                    aiConfidence: candidate.aiSuggestedConfidence,
                    image: candidate.isbnSearchImageUrl,
                    url: candidate.isbnSearchUrl,
                    source: candidate.source,
                })),
                null,
                2
            )
        );
    }

    return finalVerified;
}



async function searchGoogleBooks({
    title,
    author,
    rawVisibleText,
    possibleCorrectedTitle,
    titleCandidates,
    publisherOrCollection,
    seriesName,
    languageHint,
    maxResults = 10,
}) {
    const queryTitleForScoring = possibleCorrectedTitle || title || rawVisibleText;

    const queries = buildGoogleBooksQueries({
        title,
        author,
        rawVisibleText,
        possibleCorrectedTitle,
        titleCandidates,
        publisherOrCollection,
        seriesName,
    });

    if (!queries.length) {
        return [];
    }

    const apiKey = getGoogleBooksApiKey();
    const allCandidates = [];

    for (const query of queries) {
        const params = new URLSearchParams({
            q: query,
            maxResults: String(maxResults),
            printType: 'books',
        });

        // Do NOT use langRestrict for now.
        // It can remove valid translated/French editions depending on Google metadata.
        // params.set('langRestrict', 'fr');

        if (apiKey) {
            params.set('key', apiKey);
        }

        const url = `https://www.googleapis.com/books/v1/volumes?${params.toString()}`;

        const safeUrl = apiKey ? url.replace(apiKey, '***API_KEY***') : url;

        console.log(`Google Books lookup for "${title}" / "${author || ''}"`);
        console.log(`Google Books query: ${query}`);
        console.log(`Google Books URL: ${safeUrl}`);

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                },
            });

            const responseText = await response.text();

            if (!response.ok) {
                console.warn(
                    `Google Books lookup failed for "${title}" (${response.status}): ${responseText.slice(0, 500)}`
                );
                continue;
            }

            let data;
            try {
                data = JSON.parse(responseText);
            } catch (error) {
                console.warn(
                    `Google Books JSON parse failed for "${title}": ${responseText.slice(0, 500)}`
                );
                continue;
            }

            const totalItems = Number(data.totalItems || 0);
            const items = Array.isArray(data.items) ? data.items : [];

            console.log(
                `Google Books result for "${title}" query="${query}": totalItems=${totalItems}, items=${items.length}`
            );

            for (const item of items) {
                const volumeInfo = item.volumeInfo || {};
                const identifiers = extractGoogleBooksIdentifiers(volumeInfo);

                const googleTitle = volumeInfo.title || '';
                const googleSubtitle = volumeInfo.subtitle || '';
                const fullGoogleTitle = [googleTitle, googleSubtitle].filter(Boolean).join(' ');
                const googleAuthors = Array.isArray(volumeInfo.authors)
                    ? volumeInfo.authors.join(', ')
                    : '';

                const rawIdentifiers = Array.isArray(volumeInfo.industryIdentifiers)
                    ? volumeInfo.industryIdentifiers
                    : [];

                console.log(
                    `Google Books candidate: title="${fullGoogleTitle}" authors="${googleAuthors}" identifiers=${JSON.stringify(rawIdentifiers)} isbn="${identifiers.isbn || ''}"`
                );

                if (!identifiers.isbn) {
                    continue;
                }

                const titleSimilarity = tokenSimilarity(queryTitleForScoring, fullGoogleTitle);

                const rawTextSimilarity = rawVisibleText
                    ? tokenSimilarity(rawVisibleText, fullGoogleTitle)
                    : 0;

                const correctedTitleSimilarity = possibleCorrectedTitle
                    ? tokenSimilarity(possibleCorrectedTitle, fullGoogleTitle)
                    : 0;

                const authorSimilarity = author
                    ? tokenSimilarity(author, googleAuthors)
                    : 0;

                const bestTitleSimilarity = Math.max(
                    titleSimilarity,
                    rawTextSimilarity,
                    correctedTitleSimilarity
                );

                let score = bestTitleSimilarity * 0.75;

                if (author) {
                    score += authorSimilarity * 0.25;
                } else {
                    // Missing author should not block testing if the title is strong.
                    score += bestTitleSimilarity >= 0.9 ? 0.15 : 0;
                }

                // Soft preference for French editions, but do not hard reject English,
                // because some French books have English-looking series names.
                if (languageHint === 'fr' && volumeInfo.language === 'fr') {
                    score += 0.05;
                }

                score = Math.min(1, Number(score.toFixed(2)));

                allCandidates.push({
                    isbn: identifiers.isbn,
                    isbn13: identifiers.isbn13,
                    isbn10: identifiers.isbn10,
                    rawIsbn13: identifiers.rawIsbn13 || identifiers.isbn13 || null,
                    rawIsbn10: identifiers.rawIsbn10 || identifiers.isbn10 || null,
                    googleTitle: fullGoogleTitle || null,
                    googleAuthors: googleAuthors || null,
                    publisher: volumeInfo.publisher || null,
                    publishedDate: volumeInfo.publishedDate || null,
                    language: volumeInfo.language || null,
                    source: 'google_books',
                    titleSimilarity,
                    rawTextSimilarity,
                    correctedTitleSimilarity,
                    bestTitleSimilarity,
                    authorSimilarity,
                    score,
                    query,
                });
            }
        } catch (error) {
            console.warn(
                `Google Books lookup error for "${title}":`,
                error?.message || error
            );
        }
    }

    const bestByIsbn = new Map();

    for (const candidate of allCandidates) {
        const existing = bestByIsbn.get(candidate.isbn);

        if (!existing || candidate.score > existing.score) {
            bestByIsbn.set(candidate.isbn, candidate);
        }
    }

    const finalCandidates = [...bestByIsbn.values()].sort((a, b) => b.score - a.score);

    console.log(
        `Google Books final candidates for "${title}" / "${author || ''}": ${finalCandidates.length}`
    );

    if (finalCandidates.length) {
        console.log(
            JSON.stringify(
                finalCandidates.slice(0, 3).map((candidate) => ({
                    title: candidate.googleTitle,
                    authors: candidate.googleAuthors,
                    isbn: candidate.isbn,
                    score: candidate.score,
                    titleSimilarity: candidate.titleSimilarity,
                    rawTextSimilarity: candidate.rawTextSimilarity,
                    correctedTitleSimilarity: candidate.correctedTitleSimilarity,
                    bestTitleSimilarity: candidate.bestTitleSimilarity,
                    authorSimilarity: candidate.authorSimilarity,
                    query: candidate.query,
                })),
                null,
                2
            )
        );
    }

    return finalCandidates;
}

async function resolveIsbnForBook(book, options = {}) {
    const visibleIsbn = normalizeBestIsbn({
        isbn13: book.visible_isbn,
        isbn10: book.visible_isbn,
        isbn: book.visible_isbn,
    });

    if (visibleIsbn) {
        return {
            isbn: visibleIsbn,
            isbn13: visibleIsbn,
            isbn10: convertIsbn13ToIsbn10(visibleIsbn),
            source: 'visible_isbn',
            isbnConfidence: 0.98,
            lookup: {
                source: 'visible_isbn',
                googleTitle: book.possible_corrected_title || book.title || book.raw_visible_text || null,
                googleAuthors: book.author || null,
                publisher: book.publisher_or_collection || null,
                publishedDate: null,
                language: book.language_hint || null,
                query: 'visible_isbn',
                titleSimilarity: 1,
                rawTextSimilarity: 1,
                correctedTitleSimilarity: 1,
                bestTitleSimilarity: 1,
                authorSimilarity: book.author ? 1 : 0,
                score: 1,
            },
            candidates: [
                {
                    isbn: visibleIsbn,
                    isbn13: visibleIsbn,
                    isbn10: convertIsbn13ToIsbn10(visibleIsbn),
                    googleTitle: book.possible_corrected_title || book.title || book.raw_visible_text || null,
                    googleAuthors: book.author || null,
                    publisher: book.publisher_or_collection || null,
                    publishedDate: null,
                    language: book.language_hint || null,
                    query: 'visible_isbn',
                    titleSimilarity: 1,
                    rawTextSimilarity: 1,
                    correctedTitleSimilarity: 1,
                    bestTitleSimilarity: 1,
                    authorSimilarity: book.author ? 1 : 0,
                    score: 1,
                    source: 'visible_isbn',
                },
            ],
        };
    }

    let isbnSearchCandidates = [];

    if (options.isbnSearchCandidatesByQuery instanceof Map) {
        isbnSearchCandidates = searchIsbnSearchFromLookup({
            title: book.title,
            author: book.author,
            rawVisibleText: book.raw_visible_text,
            possibleCorrectedTitle: book.possible_corrected_title,
            titleCandidates: book.title_candidates,
            seriesName: book.series_name,
            candidatesByQuery: options.isbnSearchCandidatesByQuery,
        });
    } else {
        console.warn(
            `ISBNSearch lookup missing for "${book.possible_corrected_title || book.title || book.raw_visible_text}". Skipping ISBNSearch resolution.`
        );
        isbnSearchCandidates = [];
    }

    // Short/generic titles: page 1 is already paid for, but only an exact or
    // near-exact match may pass. No reliable match -> manual review.
    isbnSearchCandidates = applyGenericTitleStrictness(book, isbnSearchCandidates);

    let candidates = isbnSearchCandidates;
    let source = 'isbnsearch';

    const bestIsbnSearchScore = normalizeConfidence(isbnSearchCandidates[0]?.score) ?? 0;

    // AI fallback:
    // Run when normal title search produced no good ISBN candidate.
    // This includes:
    // - no candidates found,
    // - weak candidates below the Momox threshold,
    // - ISBNSearch Apify failed/was blocked and therefore gave no usable candidate for this book.
    //
    // AI is only used to propose ISBNs.
    // Every AI ISBN is then verified through ISBNSearch Apify ISBN mode,
    // and the verified title must match before the candidate can go to Momox.
    // Per-ad cost cap: AI ISBN recovery costs an OpenAI call + ISBNSearch
    // verification credits per book. Bound how many books per ad may trigger it.
    const adBudget = options.adBudget;
    const aiRecoveryCapReached =
        adBudget && Number(adBudget.aiRecoveryUsed || 0) >= MAX_AI_ISBN_RECOVERY_PER_AD;

    if (
        bestIsbnSearchScore < ISBN_LOOKUP_CONFIDENCE_MIN &&
        process.env.AI_ISBN_FALLBACK_ENABLED === 'true' &&
        !aiRecoveryCapReached
    ) {
        if (adBudget) adBudget.aiRecoveryUsed = Number(adBudget.aiRecoveryUsed || 0) + 1;

        const aiVerifiedCandidates = await recoverIsbnWithAiAndVerify(book, options.adsId || null);
        const bestAiVerifiedScore = normalizeConfidence(aiVerifiedCandidates[0]?.score) ?? 0;

        if (aiVerifiedCandidates.length && bestAiVerifiedScore > bestIsbnSearchScore) {
            candidates = aiVerifiedCandidates;
            source = 'ai_isbn_verified_isbnsearch';
        }
    } else if (aiRecoveryCapReached && bestIsbnSearchScore < ISBN_LOOKUP_CONFIDENCE_MIN) {
        console.log(
            `[ad ${options.adsId || '-'}] AI ISBN recovery skipped (per-ad cap ${MAX_AI_ISBN_RECOVERY_PER_AD} reached) for "${book.possible_corrected_title || book.title || ''}".`
        );
    }

    // Google Books remains disabled by default. Do not enable unless we later add
    // strict request budgets. The quota is too fragile for normal production flow.
    if (
        !candidates.length &&
        process.env.GOOGLE_BOOKS_FALLBACK_ENABLED === 'true'
    ) {
        candidates = await searchGoogleBooks({
            title: book.title,
            author: book.author,
            rawVisibleText: book.raw_visible_text,
            possibleCorrectedTitle: book.possible_corrected_title,
            titleCandidates: book.title_candidates,
            publisherOrCollection: book.publisher_or_collection,
            seriesName: book.series_name,
            languageHint: book.language_hint,
        });

        source = 'google_books';
    }

    let best = candidates[0] || null;

    if (!best) {
        return {
            isbn: null,
            isbn13: null,
            isbn10: null,
            source: 'not_found',
            isbnConfidence: 0,
            lookup: null,
            candidates: [],
        };
    }

    // Always verify the final title-search ISBN against its /isbn/{isbn} page.
    // Verified metadata replaces the search snippet; a mismatching verified
    // title lowers the score and pushes the book to manual review downstream.
    const verifiedBest = await verifyFinalIsbnCandidate(book, best, options.adsId || null);

    if (!verifiedBest) {
        return {
            isbn: null,
            isbn13: null,
            isbn10: null,
            source: 'isbnsearch_verify_rejected',
            isbnConfidence: 0,
            lookup: null,
            candidates,
        };
    }

    if (verifiedBest !== best) {
        best = verifiedBest;
        source = 'isbnsearch_verified';
        candidates = [best, ...candidates.slice(1)];
    }

    return {
        isbn: best.isbn,
        isbn13: best.isbn13,
        isbn10: best.isbn10,
        source,
        isbnConfidence: best.score,
        lookup: best,
        candidates,
    };
}

/* --------------------------- Phase 2.5 crop retry ------------------------- */

// Bounded to control cost: at most this many crops per ad, in one extra Vision call.
const CROP_RETRY_MAX = 6;

// "Weak" ISBN confidence. Below this we try a crop. Medium/strong books
// (>= this) keep their Pass-1 result and can still go to Momox.
const CROP_RETRY_WEAK_ISBN_CONF = 0.5;

function looksTruncated(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    if (value.length <= 4) return true;
    if (/[-–—…]$/.test(value)) return true; // ends mid-word / with ellipsis
    return false;
}

function onlySeriesDetected(book) {
    const series = normalizeText(book.series_name);
    if (!series) return false;

    const bestTitle = normalizeText(book.possible_corrected_title || book.title);
    if (!bestTitle) return true;

    return bestTitle === series;
}

// Decide crop retry from the ISBN-resolution RESULT, not raw vision confidence.
function shouldCropRetry(book) {
    if (book.isbn_source === 'visible_isbn') return false; // already certain
    if (!Array.isArray(book.bbox) || book.bbox.length !== 4) return false; // can't crop

    const isbnConfidence = normalizeConfidence(book.isbn_confidence) ?? 0;

    if (!book.isbn) return true; // no ISBN
    if (book.isbn_is_valid === false) return true; // invalid ISBN
    if (isbnConfidence < CROP_RETRY_WEAK_ISBN_CONF) return true; // weak score
    if (book.is_partial_or_occluded) return true; // partial / occluded
    if (looksTruncated(book.raw_visible_text)) return true; // truncated text
    if (onlySeriesDetected(book)) return true; // only series name detected

    return false;
}

// Apply a fresh Google Books resolution onto an existing resolved book object.
function assignResolutionFields(target, resolved) {
    const isbn13 = resolved.isbn13 || resolved.isbn;
    const isbn10 = resolved.isbn10 || convertIsbn13ToIsbn10(isbn13);

    target.isbn = resolved.isbn;
    target.isbn13 = isbn13;
    target.isbn10 = isbn10;
    target.isbn13_raw = resolved.lookup?.rawIsbn13 || resolved.isbn13 || null;
    target.isbn10_raw = resolved.lookup?.rawIsbn10 || resolved.isbn10 || null;
    target.isbn_is_valid = isValidIsbn13(resolved.isbn);
    target.isbn_confidence = normalizeConfidence(resolved.isbnConfidence);
    target.isbn_source = resolved.source;

    target.lookup_title = resolved.lookup?.googleTitle || null;
    target.lookup_authors = resolved.lookup?.googleAuthors || null;
    target.lookup_publisher = resolved.lookup?.publisher || null;
    target.lookup_published_date = resolved.lookup?.publishedDate || null;
    target.lookup_language = resolved.lookup?.language || null;
    target.lookup_score = resolved.lookup?.score ?? null;
    target.lookup_query = resolved.lookup?.query || null;
    target.lookup_candidates = summarizeLookupCandidates(resolved.candidates || []);

    target.title_similarity = resolved.lookup?.titleSimilarity ?? null;
    target.raw_text_similarity = resolved.lookup?.rawTextSimilarity ?? null;
    target.corrected_title_similarity = resolved.lookup?.correctedTitleSimilarity ?? null;
    target.best_title_similarity = resolved.lookup?.bestTitleSimilarity ?? null;
    target.author_similarity = resolved.lookup?.authorSimilarity ?? null;
}

function pickBetterText(oldText, newText) {
    const a = String(oldText || '').trim();
    const b = String(newText || '').trim();

    if (!b) return { value: a || null, changed: false };
    if (!a) return { value: b, changed: true };
    if (b.length > a.length + 2) return { value: b, changed: true };

    return { value: a, changed: false };
}



function meaningfulTokens(value) {
    const stopWords = new Set([
        'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'l',
        'et', 'a', 'au', 'aux', 'en', 'the', 'of', 'and',
    ]);

    return normalizeText(value)
        .split(' ')
        .map((token) => token.trim())
        .filter((token) => token.length > 2 && !stopWords.has(token));
}

function countSharedMeaningfulTokens(a, b) {
    const tokensA = new Set(meaningfulTokens(a));
    const tokensB = new Set(meaningfulTokens(b));

    let count = 0;
    for (const token of tokensA) {
        if (tokensB.has(token)) count += 1;
    }

    return count;
}

function cropTextForComparison(crop) {
    return [
        crop.rawVisibleText,
        crop.possibleCorrectedTitle,
        ...(Array.isArray(crop.titleCandidates) ? crop.titleCandidates : []),
        crop.seriesName,
    ]
        .filter(Boolean)
        .join(' ');
}

function bookTextForComparison(book) {
    return [
        book.raw_visible_text,
        book.possible_corrected_title,
        book.title,
        book.series_name,
    ]
        .filter(Boolean)
        .join(' ');
}

function isCropCompatibleWithBook(book, crop) {
    const bookText = bookTextForComparison(book);
    const cropText = cropTextForComparison(crop);

    if (!cropText) return false;
    if (!bookText) return true;

    const similarity = tokenSimilarity(bookText, cropText);
    const sharedTokens = countSharedMeaningfulTokens(bookText, cropText);

    if (similarity >= 0.35) return true;
    if (sharedTokens >= 2) return true;

    return false;
}

function clearLookupResolution(book) {
    book.isbn = null;
    book.isbn13 = null;
    book.isbn10 = null;
    book.isbn13_raw = null;
    book.isbn10_raw = null;
    book.isbn_is_valid = false;
    book.isbn_confidence = 0;
    book.isbn_source = 'not_found';

    book.lookup_title = null;
    book.lookup_authors = null;
    book.lookup_publisher = null;
    book.lookup_published_date = null;
    book.lookup_language = null;
    book.lookup_score = null;
    book.lookup_query = null;
    book.lookup_candidates = [];

    book.title_similarity = null;
    book.raw_text_similarity = null;
    book.corrected_title_similarity = null;
    book.best_title_similarity = null;
    book.author_similarity = null;
}

// Merge Pass-2 crop reading into the book. Returns true if text materially changed.
function mergeCropResultIntoBook(book, crop) {
    let changed = false;

    const rawMerge = pickBetterText(book.raw_visible_text, crop.rawVisibleText);
    if (rawMerge.changed) {
        book.raw_visible_text = rawMerge.value;
        changed = true;
    }

    const titleMerge = pickBetterText(book.possible_corrected_title, crop.possibleCorrectedTitle);
    if (titleMerge.changed) {
        book.possible_corrected_title = titleMerge.value;
        changed = true;
    }

    // Merge title candidates (union, deduped, capped).
    const existing = Array.isArray(book.title_candidates) ? book.title_candidates : [];
    const incoming = [
        ...(crop.possibleCorrectedTitle ? [crop.possibleCorrectedTitle] : []),
        ...(Array.isArray(crop.titleCandidates) ? crop.titleCandidates : []),
    ];

    const merged = [];
    const seen = new Set();
    for (const candidate of [...existing, ...incoming]) {
        const value = String(candidate || '').trim();
        const key = normalizeText(value);
        if (!value || seen.has(key)) continue;
        seen.add(key);
        merged.push(value);
    }

    if (merged.length > existing.length) {
        changed = true;
    }
    book.title_candidates = merged.slice(0, 6);

    if (!book.author && crop.author) {
        book.author = crop.author;
        changed = true;
    }

    if (!book.series_name && crop.seriesName) {
        book.series_name = crop.seriesName;
    }

    return changed;
}

// Lazy + safe load so a missing/broken `sharp` never crashes Pass 1.
let cropRetryModulePromise = null;
function loadCropRetryModule() {
    if (!cropRetryModulePromise) {
        cropRetryModulePromise = import('./cropRetryWithOpenAI.js');
    }
    return cropRetryModulePromise;
}

async function runCropRetryPass(adsId, imageUrls, resolvedBooks, resolveOptions = {}) {
    const flagged = resolvedBooks
        .map((book, index) => ({ book, index }))
        .filter(({ book }) => shouldCropRetry(book))
        .slice(0, CROP_RETRY_MAX);

    console.log(`Ad ${adsId}: crop retry — ${flagged.length} book(s) flagged for crop retry.`);

    if (!flagged.length) {
        return;
    }

    let cropRetryBooks;
    try {
        ({ cropRetryBooks } = await loadCropRetryModule());
    } catch (error) {
        console.error(
            `Ad ${adsId}: crop retry disabled (could not load image module):`,
            error?.message || error
        );
        return;
    }

    let cropResult;
    try {
        cropResult = await cropRetryBooks({
            adsId,
            imageUrls,
            books: flagged.map(({ book, index }) => ({
                ref: index,
                bbox: book.bbox,
                orientation: book.orientation,
                imageIndex: book.image_index,
            })),
            maxCrops: CROP_RETRY_MAX,
        });
    } catch (error) {
        console.error(
            `Ad ${adsId}: crop retry failed, keeping Pass 1 results:`,
            error?.message || error
        );
        return;
    }

    const resultsByRef =
        cropResult?.resultsByRef instanceof Map ? cropResult.resultsByRef : new Map();
    let improved = 0;

    for (const { book, index } of flagged) {
        const crop = resultsByRef.get(index);
        if (!crop) continue;

        book._cropPass2 = crop; // kept for per-book logging only (not persisted)

        const beforeConfidence = normalizeConfidence(book.isbn_confidence) ?? 0;
        const hadValidIsbn = Boolean(book.isbn) && book.isbn_is_valid !== false;
        const cropConfidence = normalizeConfidence(crop.confidence) ?? 0;

        const compatible = isCropCompatibleWithBook(book, crop);

        // #4 crop-quality guard: a poor/risky crop (tiny/borderline bbox) is exactly
        // where Pass-2's crop read is unreliable (clipped / table-heavy) and Pass-1's
        // full-image title is the trustworthy one. Only a GOOD (large) crop may
        // override Pass-1 with a CONTRADICTING Pass-2 result; otherwise keep Pass-1's
        // title + ISBN. (Compatible reads still merge — they agree with Pass-1.)
        const cropLevel = cropQualityLevel(book.bbox).level;

        // Safe rule:
        // - If crop matches the original book text, merge normally.
        // - If crop strongly contradicts the original book text:
        //   - only allow it when the crop is GOOD, the old ISBN was weak/unaccepted
        //     AND crop confidence is high,
        //   - clear the old ISBN first so we never keep title from one book + ISBN from another.
        const allowContradictingCropOverride =
            !compatible &&
            cropLevel === 'good' &&
            beforeConfidence < ISBN_LOOKUP_CONFIDENCE_MIN &&
            cropConfidence >= 0.7;

        if (!compatible && !allowContradictingCropOverride) {
            const heldByCropQuality =
                cropLevel !== 'good' &&
                beforeConfidence < ISBN_LOOKUP_CONFIDENCE_MIN &&
                cropConfidence >= 0.7;
            console.warn(
                `Ad ${adsId}: crop result rejected for book index ${index}: ` +
                `${heldByCropQuality ? `${cropLevel} crop kept Pass-1 title (no override)` : 'title mismatch'} | ` +
                `book="${bookTextForComparison(book)}" | crop="${cropTextForComparison(crop)}"`
            );

            book.needs_crop_review = true;
            book.crop_retried = true;
            // Pass-2 crop read DISAGREED with the Pass-1 title (genuine title mismatch OR
            // a poor crop we refused to trust). Either way the visual identity is unreliable:
            // the provider quality gate uses this flag to require cover/visible proof before
            // sending — title/confidence text proof alone is no longer trusted for this book.
            book.crop_retry_mismatch = true;
            continue;
        }

        if (allowContradictingCropOverride) {
            console.warn(
                `Ad ${adsId}: crop result overrides weak Pass-1 book index ${index}; clearing old ISBN first | ` +
                `old="${bookTextForComparison(book)}" | crop="${cropTextForComparison(crop)}"`
            );

            clearLookupResolution(book);
        }

        const changed = mergeCropResultIntoBook(book, crop);
        book.needs_crop_review = true;
        book.crop_retried = true;

        if (!changed) continue;

        try {
            const reResolved = await resolveIsbnForBook(book, resolveOptions);
            const afterConfidence = normalizeConfidence(reResolved.isbnConfidence) ?? 0;
            const newHasIsbn = Boolean(reResolved.isbn);

            if (
                allowContradictingCropOverride ||
                !hadValidIsbn ||
                (newHasIsbn && afterConfidence > beforeConfidence)
            ) {
                assignResolutionFields(book, reResolved);
                improved += 1;
            }
        } catch (error) {
            console.warn(
                `Ad ${adsId}: re-resolution after crop failed for one book:`,
                error?.message || error
            );
        }
    }

    console.log(
        `Ad ${adsId}: crop retry — ${cropResult?.cropsCreated ?? 0} crop image(s) created, ${improved} book(s) improved.`
    );
}

/* --------------------------- acceptance rules ----------------------------- */

// ISBN lookup threshold. Acceptance is ISBN-driven: a medium/strong Google Books
// match (>= this) is eligible for Momox. Lower threshold because Momox + admin
// validation handle final precision.
const ISBN_LOOKUP_CONFIDENCE_MIN = 0.50;

function shouldAcceptResolvedBook(book) {
    const isbnConfidence = book.isbn_confidence ?? 0;

    // Need some readable identity.
    if (!book.title && !book.possible_corrected_title && !book.raw_visible_text) {
        return false;
    }

    // Acceptance is ISBN-DRIVEN (recall-oriented): send a book to Momox when we have
    // a checksum-valid ISBN that matched a real Google Books volume with at least
    // medium confidence. The raw spine-reading confidence (ai_confidence) is
    // intentionally NOT a hard gate — a hard-to-read spine can still resolve to a
    // correct ISBN, and Momox + admin validation are the final precision filters.
    if (!book.isbn || !book.isbn_is_valid) {
        return false;
    }

    if (!book.lookup_title || !(book.lookup_score > 0)) {
        return false;
    }

    if (isbnConfidence < ISBN_LOOKUP_CONFIDENCE_MIN) {
        return false;
    }

    const bestTitleSimilarity = Number(book.best_title_similarity ?? 0);
    const authorSimilarity = Number(book.author_similarity ?? 0);
    const hasAuthor = Boolean(String(book.author || '').trim());

    const strongLookupCandidates = Array.isArray(book.lookup_candidates)
        ? book.lookup_candidates.filter((candidate) => {
            const score = Number(candidate?.score ?? 0);
            return candidate?.isbn && score >= ISBN_LOOKUP_CONFIDENCE_MIN;
        })
        : [];

    // If the visual detection has an author, reject lookup results where the author does not match.
    // This avoids cases like:
    // detected: "La vie en silence" by Clive Gifford
    // lookup: "Une vie de silence" by Dongxi
    if (hasAuthor && authorSimilarity === 0) {
        return false;
    }

    // Several plausible candidates with DIFFERENT titles and no author to
    // disambiguate -> admin must choose, no resale yet. But several EXACT
    // normalized title matches are just multiple editions of the same book:
    // accept, price them all, and let the admin validate the edition.
    const exactStrongCandidates = strongLookupCandidates.filter(
        (candidate) => candidate.exactTitleMatch || candidate.articleInsensitiveTitleMatch
    );

    if (!hasAuthor && strongLookupCandidates.length > 1 && !exactStrongCandidates.length) {
        return false;
    }

    // Without author, require a very strong title match.
    if (!hasAuthor && bestTitleSimilarity < 0.9) {
        return false;
    }

    // With author, still require a decent title match.
    if (hasAuthor && bestTitleSimilarity < 0.65) {
        return false;
    }


    // Tiny safety net for a couple of known series-only / ambiguous titles.
    if (isGenericOrIncompleteTitle(book.title)) {
        return false;
    }

    return true;
}

/* ------------------------------ OpenAI call ------------------------------- */

function normalizeImageUrls({ imageUrl, imageUrls, maxImages }) {
    const urls = [];

    if (Array.isArray(imageUrls)) {
        urls.push(...imageUrls);
    }

    if (imageUrl) {
        urls.push(imageUrl);
    }

    const uniqueUrls = Array.from(
        new Set(
            urls
                .map((url) => String(url || '').trim())
                .filter(Boolean)
        )
    );

    return uniqueUrls.slice(0, maxImages);
}

export async function extractBooksWithOpenAI({
    adsId,
    adTitle,
    imageUrl,
    imageUrls,
    maxImages = 8,
}) {
    const selectedImageUrls = normalizeImageUrls({
        imageUrl,
        imageUrls,
        maxImages,
    });

    if (!selectedImageUrls.length) {
        console.log(`Ad ${adsId}: no image URL, skipping OpenAI extraction.`);

        return {
            resolvedBooks: [],
            validBooks: [],
            skippedBooks: [],
        };
    }

    console.log(
        `Ad ${adsId}: sending ${selectedImageUrls.length} image(s) to OpenAI for book detection.`
    );

    const imageContent = selectedImageUrls.map((url) => ({
        type: 'input_image',
        image_url: url,
    }));

    const response = await trackedOpenAiCall({
        callSite: 'pass1_extract',
        adsId,
        inputKind: 'multi_image',
        imageCount: selectedImageUrls.length,
        persistCost: false, // Pass 1 already records its own cost event below
        // model resolves per call site (OPENAI_PASS1_MODEL -> OPENAI_MODEL), injected into create()
        fn: (model) => openai.responses.create({
        model,
        input: [
            {
                role: 'system',
                content: [
                    {
                        type: 'input_text',
                        text:
                            [
                                'Tu es un assistant spécialisé dans l’identification de livres à partir de photos d’annonces Leboncoin.',
                                'Ton rôle principal est de détecter les livres visibles et de lire le titre/auteur.',
                                'Ne devine pas d’ISBN si le code-barres ou l’ISBN n’est pas réellement visible dans l’image.',
                                'Si un ISBN est réellement visible, retourne-le dans visibleIsbn.',
                                'Si aucun ISBN n’est visible, laisse visibleIsbn vide.',
                                'Le backend cherchera ensuite l’ISBN avec une API bibliographique.',
                            ].join(' '),
                    },
                ],
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: `
Analyse toutes les images de cette annonce Leboncoin.

ID de l’annonce: ${adsId}
Titre de l’annonce: ${adTitle || ''}

Objectif:
- Identifier tous les livres visibles sur toutes les images.
- Ne te limite pas à la première image.
- Parcours chaque image de gauche à droite et de haut en bas.
- Retourne un élément par livre identifié.
- Si le même livre apparaît sur plusieurs images, retourne-le une seule fois.
- Beaucoup de textes sont petits, sur des tranches, inclinés, stylisés, ou partiellement cachés.
- rawVisibleText doit contenir le texte réellement visible sur le livre, même s’il est incomplet ou incertain.
- possibleCorrectedTitle doit contenir ta meilleure hypothèse du vrai titre publié.
- titleCandidates doit contenir jusqu’à 3 titres possibles, du plus probable au moins probable.
- Si le livre a un nom de série en anglais mais un sous-titre français, conserve les deux informations.
- Exemple: "Dragon Girls" peut être une série, et "Amira, le dragon d’or" peut être le titre français exact.
- Utilise le texte visible: titre, auteur, collection, éditeur.
- Si le titre est partiellement visible, utilise la couverture pour aider, mais baisse la confiance.
- Ne retourne pas de jeux, boîtes ou objets qui ne sont pas des livres.
- Ne propose pas d’ISBN inventé.
- visibleIsbn doit être rempli uniquement si l’ISBN/code-barres est visible dans l’image.
- Si l’ISBN n’est pas visible, visibleIsbn doit être une chaîne vide.
- languageHint doit être "fr", "en", "mixed" ou "unknown".
- confidence mesure la fiabilité de possibleCorrectedTitle.
- imageIndex indique l’image principale où le livre est visible, en commençant à 1.
- position décrit rapidement où se trouve le livre dans l’image.
- bbox doit être un tableau [x0, y0, x1, y1] avec des valeurs entre 0 et 1, approximatives.
- orientation doit être "horizontal", "vertical_up", "vertical_down" ou "unknown".
- isPartialOrOccluded indique si le livre est partiellement caché ou difficile à lire.
- seriesName contient le nom de série si visible, sinon chaîne vide.

Retourne uniquement du JSON.
`.trim(),
                    },
                    ...imageContent,
                ],
            },
        ],
        text: {
            format: {
                type: 'json_schema',
                name: 'book_visual_detection',
                strict: true,
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        books: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    title: {
                                        type: 'string',
                                    },
                                    rawVisibleText: {
                                        type: 'string',
                                    },
                                    possibleCorrectedTitle: {
                                        type: 'string',
                                    },
                                    titleCandidates: {
                                        type: 'array',
                                        items: {
                                            type: 'string',
                                        },
                                    },
                                    author: {
                                        type: 'string',
                                    },
                                    publisherOrCollection: {
                                        type: 'string',
                                    },
                                    languageHint: {
                                        type: 'string',
                                        enum: ['fr', 'en', 'mixed', 'unknown'],
                                    },
                                    visibleIsbn: {
                                        type: 'string',
                                    },
                                    confidence: {
                                        type: 'number',
                                        minimum: 0,
                                        maximum: 1,
                                    },
                                    imageIndex: {
                                        type: 'number',
                                    },
                                    position: {
                                        type: 'string',
                                    },
                                    bbox: {
                                        type: 'array',
                                        items: {
                                            type: 'number',
                                            minimum: 0,
                                            maximum: 1,
                                        },
                                        minItems: 4,
                                        maxItems: 4,
                                    },
                                    orientation: {
                                        type: 'string',
                                        enum: ['horizontal', 'vertical_up', 'vertical_down', 'unknown'],
                                    },
                                    isPartialOrOccluded: {
                                        type: 'boolean',
                                    },
                                    seriesName: {
                                        type: 'string',
                                    },
                                    reason: {
                                        type: 'string',
                                    },
                                },
                                required: [
                                    'title',
                                    'rawVisibleText',
                                    'possibleCorrectedTitle',
                                    'titleCandidates',
                                    'author',
                                    'publisherOrCollection',
                                    'languageHint',
                                    'visibleIsbn',
                                    'confidence',
                                    'imageIndex',
                                    'position',
                                    'bbox',
                                    'orientation',
                                    'isPartialOrOccluded',
                                    'seriesName',
                                    'reason',
                                ],
                            },
                        },
                    },
                    required: ['books'],
                },
            },
        },
    }),
    });

    await saveOpenAiCostEvent({
        adsId,
        costType: 'openai_vision_extract',
        response,
        model: getOpenAiModelForCallSite('pass1_extract'),
        metadata: {
            adTitle: adTitle || null,
            imageCount: selectedImageUrls.length,
            imageUrls: selectedImageUrls,
        },
    });

    const text = response.output_text;

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        console.error(`Ad ${adsId}: failed to parse OpenAI JSON:`, text);
        throw error;
    }

    const rawBooks = Array.isArray(parsed.books) ? parsed.books : [];

    const detectedBooks = dedupeDetectedBooks(
        rawBooks.map((book) => ({
            title: book.title ? String(book.title).trim() : null,
            raw_visible_text: book.rawVisibleText ? String(book.rawVisibleText).trim() : null,
            possible_corrected_title: book.possibleCorrectedTitle
                ? String(book.possibleCorrectedTitle).trim()
                : null,
            title_candidates: Array.isArray(book.titleCandidates)
                ? book.titleCandidates.map((value) => String(value || '').trim()).filter(Boolean)
                : [],
            author: book.author ? String(book.author).trim() : null,
            publisher_or_collection: book.publisherOrCollection
                ? String(book.publisherOrCollection).trim()
                : null,
            language_hint: book.languageHint || 'unknown',
            visible_isbn: cleanIsbn(book.visibleIsbn),
            ai_confidence: normalizeConfidence(book.confidence),
            image_index: Number.isFinite(Number(book.imageIndex))
                ? Number(book.imageIndex)
                : null,
            position: book.position ? String(book.position).trim() : null,
            bbox: Array.isArray(book.bbox) && book.bbox.length === 4
                ? book.bbox.map((value) => Number(value))
                : null,
            orientation: book.orientation || 'unknown',
            is_partial_or_occluded: Boolean(book.isPartialOrOccluded),
            series_name: book.seriesName ? String(book.seriesName).trim() : null,
            reason: book.reason ? String(book.reason).trim() : null,
        }))
    );

    console.log(
        `[ad ${adsId}] detection: raw=${rawBooks.length}, deduped=${detectedBooks.length}`
    );


    const isbnSearchQueries = [];

    for (const book of detectedBooks) {
        const bookQueries = buildIsbnSearchQueries({
            title: book.title,
            author: book.author,
            rawVisibleText: book.raw_visible_text,
            possibleCorrectedTitle: book.possible_corrected_title,
            titleCandidates: book.title_candidates,
            seriesName: book.series_name,
        });

        // Important:
        // Only send the best query per book to Apify for now.
        // The Apify client will split all queries into safe batches of 15.
        isbnSearchQueries.push(...bookQueries.slice(0, 1));
    }

    const filteredIsbnSearchQueries = Array.from(
        new Set(
            isbnSearchQueries
                .map((query) => String(query || '').trim())
                .filter(isUsefulIsbnSearchQuery)
        )
    );

    console.log(
        `Ad ${adsId}: ISBNSearch queries prepared: ${filteredIsbnSearchQueries.length}`
    );

    let isbnSearchLookupResult = {
        candidatesByQuery: new Map(),
        candidatesByIsbn: new Map(),
        rawItems: [],
        blocked: false,
        runs: [],
    };

    try {
        isbnSearchLookupResult = await runIsbnSearchLookup({
            queries: filteredIsbnSearchQueries,
            isbns: [],
            maxCandidatesPerQuery: 10,
            adsId,
        });

        console.log(
            `Ad ${adsId}: ISBNSearch lookup done via provider=${isbnSearchLookupResult.provider || 'unknown'}, queryKeys=${isbnSearchLookupResult.candidatesByQuery.size}`
        );
    } catch (error) {
        console.error(
            `Ad ${adsId}: ISBNSearch lookup failed, continuing without ISBN search:`,
            error?.message || error
        );
    }

    const resolvedBooks = [];

    // Per-ad AI-recovery budget, shared across the resolution loop and the
    // crop-retry re-resolutions (bounded by MAX_AI_ISBN_RECOVERY_PER_AD).
    const adBudget = { aiRecoveryUsed: 0 };

    for (const book of detectedBooks) {
        const resolved = await resolveIsbnForBook(book, {
            isbnSearchCandidatesByQuery: isbnSearchLookupResult.candidatesByQuery,
            isbnSearchCandidatesByIsbn: isbnSearchLookupResult.candidatesByIsbn,
            adsId,
            adBudget,
        });

        const isbn13 = resolved.isbn13 || resolved.isbn;
        const isbn10 = resolved.isbn10 || convertIsbn13ToIsbn10(isbn13);
        const lookupCandidates = summarizeLookupCandidates(resolved.candidates || []);

        resolvedBooks.push({
            title: book.title,
            raw_visible_text: book.raw_visible_text,
            possible_corrected_title: book.possible_corrected_title,
            title_candidates: book.title_candidates,

            isbn: resolved.isbn,
            isbn13,
            isbn10,

            isbn13_raw: resolved.lookup?.rawIsbn13 || resolved.isbn13 || null,
            isbn10_raw: resolved.lookup?.rawIsbn10 || resolved.isbn10 || null,

            isbn_is_valid: isValidIsbn13(resolved.isbn),
            ai_confidence: book.ai_confidence,
            isbn_confidence: normalizeConfidence(resolved.isbnConfidence),

            author: book.author,
            publisher_or_collection: book.publisher_or_collection,
            language_hint: book.language_hint,
            bbox: book.bbox,
            orientation: book.orientation,
            is_partial_or_occluded: book.is_partial_or_occluded,
            series_name: book.series_name,
            image_index: book.image_index,
            position: book.position,
            reason: book.reason,

            visible_isbn: book.visible_isbn,
            isbn_source: resolved.source,

            lookup_title: resolved.lookup?.googleTitle || null,
            lookup_authors: resolved.lookup?.googleAuthors || null,
            lookup_publisher: resolved.lookup?.publisher || null,
            lookup_published_date: resolved.lookup?.publishedDate || null,
            lookup_language: resolved.lookup?.language || null,
            lookup_score: resolved.lookup?.score ?? null,
            lookup_query: resolved.lookup?.query || null,
            lookup_candidates: lookupCandidates,

            title_similarity: resolved.lookup?.titleSimilarity ?? null,
            raw_text_similarity: resolved.lookup?.rawTextSimilarity ?? null,
            corrected_title_similarity: resolved.lookup?.correctedTitleSimilarity ?? null,
            best_title_similarity: resolved.lookup?.bestTitleSimilarity ?? null,
            author_similarity: resolved.lookup?.authorSimilarity ?? null,

            needs_crop_review:
                Boolean(book.is_partial_or_occluded) ||
                !resolved.isbn ||
                normalizeConfidence(resolved.isbnConfidence) < 0.85,
        });
    }

    // Structured audit summary of the ISBNSearch stage across all books.
    {
        const allCandidates = resolvedBooks.flatMap((book) =>
            Array.isArray(book.lookup_candidates) ? book.lookup_candidates : []
        );

        const exactMatchCount = allCandidates.filter(
            (candidate) => candidate.exactTitleMatch || candidate.articleInsensitiveTitleMatch
        ).length;

        const alternativeCount = resolvedBooks.reduce((sum, book) => {
            const exact = (Array.isArray(book.lookup_candidates) ? book.lookup_candidates : []).filter(
                (candidate) =>
                    (candidate.exactTitleMatch || candidate.articleInsensitiveTitleMatch) &&
                    candidate.isbn &&
                    candidate.isbn !== book.isbn
            );
            return sum + exact.length;
        }, 0);

        const batchCount = Array.isArray(isbnSearchLookupResult.runs)
            ? isbnSearchLookupResult.runs.length
            : 0;

        console.log(
            `[ad ${adsId}] isbnsearch: queries=${filteredIsbnSearchQueries.length}, batches=${batchCount}, candidates=${allCandidates.length}, exactMatches=${exactMatchCount}, alternatives=${alternativeCount}, cost=${isbnSearchLookupResult.totalScrapflyCost ?? 'n/a'}, provider=${isbnSearchLookupResult.provider || 'unknown'}`
        );
    }

    // Snapshot Pass-1 (pre-crop) resolution for each book, for diagnostic logging.
    const pass1Snapshots = resolvedBooks.map((book) => ({
        title: book.possible_corrected_title || book.title || book.raw_visible_text || null,
        isbn: book.isbn || null,
        isbnConfidence: book.isbn_confidence ?? null,
        lookupScore: book.lookup_score ?? null,
    }));

    // Phase 2.5: recover weak/missing ISBNs by cropping uncertain books, re-reading
    // them in one extra Vision call, then re-resolving via Google Books. Never throws.
    try {
        await runCropRetryPass(adsId, selectedImageUrls, resolvedBooks, {
            isbnSearchCandidatesByQuery: isbnSearchLookupResult.candidatesByQuery,
            isbnSearchCandidatesByIsbn: isbnSearchLookupResult.candidatesByIsbn,
            adsId,
            adBudget,
        });
    } catch (error) {
        console.error(`Ad ${adsId}: crop retry pass error (ignored):`, error?.message || error);
    }

    const validBooks = resolvedBooks.filter(shouldAcceptResolvedBook);
    const validSet = new Set(validBooks);
    const skippedBooks = resolvedBooks.filter((book) => !shouldAcceptResolvedBook(book));

    console.log(
        `Ad ${adsId}: resolved ${resolvedBooks.length} books, ${validBooks.length} accepted, ${skippedBooks.length} skipped.`
    );

    // Per-book trace: Pass-1 -> crop -> final, with Momox eligibility.
    console.log(`Ad ${adsId}: pass1 -> crop -> final (momox eligibility):`);
    resolvedBooks.forEach((book, index) => {
        const pass1 = pass1Snapshots[index];
        const cropInfo = book.crop_retried
            ? `"${book._cropPass2?.possibleCorrectedTitle || '-'}" conf=${book._cropPass2?.confidence ?? '-'}`
            : '(not retried)';
        const finalTitle = book.possible_corrected_title || book.title || '-';

        console.log(
            `  - pass1: "${pass1.title || '-'}" isbn=${pass1.isbn || '-'} conf=${pass1.isbnConfidence ?? '-'}` +
            ` | crop: ${cropInfo}` +
            ` | final: "${finalTitle}" isbn=${book.isbn || '-'} conf=${book.isbn_confidence ?? '-'} score=${book.lookup_score ?? '-'}` +
            ` | momox=${validSet.has(book) ? 'YES' : 'no'}`
        );
    });

    if (validBooks.length) {
        console.log(
            `Ad ${adsId}: accepted books:`,
            JSON.stringify(
                validBooks.map((book) => ({
                    title: book.title,
                    rawVisibleText: book.raw_visible_text,
                    possibleCorrectedTitle: book.possible_corrected_title,
                    author: book.author,
                    isbn: book.isbn,
                    isbnSource: book.isbn_source,
                    isbnConfidence: book.isbn_confidence,
                    lookupTitle: book.lookup_title,
                    lookupAuthors: book.lookup_authors,
                    lookupScore: book.lookup_score,
                    lookupQuery: book.lookup_query,
                    languageHint: book.language_hint,
                    needsCropReview: book.needs_crop_review,
                })),
                null,
                2
            )
        );
    }

    if (skippedBooks.length) {
        console.log(
            `Ad ${adsId}: skipped books:`,
            JSON.stringify(
                skippedBooks.map((book) => ({
                    title: book.title,
                    rawVisibleText: book.raw_visible_text,
                    possibleCorrectedTitle: book.possible_corrected_title,
                    languageHint: book.language_hint,
                    author: book.author,
                    isbn: book.isbn,
                    isbnSource: book.isbn_source,
                    aiConfidence: book.ai_confidence,
                    isbnConfidence: book.isbn_confidence,
                    lookupTitle: book.lookup_title,
                    lookupAuthors: book.lookup_authors,
                    lookupScore: book.lookup_score,
                    lookupQuery: book.lookup_query,
                    needsCropReview: book.needs_crop_review,
                    reason: book.reason,
                })),
                null,
                2
            )
        );
    }

    return {
        resolvedBooks,
        validBooks,
        skippedBooks,
    };
}
