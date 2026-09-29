// src/services/bookPriceFromDescription.js
//
// Deterministic per-book SELLER price detection (no AI, no DB, no network). The value is
// the individual LISTING price the seller asks for ONE physical book on Leboncoin — NOT a
// Momox/Gibert/provider resale price, technical cost, profit, or ad-processing cost.
// Unsure -> null. Never invent a price. Three sources, in priority order, are composed by
// computeSellerBookPrices():
//   1. single-book ad  -> ads.price_amount (the whole listing is that one book)
//   2. multi-book ad   -> per-line prices parsed from the description, matched by title /
//                         author / tome(volume) number
//   3. title fallback  -> "<price>€ pièce|chacun|l'unité" (per book), or "lot de N ... Y€"
//                         distributed ONLY when N equals the detected book count
// All matching is conservative: ambiguous -> null.

const OPEN_QUOTE = '"“«';
const CLOSE_QUOTE = '"”»';
// Title between matching quote chars (straight ", curly “ ”, guillemets « »).
const TITLE_RE = new RegExp(`[${OPEN_QUOTE}]\\s*([^${OPEN_QUOTE}${CLOSE_QUOTE}]+?)\\s*[${CLOSE_QUOTE}]`);
// "<number>[,.<decimals>] €" — French comma or dot, 0-2 decimals, € required.
const PRICE_RE = /(\d{1,4}(?:[.,]\d{1,2})?)\s*€/g;

/** '2,5 €' -> 2.5 ; '1,5€' -> 1.5 ; '0,5€' -> 0.5 ; '2 €' -> 2 ; invalid -> null. */
export function normalizeFrenchPriceToNumber(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim().replace(/€/g, '').replace(/\s+/g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100) / 100;
}

function round2(n) {
    return Math.round(Number(n) * 100) / 100;
}

function stripAccents(value) {
    return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeText(value) {
    return stripAccents(value)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Lowercased, accent- and apostrophe-normalized text for wording detection (pièce, l'unité…).
function normWording(value) {
    return stripAccents(value).toLowerCase().replace(/['’]/g, ' ').replace(/\s+/g, ' ').trim();
}

// "per book" wording: 3€ chacun / pièce / l'unité (vs a lot/total price).
const PER_UNIT_RE = /\b(?:chacun|chacune|piece|unite)\b|\/\s*(?:u|piece)\b/;

// Parse a tome/volume marker: "tome 1", "tomes 1 et 2", "tomes 1 à 3", "vol 2", "t1".
// Returns { volumes:number[], startIndex } (startIndex = where to cut the work title).
function extractVolumes(text) {
    const m = String(text || '').match(
        /\b(?:tomes?|vol(?:umes?)?)\.?\s*(\d{1,3})(?:\s*(et|&|,|à|a|-)\s*(\d{1,3}))?|\bt(\d{1,3})\b/i
    );
    if (!m) return { volumes: [], startIndex: -1 };
    if (m[4] != null) return { volumes: [Number(m[4])], startIndex: m.index }; // "t1" form
    const a = Number(m[1]);
    const sep = (m[2] || '').toLowerCase();
    const b = m[3] != null ? Number(m[3]) : null;
    let volumes = [a];
    if (b != null && Number.isFinite(b)) {
        if (sep === 'et' || sep === '&' || sep === ',') volumes = [a, b];
        else if ((sep === 'à' || sep === 'a' || sep === '-') && b > a && b - a <= 12) {
            volumes = [];
            for (let v = a; v <= b; v += 1) volumes.push(v);
        }
    }
    return { volumes, startIndex: m.index };
}

// Remove a tome/volume marker from a title so the WORK title can be matched.
function stripVolume(value) {
    return String(value || '')
        .replace(/\b(?:tomes?|vol(?:umes?)?)\.?\s*\d{1,3}(?:\s*(?:et|&|,|à|a|-)\s*\d{1,3})?|\bt\d{1,3}\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// The single volume of ONE detected physical book (null when none/ambiguous).
function detectVolume(value) {
    const { volumes } = extractVolumes(value);
    return volumes.length ? volumes[0] : null;
}

function cleanTitle(value) {
    return String(value || '')
        .replace(/^[\s\-–—*•·.]+/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Parse one description line into 0..N price entries. Quoted titles use the precise
// quote+author path; unquoted lines must carry a tome marker OR a price separator
// (':' '/' ' - ') to be trusted (avoids reading prices out of prose like shipping fees).
// A multi-volume line ("tome 1 et 2 : 3€") yields one entry per volume; the price is
// split across them UNLESS per-unit wording (chacun/pièce/l'unité) says it is each.
function parseLine(rawLine) {
    const line = String(rawLine || '').trim();
    if (!line) return [];

    const priceMatches = [...line.matchAll(PRICE_RE)];
    if (!priceMatches.length) return [];
    const lastPrice = normalizeFrenchPriceToNumber(priceMatches[priceMatches.length - 1][1]);
    if (lastPrice === null) return [];
    const firstPriceIndex = priceMatches[0].index;

    // Quoted-title path (preserves author capture + original behavior).
    const quoted = line.match(TITLE_RE);
    if (quoted) {
        const title = quoted[1].trim();
        if (!title) return [];
        const after = line.slice(quoted.index + quoted[0].length);
        const author = after.split('/')[0]
            .replace(/\b(ed|éd|éditions?|editions?)\b.*$/i, '')
            .replace(/[0-9€].*$/, '')
            .trim() || null;
        return [{ title, author, volume: null, price: lastPrice, rawLine: line, distributed: false, groupSize: 1 }];
    }

    // Unquoted path.
    const head = line.slice(0, firstPriceIndex);
    const vol = extractVolumes(head);
    let titleText;
    if (vol.startIndex >= 0) {
        titleText = head.slice(0, vol.startIndex);
    } else {
        const sepMatch = head.match(/^(.*?)(?:\s*[:/]\s*|\s+[-–—]\s+)/);
        if (!sepMatch) return []; // no tome, no separator -> too risky to treat as a book line
        titleText = sepMatch[1];
    }
    const title = cleanTitle(titleText);
    if (!title || title.length < 2) return [];

    const perUnit = PER_UNIT_RE.test(normWording(line));
    const volumes = vol.volumes.length ? vol.volumes : [null];
    const distributed = volumes.length > 1 && !perUnit;
    const perBookPrice = distributed ? round2(lastPrice / volumes.length) : lastPrice;

    return volumes.map((v) => ({
        title,
        author: null,
        volume: v,
        price: perBookPrice,
        rawLine: line,
        distributed,
        groupSize: volumes.length,
    }));
}

/** Parse all confidently-priced book lines from a description. Returns [] when none. */
export function parseBookPricesFromDescription(description) {
    const text = String(description || '');
    if (!text.trim()) return [];
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
        const parsed = parseLine(line);
        if (parsed.length) entries.push(...parsed);
    }
    return entries;
}

function titlesMatch(detectedNorm, entryNorm) {
    if (!detectedNorm || !entryNorm) return false;
    if (detectedNorm === entryNorm) return true;
    // Containment either way, but only when the shorter title is substantial
    // (avoids tiny-substring false matches like "le"/"un").
    if (Math.min(detectedNorm.length, entryNorm.length) < 4) return false;
    return detectedNorm.includes(entryNorm) || entryNorm.includes(detectedNorm);
}

function authorsOverlap(aNorm, bNorm) {
    if (!aNorm || !bNorm) return false;
    if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) return true;
    const aTokens = new Set(aNorm.split(' ').filter((t) => t.length >= 4));
    return bNorm.split(' ').some((t) => t.length >= 4 && aTokens.has(t));
}

/**
 * Match the detected book to a parsed price entry by title, then by tome/volume number,
 * then author, to disambiguate. Returns the price number, or null when no confident
 * single match exists.
 */
export function matchBookPriceToDetectedBook(book, parsedPriceEntries) {
    const entries = Array.isArray(parsedPriceEntries) ? parsedPriceEntries : [];
    if (!entries.length) return null;

    const rawBookTitle = book?.title || book?.possible_corrected_title || book?.lookup_title || '';
    const bookTitleNorm = normalizeText(stripVolume(rawBookTitle));
    if (!bookTitleNorm) return null;
    const bookAuthor = normalizeText(book?.author || book?.lookup_authors);
    const bookVolume = detectVolume(rawBookTitle) ?? detectVolume(book?.raw_visible_text);

    const matches = entries.filter((e) => titlesMatch(bookTitleNorm, normalizeText(stripVolume(e.title))));
    if (!matches.length) return null;

    // Volume disambiguation when the detected book has a known tome number.
    if (bookVolume != null) {
        const sameVol = matches.filter((e) => e.volume === bookVolume);
        if (sameVol.length === 1) return sameVol[0].price;
        if (sameVol.length > 1) {
            const ds = [...new Set(sameVol.map((e) => e.price))];
            return ds.length === 1 ? ds[0] : null;
        }
        // The book's tome is not among the matched entries. If those entries DO specify
        // volumes (and none equals the book's), this book's volume simply is not listed.
        if (matches.some((e) => e.volume != null)) return null;
        // else: entries carry no volume info -> fall through to the title/author logic.
    }

    if (matches.length === 1) return matches[0].price;

    // Multiple title matches: prefer an author-disambiguated single match.
    if (bookAuthor) {
        const exact = matches.filter((e) => normalizeText(e.author) === bookAuthor);
        if (exact.length === 1) return exact[0].price;
        const byAuthor = matches.filter((e) => authorsOverlap(normalizeText(e.author), bookAuthor));
        if (byAuthor.length === 1) return byAuthor[0].price;
    }
    // Otherwise accept only if every candidate agrees on the price; else ambiguous -> null.
    const distinctPrices = [...new Set(matches.map((e) => e.price))];
    return distinctPrices.length === 1 ? distinctPrices[0] : null;
}

/**
 * The seller price for a SINGLE-book ad = the ad listing price, when numeric and > 0.
 * Free / donation / 0 / unknown / null -> null (never use a non-positive listing price).
 */
export function singleBookAdPrice(adPriceAmount) {
    const n = Number(adPriceAmount);
    return Number.isFinite(n) && n > 0 ? round2(n) : null;
}

/**
 * Title-level price fallback. Returns { perBook, mode, reason }:
 *   - per-unit wording ("<price>€ pièce|chacun|l'unité") -> that price for every book;
 *   - lot wording ("lot de N ... Y€") -> Y/N per book ONLY when N === detectedCount
 *     (the only safe lot distribution); otherwise perBook=null;
 *   - anything else / ambiguous -> perBook=null.
 */
export function parseTitleFallbackPrice(adTitle, detectedCount = 0) {
    const raw = String(adTitle || '');
    if (!raw.trim()) return { perBook: null, mode: 'none', reason: 'no_title' };
    const w = normWording(raw);

    if (/\b(?:chacun|chacune|piece|unite)\b/.test(w)) {
        const adj = w.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*€?\s*(?:la\s+|\/\s*)?(?:piece|chacun|chacune|unite|l\s+unite)/);
        let price = adj ? normalizeFrenchPriceToNumber(adj[1]) : null;
        if (price == null) {
            const prices = [...w.matchAll(/(\d{1,4}(?:[.,]\d{1,2})?)\s*€/g)]
                .map((m) => normalizeFrenchPriceToNumber(m[1]))
                .filter((p) => p != null && p > 0);
            if (prices.length === 1) price = prices[0];
        }
        if (price != null && price > 0) return { perBook: price, mode: 'title_per_unit', reason: 'per_unit_wording' };
        return { perBook: null, mode: 'none', reason: 'per_unit_word_no_clear_price' };
    }

    const lot = w.match(/lot\s+de\s+(\d{1,4})\b[^€]*?(\d{1,4}(?:[.,]\d{1,2})?)\s*€/);
    if (lot) {
        const qty = Number(lot[1]);
        const total = normalizeFrenchPriceToNumber(lot[2]);
        if (qty > 0 && total != null && total > 0 && detectedCount > 0 && qty === detectedCount) {
            return { perBook: round2(total / qty), mode: 'title_lot_distributed', reason: `lot_${qty}_eq_detected` };
        }
        return { perBook: null, mode: 'none', reason: `lot_unsafe_qty=${qty}_detected=${detectedCount}` };
    }

    return { perBook: null, mode: 'none', reason: 'no_per_unit_or_lot' };
}

/**
 * Compose the three sources into a per-book price + source label, aligned to `books`.
 * Pure (no DB/log); the workflow logs + persists. Returns [{ price, source }] where source
 * is one of: single_ad_price | description | title_per_unit | title_lot_distributed | none.
 */
export function computeSellerBookPrices({ books = [], adPriceAmount = null, description = '', adTitle = '' } = {}) {
    const list = Array.isArray(books) ? books : [];
    const result = list.map(() => ({ price: null, source: 'none' }));
    if (!list.length) return result;

    // 1. Single-book ad: the listing price IS the book price.
    if (list.length === 1) {
        const adPrice = singleBookAdPrice(adPriceAmount);
        if (adPrice != null) {
            result[0] = { price: adPrice, source: 'single_ad_price' };
            return result;
        }
        // ad price absent (free/donation/null) -> fall through to description/title signals.
    }

    // 2. Multi-book (and single-book without a listing price): per-line description prices.
    const entries = parseBookPricesFromDescription(description);
    for (let i = 0; i < list.length; i += 1) {
        const p = matchBookPriceToDetectedBook(list[i], entries);
        if (p != null) result[i] = { price: p, source: 'description' };
    }

    // 3. Title fallback fills any book still without a price.
    const fb = parseTitleFallbackPrice(adTitle, list.length);
    if (fb.perBook != null) {
        for (let i = 0; i < list.length; i += 1) {
            if (result[i].price == null) result[i] = { price: fb.perBook, source: fb.mode };
        }
    }

    return result;
}
