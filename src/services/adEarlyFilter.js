// src/services/adEarlyFilter.js
//
// Deterministic, conservative, AI-FREE early classifier: is a Leboncoin ad plausibly a
// book / book-lot worth our expensive pipeline (OpenAI vision -> ISBN search -> catalog
// verify -> Momox/Gibert)? Runs on title + description (+ best-effort raw_data category /
// tags), BEFORE any paid step. Rules:
//   - any UNAMBIGUOUS book noun present  -> KEEP (high)          (book signal always wins)
//   - else a clear non-book signal present -> REJECT (high)      (the only reject case)
//   - else a weak/ambiguous book hint present -> KEEP (medium)
//   - else nothing decisive               -> KEEP (low)          (ambiguous => keep)
// The caller rejects ONLY when isBookRelevant === false && confidence === 'high'.

function stripAccents(value) {
    return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Normalize to a space-padded, lowercased, punctuation-free string so signal lookups
// can use whole-token matching (' bd ' won't match inside another word).
function normalize(value) {
    const cleaned = stripAccents(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    return ` ${cleaned} `;
}

// UNAMBIGUOUS book nouns: their presence always keeps the ad (even alongside a DVD/CD/etc).
const STRONG_BOOK = [
    'livre', 'livres', 'roman', 'romans', 'bd', 'bande dessinee', 'bandes dessinees',
    'tome', 'tomes', 'isbn', 'dictionnaire', 'dictionnaires', 'encyclopedie', 'encyclopedies',
    'manuel', 'manuels', 'scolaire', 'recueil', 'biographie', 'autobiographie',
    'auteur', 'autrice', 'romanesque',
];

// Weak/ambiguous book-ish hints: keep (medium) when present, but they do NOT override a
// clear non-book signal (e.g. "Blu-ray collection" -> reject; "manga figurine" -> reject).
const WEAK_BOOK = [
    'manga', 'mangas', 'collection', 'coffret', 'poche', 'edition', 'editions',
    'lot', 'enfant', 'enfants', 'histoire', 'histoires', 'volume', 'volumes', 'culturel',
];

// Clear NON-book signals (objects / media that are not book resale). Deliberately omits
// over-broad words that often appear in real book titles ("jeu" -> "Le jeu de la dame";
// "journal" -> "Journal d'Anne Frank") to avoid false rejects.
const NON_BOOK = [
    'dvd', 'dvds', 'blu ray', 'bluray', 'cd', 'cds', 'cd audio', 'vinyle', 'vinyles', 'vinyl',
    'jeu video', 'jeux video', 'jeu de societe', 'ps2', 'ps3', 'ps4', 'ps5', 'xbox', 'switch',
    'nintendo', 'wii', 'console', 'consoles', 'manette',
    'puzzle', 'puzzles', 'jouet', 'jouets', 'figurine', 'figurines', 'peluche', 'peluches', 'lego',
    'pokemon', 'affiche', 'affiches', 'poster', 'posters', 'meuble', 'meubles',
    'cassette', 'cassettes', 'vhs', 'magazine', 'magazines', 'journaux',
];

function buildCorpus({ title, description, rawData }) {
    const parts = [title, description];
    if (rawData && typeof rawData === 'object') {
        // Best-effort: include common Leboncoin/Apify category & tag fields if present.
        for (const key of ['category', 'category_name', 'categoryName', 'subject', 'search_title', 'searchTitle']) {
            if (typeof rawData[key] === 'string') parts.push(rawData[key]);
        }
        const tags = rawData.tags;
        if (Array.isArray(tags)) parts.push(tags.filter((t) => typeof t === 'string').join(' '));
        else if (typeof tags === 'string') parts.push(tags);
    }
    return normalize(parts.filter(Boolean).join(' '));
}

function hits(corpus, signals) {
    return signals.filter((s) => corpus.includes(` ${s} `));
}

/**
 * @returns {{ isBookRelevant:boolean, confidence:'high'|'medium'|'low', reason:string, matchedSignals:string[] }}
 */
export function classifyAdBookRelevance({ title = '', description = '', rawData = null } = {}) {
    const corpus = buildCorpus({ title, description, rawData });

    const strongBook = hits(corpus, STRONG_BOOK);
    if (strongBook.length) {
        return {
            isBookRelevant: true,
            confidence: 'high',
            reason: `book_signal:${strongBook[0]}`,
            matchedSignals: [...strongBook, ...hits(corpus, WEAK_BOOK)],
        };
    }

    const nonBook = hits(corpus, NON_BOOK);
    if (nonBook.length) {
        return {
            isBookRelevant: false,
            confidence: 'high',
            reason: `non_book_signal:${nonBook[0]}`,
            matchedSignals: nonBook,
        };
    }

    const weakBook = hits(corpus, WEAK_BOOK);
    if (weakBook.length) {
        return {
            isBookRelevant: true,
            confidence: 'medium',
            reason: `weak_book_signal:${weakBook[0]}`,
            matchedSignals: weakBook,
        };
    }

    return {
        isBookRelevant: true,
        confidence: 'low',
        reason: 'no_clear_signal',
        matchedSignals: [],
    };
}

// The caller's reject predicate (kept here so the rule lives with the classifier).
export function shouldRejectAsNonBook(verdict) {
    return Boolean(verdict) && verdict.isBookRelevant === false && verdict.confidence === 'high';
}
