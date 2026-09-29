// src/services/leboncoinUrl.js
//
// Leboncoin URL classification for the Apify start queue. A DIRECT ad URL queued as
// apify_start_search_page starts the search-page actor, whose per-item webhooks
// (mode=search_page_item) the backend does not support — the job then hangs at
// processing/apify_running/40% and blocks the sequential Apify queue. Every queue
// entry point uses this classifier so ad URLs always run as apify_start_manual_ad.

/**
 * True for a direct Leboncoin ad URL, e.g.
 *   https://www.leboncoin.fr/ad/livres/3229746275
 * Accepts http/https, any leboncoin.fr host (www., m., bare), any category slug,
 * and tolerates query strings, hashes and a trailing slash. Search/listing URLs
 * (/recherche, /c/...) and non-Leboncoin hosts return false.
 */
export function isDirectLeboncoinAdUrl(url) {
    const clean = String(url || '').trim();
    if (!clean) return false;

    let parsed;
    try {
        parsed = new URL(clean);
    } catch {
        return false;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const host = parsed.hostname.toLowerCase();
    if (host !== 'leboncoin.fr' && !host.endsWith('.leboncoin.fr')) return false;

    return /^\/ad\/[^/]+\/\d+\/?$/.test(parsed.pathname);
}
