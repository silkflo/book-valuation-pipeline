// src/services/saveAds.js

import { pool } from '../db.js';
import { parsePrice } from '../utils/parsePrice.js';
import { extractLocation } from '../utils/extractLocation.js';

function normalizePayload(payload) {
    if (Array.isArray(payload)) {
        return payload;
    }

    if (payload && Array.isArray(payload.items)) {
        return payload.items;
    }

    if (payload && Array.isArray(payload.data)) {
        return payload.data;
    }

    return [];
}

function normalizePictureUrls(ad) {
    if (Array.isArray(ad.pictureUrls) && ad.pictureUrls.length) {
        return ad.pictureUrls.filter(Boolean);
    }

    if (ad.firstPictureUrl) {
        return [ad.firstPictureUrl];
    }

    return [];
}

export async function saveAdsFromPayload(payload, options = {}) {
    const forceStatusNew = Boolean(options.forceStatusNew);
    const ads = normalizePayload(payload);

    if (!ads.length) {
        return {
            received: 0,
            upserted: 0,
            message: 'No ads found in payload',
        };
    }

    let upserted = 0;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        for (const ad of ads) {
            if (!ad.id) {
                console.warn('Skipping ad without id:', ad);
                continue;
            }

            const adsId = String(ad.id);
            const priceText = ad.price || null;
            const priceAmount = parsePrice(priceText);

            const locationText = ad.locationText || extractLocation(ad.tags);
            const locationCity = ad.locationCity || null;
            const locationPostalCode = ad.locationPostalCode || null;
            const description = ad.description || null;
            const pictureUrls = normalizePictureUrls(ad);

            const query = `
                INSERT INTO ads (
                    ads_id,
                    url,
                    title,
                    description,
                    price_text,
                    price_amount,
                    currency,
                    first_picture_url,
                    picture_urls,
                    tags,
                    location_text,
                    location_city,
                    location_postal_code,
                    date_of_post,
                    date_of_post_visible,
                    delivery_modes,
                    delivery_text,
                    source,
                    search_title,
                    scraped_at,
                    raw_data,
                    status,
                    updated_at
                )
                VALUES (
                    $1, $2, $3, $4,
                    $5, $6, $7, $8,
                    $9::jsonb, $10::jsonb,
                    $11, $12, $13,
                    $14, $15,
                    $16::jsonb, $17, $18, $19, $20,
                    $21::jsonb, $22, NOW()
                )
                ON CONFLICT (ads_id)
                DO UPDATE SET
                    url = EXCLUDED.url,
                    title = EXCLUDED.title,
                    description = EXCLUDED.description,
                    price_text = EXCLUDED.price_text,
                    price_amount = EXCLUDED.price_amount,
                    currency = EXCLUDED.currency,
                    first_picture_url = EXCLUDED.first_picture_url,
                    picture_urls = EXCLUDED.picture_urls,
                    tags = EXCLUDED.tags,
                    location_text = EXCLUDED.location_text,
                    location_city = EXCLUDED.location_city,
                    location_postal_code = EXCLUDED.location_postal_code,
                    date_of_post = EXCLUDED.date_of_post,
                    date_of_post_visible = EXCLUDED.date_of_post_visible,
                    delivery_modes = EXCLUDED.delivery_modes,
                    delivery_text = EXCLUDED.delivery_text,
                    source = EXCLUDED.source,
                    search_title = EXCLUDED.search_title,
                    scraped_at = EXCLUDED.scraped_at,
                    raw_data = EXCLUDED.raw_data,
                    status = CASE
                        WHEN $23::boolean = true THEN 'new'
                        ELSE ads.status
                    END,
                    process_attempts = CASE
                        WHEN $23::boolean = true THEN 0
                        ELSE ads.process_attempts
                    END,
                    updated_at = NOW()
            `;

            const values = [
                adsId,
                ad.url || null,
                ad.title || null,
                description,
                priceText,
                priceAmount,
                'EUR',
                ad.firstPictureUrl || null,
                JSON.stringify(pictureUrls),
                JSON.stringify(ad.tags || []),
                locationText,
                locationCity,
                locationPostalCode,
                ad.dateOfPost || null,
                ad.dateOfPostVisible || null,
                JSON.stringify(ad.deliveryModes || []),
                ad.deliveryText || null,
                ad.source || null,
                ad.searchTitle || null,
                ad.scrapedAt || null,
                JSON.stringify(ad),
                'new',
                forceStatusNew,
            ];

            await client.query(query, values);

            upserted += 1;
        }

        await client.query('COMMIT');

        return {
            received: ads.length,
            upserted,
            message: 'Ads saved successfully',
            ads: ads.map((ad) => {
                const pictureUrls = normalizePictureUrls(ad);

                return {
                    adsId: String(ad.id),
                    title: ad.title || null,
                    description: ad.description || null,
                    firstPictureUrl: ad.firstPictureUrl || null,
                    pictureUrls,
                    url: ad.url || null,
                    priceText: ad.price || null,
                    priceAmount: parsePrice(ad.price || null),
                    locationText: ad.locationText || extractLocation(ad.tags),
                    locationCity: ad.locationCity || null,
                    locationPostalCode: ad.locationPostalCode || null,
                };
            }),
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
