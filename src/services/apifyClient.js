//src\services\apifyClient.js
import { ApifyClient } from 'apify-client';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.APIFY_TOKEN) {
    console.warn('Missing APIFY_TOKEN. Momox actor trigger will fail until it is set.');
}

export const apifyClient = new ApifyClient({
    token: process.env.APIFY_TOKEN,
});
