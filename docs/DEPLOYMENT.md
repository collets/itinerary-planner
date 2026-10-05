# Deploy to Vercel

## Fast setup

1. Push this repository to GitHub and import it into Vercel. Select Vite, Node 24, install `pnpm install --frozen-lockfile`, build `pnpm build`, output `dist`.
2. Create a **private** Vercel Blob store in a European region such as Frankfurt. Connect it to the project's **production** environment. New connections use OIDC and provide `BLOB_STORE_ID` (with `BLOB_WEBHOOK_PUBLIC_KEY` for callbacks). Existing token connections use `BLOB_READ_WRITE_TOKEN`. Use a different private store for preview deployments; do not share production travel documents/tickets with previews.
3. Run `pnpm run setup` locally to generate credentials if not already done. Add server environment variables below. Only copy hashes/session secret to Vercel; retain the raw browser key and raw agent token privately.
4. Deploy. Native `api/index.ts` serves the versioned Hono API; `vercel.json` routes API requests before the SPA fallback.
5. Point the CLI to the HTTPS deployment using an ignored environment file and import your plan. On each device, log in with the browser key and explicitly download the trip and wanted tickets.

| Variable                  | Value                                              |
| ------------------------- | -------------------------------------------------- |
| `STORAGE_DRIVER`          | `blob`                                             |
| `BLOB_STORE_ID`           | Automatically provided by an OIDC store connection |
| `BLOB_WEBHOOK_PUBLIC_KEY` | Automatically provided for OIDC upload callbacks   |
| `BLOB_READ_WRITE_TOKEN`   | Only for legacy token connections                  |
| `APP_ACCESS_KEY_HASH`     | SHA-256 of shared browser access key               |
| `AGENT_API_TOKEN_HASH`    | SHA-256 of separate agent token                    |
| `SESSION_SECRET`          | At least 32 random characters                      |

No client environment variables or database setup are required. The local `.env.local` additionally holds `ITINERARY_API_TOKEN` for the CLI; **never add the raw token as a public/client environment variable**. For production, use independently generated credentials rather than example/test keys. `local-data/access-key.txt` is an ignored convenience file; send it to your spouse through your preferred private channel.

```sh
# local-data/production.env is ignored and contains API URL + agent token
ITINERARY_ENV_FILE=local-data/production.env pnpm trip create my-trip local-data/my-trip.json
ITINERARY_ENV_FILE=local-data/production.env pnpm trip list
```

## Verification before travel

- Unauthenticated `/api/v1/trips` must return 401.
- Log in and open both views. Check dates, actual booked slots and timing buffers.
- Upload a test PDF and verify the original is private and opens correctly.
- Save the trip offline, wait for confirmation, switch to airplane mode and reload a deep link. Check itinerary and each needed ticket.
- Reconnect and verify shared progress/checklist synchronization on a second device.
- Install to the home screen if desired. Offline downloads are specific to each browser/device; opening another browser does not reuse them.

## Quotas, backup and maintenance

The personal app targets Vercel Hobby with private Blob's included free quotas; these are subject to Vercel's current plan limits. No paid upgrade is required by the code. Check storage/operation/transfer usage in the dashboard. The application caches queries and exchange rates to limit requests and retains only 20 plan snapshots, but document writes and ticket downloads still consume quota. Hobby is intended for personal, non-commercial use.

Back up full document exports and ticket originals privately before substantial plan changes. `pnpm trip export ... --include-state` exports metadata only. Cached device data is not the cloud backup. Rotate the browser key hash and session signing secret to invalidate online sessions; rotate the agent token hash separately. Offline devices retain data until reconnect/session expiry/local deletion. Logout clears downloaded data on the current device.

Preview deployments require independently configured credentials and storage. An unconfigured Vercel deployment refuses file storage rather than silently writing ephemeral data. Never commit an itinerary, ticket, raw key or production environment file to the public repository.

## Local development on restricted machines

If Corepack cannot write its home cache, set `COREPACK_HOME=/tmp/itinerary-corepack`. A local pnpm store can be supplied with `pnpm install --store-dir /tmp/itinerary-pnpm-store`. Network/package/browser installs and listening servers may require the execution environment's approval. These are tooling constraints rather than additional services required by the app.

## Staging and travel editing rollout

Use the `staging` Git branch for Vercel Preview deployments. Keep `main` as the production branch. Connect `itinerary-planner-staging` private Blob store to **Preview only**; production must keep its independent store and token. Set preview-only, branch-specific credentials (`APP_ACCESS_KEY_HASH`, `AGENT_API_TOKEN_HASH`, `SESSION_SECRET`), `STORAGE_DRIVER=blob`, `APP_ENVIRONMENT=staging`, and `TRAVEL_EDITING_ENABLED=true`. The staging UI has a visible environment label. Never weaken Vercel preview protection to test this feature; open the preview through your authorized Vercel account.

Before production promotion, validate delay/anchor errors, skip/reinclude and ticket retention, new provisional routes, empty days, original/history, offline reload and reconnect, plus simultaneous edits from two devices. Back up the production document and original tickets, merge the reviewed branch, then update each installed app. Older clients receive 426 after the first V2 edit and must install the update. `TRAVEL_EDITING_ENABLED=false` is the rollback switch: disable editing while retaining readable V2 data. Reverting to V1-only code cannot read upgraded trips safely.

### One-time private staging seed

The optional build hook `scripts/seed-staging.ts` runs only with `APP_ENVIRONMENT=staging`, an encrypted `STAGING_SEED` (base64 gzip of `{id,plan}`), and `STAGING_SEED_STORE_ID` exactly equal to the connected `BLOB_STORE_ID`. It creates missing documents, never replaces existing trips, and adds a separate two-day demonstration itinerary with clearly labelled sample reservations and per-person tickets. Private source data never enters Git or client assets. After the first successful seeded build, clear `STAGING_SEED`; later builds then do nothing. OIDC provides build/runtime access without copying or revoking production credentials.
