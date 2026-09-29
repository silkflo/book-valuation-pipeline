# Book valuation pipeline

A Node.js backend for collecting second-hand book listings, identifying books and editions, and comparing buyback offers from Gibert and Momox.

Developed by **Florian Assous** as a personal project. The commercial experiment was discontinued because the available resale margins were too low. This repository preserves the collection, validation and job-processing code as a technical work sample, with synthetic fixtures for offline review.

**Stack:** JavaScript (ES modules), Node.js, Express, PostgreSQL, Apify, Scrapfly, Cheerio, Sharp and OpenAI.

## Start here

| Concern | Entry point |
| --- | --- |
| Gibert browser scenario and missing-result detection | [`gibertScrapflyBatchService.js`](src/services/gibertScrapflyBatchService.js) |
| Provider failure handling and bounded fallbacks | [`updateGibertBatch.js`](src/services/updateGibertBatch.js) |
| Webhooks, failure events and queued processing | [`apifyWebhook.js`](src/routes/apifyWebhook.js) |
| Duplicate prevention and PostgreSQL job claiming | [`processingJobs.js`](src/services/processingJobs.js) |
| Worker retries and recovery | [`jobWorkers.js`](src/services/jobWorkers.js) |
| Manual provider jobs and concurrency control | [`providerPriceJobs.js`](src/services/providerPriceJobs.js), [`providerLookupLimiter.js`](src/services/providerLookupLimiter.js) |
| Listing-to-valuation orchestration | [`processApifyPayload.js`](src/workflows/processApifyPayload.js) |
| Job progress and review endpoints | [`adminRoutes.js`](src/routes/adminRoutes.js), [`jobEvents.js`](src/services/jobEvents.js) |

## Workflow

1. An Apify Actor collects listing metadata and image URLs from Leboncoin. Webhooks notify the Express backend; the backend queues processing and retrieves the Actor output.
2. The pipeline extracts book candidates from listing text and photographs, generates cover crops, and searches ISBN/catalogue sources. AI assists identification and matching; deterministic checks and confidence rules decide which candidates can proceed.
3. Accepted ISBNs are submitted to Gibert and Momox in batches. Provider-specific adapters parse offers and preserve missing, failed, rejected and successful outcomes separately.
4. PostgreSQL stores listings, candidates, results, job events and costs. Admin endpoints expose progress, review information and manual price requests.

## The difficult source: Gibert

Browser automation in the original Apify runs remained blocked by Cloudflare challenges despite trying different proxies, including residential proxies. I changed the collection approach to **Scrapfly's API-driven browser rendering**.

The implementation opens Gibert's buyback page, handles the ISBN form and cookie-consent state, submits a batch, and parses the resulting product rows. It does not call a documented Gibert API directly.

The important failure distinction is between an explicit **"non repris"** row (a valid no-offer result) and a submission that returns **no product rows** (a technical failure). The code records request identifiers and scenario diagnostics, reports missing ISBNs, and avoids repeatedly retrying a broken form as though it were a normal missing book. Screenshot capture is optional because it adds provider cost.

[`test-gibert-results.mjs`](scripts/test-gibert-results.mjs) exercises the actual adapter with mocked HTTP responses for empty batches, genuine no-offer results, partial responses and HTTP rejection.

## Reliability and cost decisions

- **Duplicate webhooks:** processing jobs use an idempotency key; duplicate delivery does not create another processing job.
- **Concurrent workers:** PostgreSQL claims use `FOR UPDATE SKIP LOCKED`. Stale jobs can be recovered, and exhausted attempts are failed instead of left locked indefinitely.
- **Bounded work:** batch sizes, retry limits and confidence gates limit repeated or low-value provider requests.
- **Provider pressure:** a shared in-process limiter caps simultaneous paid lookups. It is not a distributed rate limiter.
- **Observability:** job events, stages, errors, missing results and provider costs support investigation and manual review.

## Run the offline checks

Requires Node.js 24 or newer.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
```

No `.env`, database or provider account is needed for these checks. The runner uses placeholder configuration, ignores local `.env` files and blocks network access. Parser fixtures are minimal synthetic examples, not captured browser sessions. Image tests generate their own temporary images.

The suite includes executable parsing, matching, eligibility and provider-response tests. Some inherited queue checks inspect source structure; they do not establish runtime database correctness. Two database-backed integration scripts (`test-lart-provider-send.mjs` and `test-provider-fanout.mjs`) are excluded from the offline command. A GitHub Actions workflow runs the offline checks on pushes and pull requests.

## Repository scope

This is the **backend portion** of the original project. The separately deployed Apify Actor source, review frontend, original initial database schema and operational dataset are not included. The SQL files in [`scripts/sql/`](scripts/sql/) are incremental migrations, not an empty-database bootstrap.

Offline checks are reproducible from this repository. Running the full live workflow additionally requires compatible Actors, the application schema, provider credentials and an HTTPS webhook endpoint; see [live integration notes](docs/LIVE_INTEGRATION.md).

Known limits are retained explicitly: some orchestration modules are large, shared-secret administration is intended for a restricted deployment, and provider markup can change. Offline tests do not establish present-day site availability, production throughput or commercial viability.
