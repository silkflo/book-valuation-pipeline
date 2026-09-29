# Live integration notes

The default review path is `npm test`; it does not run the application server or contact providers.

The original live deployment also depended on components outside this repository:

- Apify Actors for listing collection, optional ISBN search, Google Lens and the legacy Momox fallback. Their expected input fields are constructed in the corresponding `src/services/` modules.
- A PostgreSQL schema containing the original `ads`, `books` and `processing_jobs` tables. Incremental SQL files under `scripts/sql/` extend that schema and add job-event, provider-job and cost tables. They cannot bootstrap an empty database by themselves.
- A separately deployed frontend consuming the admin and job-status endpoints.
- Provider accounts and an HTTPS endpoint for Apify callbacks.

## Configuration

`.env.example` lists the core service, actor, provider and worker settings, plus the original AI-cost controls. Values are placeholders. Start with workers and paid-provider features disabled; enable the features required by your deployment after the database and Actors are configured.

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | Application PostgreSQL connection |
| `WEBHOOK_SECRET` | Authentication for callbacks and administration |
| `PUBLIC_WEBHOOK_BASE_URL` | HTTPS base URL reachable by Apify |
| `APIFY_TOKEN` | Primary Apify account token |
| `APIFY_MANUAL_AD_ACTOR_ID`, `APIFY_SEARCH_PAGE_ACTOR_ID` | Listing-collection Actors |
| `SCRAPFLY_KEY` | Scrapfly account key |
| `OPENAI_API_KEY` | AI extraction and verification |
| `APIFY_TOKEN2`, `GOOGLE_LENS_ACTOR_ID` | Optional visual-search fallback |
| `LENS_PUBLIC_BASE_URL` | Public URL for temporary cover crops |
| `ISBNSEARCH_APIFY_ACTOR_ID`, `MOMOX_ACTOR_ID` | Optional legacy Actor fallbacks |

The example retains the project's model choices; verify model availability and configure actual prices before relying on cost estimates. A configured price of zero records zero monetary cost, while token counts can still be tracked.

## Deployment boundaries

The existing administration routes use a shared secret. Keep them behind a restricted gateway; this repository does not include multi-user authentication or tenant isolation. Prefer the supported secret headers for clients that can send headers, and redact query strings in infrastructure logs where callback secrets are present.

Provider concurrency is limited per Node.js process. Multiple instances would require a shared limit. Stale-job recovery uses time thresholds, so long-running jobs and retry policy need deployment-specific validation.

Once the missing schema and Actors are supplied, `npm start` starts the Express service. This portfolio cleanup did not execute a live collection, validate current provider markup, or migrate a database.
