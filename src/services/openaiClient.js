//src\services\openaiClient.js
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.OPENAI_API_KEY) {
    console.warn('Missing OPENAI_API_KEY. OpenAI ISBN extraction will fail until it is set.');
}

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
