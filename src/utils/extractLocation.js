//utils\extractLocation.js
export function extractLocation(tags) {
    if (!Array.isArray(tags)) {
        return null;
    }

    const locationTag = tags.find((tag) => {
        return typeof tag === 'string' && tag.trim().startsWith('À ');
    });

    return locationTag || null;
}
