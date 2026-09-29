//src\server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import apifyWebhookRouter from './routes/apifyWebhook.js';
import adminRouter from './routes/adminRoutes.js';
import { testDbConnection } from './db.js';
import { lensPublicBaseUrl } from './services/lensFallback.js';
import { startJobWorkers } from './services/jobWorkers.js';
import { startApifyStartWorkers } from './services/apifyStartWorkers.js';
import { startProviderPriceWorker } from './services/providerPriceWorker.js';
import { logAiConfigOnce } from './services/aiUsage.js';

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3006;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use('/uploads', express.static(path.join(projectRoot, 'public', 'uploads')));

app.get('/health', (req, res) => {
    res.json({
        success: true,
        service: 'books-sell-webhook',
        environment: process.env.NODE_ENV || 'unknown',
        timestamp: new Date().toISOString(),
    });
});

app.use('/webhooks', apifyWebhookRouter);
app.use('/admin', adminRouter);

async function startServer() {
    try {
        await testDbConnection();
        startJobWorkers();
        startApifyStartWorkers();
        startProviderPriceWorker();
        app.listen(PORT, () => {
            console.log(`Books Sell webhook listening on port ${PORT}`);
            logAiConfigOnce(); // [ai-config] line + one-time zero-price warning
            console.log(`[lens-fallback] publicBaseUrl=${lensPublicBaseUrl() || '(unset — set LENS_PUBLIC_BASE_URL on VPS)'}`);
            console.log(`Health check: http://localhost:${PORT}/health`);
            console.log(`Webhook endpoint: http://localhost:${PORT}/webhooks/apify`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
