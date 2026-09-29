//utils\parsePrice.js
export function parsePrice(priceText) {
    if (!priceText || typeof priceText !== 'string') {
        return null;
    }

    const cleaned = priceText
        .replace(/\s/g, '')
        .replace('€', '')
        .replace(',', '.')
        .replace(/[^\d.]/g, '');

    const amount = Number.parseFloat(cleaned);

    return Number.isFinite(amount) ? amount : null;
}
