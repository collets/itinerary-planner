# Passo

A mobile-first, Italian itinerary app. Code and documentation are in English. Trips are location-independent, validated JSON documents served through a private API.

See the [security audit and hardening report](docs/SECURITY-AUDIT.md) for verified
protections, remaining dashboard tasks and mandatory safeguards before paid AI.

## Included

- Continuous overview of the entire trip with day navigation, visible hours, stop cards and route connectors.
- Detailed stop/route pages with horizontal swipe navigation, practical information, sources, booking links, street guides, points of interest and external Google Maps directions.
- Offline travel editing: delays, durations, departure, skip/reinclude, reorder/move, quick stops and shared notes, with preview, fixed booking protection, undo and original-day restore.
- Shared progress and preparation checklist, including offline edits and explicit conflict resolution.
- Private PDF/PNG/JPEG tickets (up to 10 MB) assigned to one or several travelers. Booking slots and paid group totals are separate from planned schedules and estimated budgets.
- Installable web app; explicit downloads save itinerary data and selected original tickets to the current device. PDF rendering assets are cached with the app.
- Original-currency budgets and approximate EUR equivalents using dated ECB rates through Frankfurter, with a 24-hour refresh cache and saved rates available offline.
- Agent CLI for JSON/YAML import, plan updates, patches, validation, alternatives, tickets and plan history.
- Optional Italian AI assistant with full-screen conversation, reviewable itinerary/route widgets,
  protected bookings, explicit approval and offline drafts. Disabled by default; the
  feature branch includes a free local demo and gated live adapters.

## Local startup

Requires Node 24 and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm run setup
pnpm dev
```

Open http://localhost:5173. The setup script creates an ignored `.env.local`, an access key in `local-data/access-key.txt`, and a fictional example trip. Enter the key in the login screen. Setup preserves existing files. **Use `pnpm run setup`: `pnpm setup` is pnpm's own environment command.**

To check the app:

```sh
pnpm check
pnpm exec playwright install chromium webkit
pnpm test:e2e
```

The browser tests use a separate temporary store and the production build, including service-worker offline navigation. Run `pnpm build` before them. `pnpm preview` previews static files only; use `pnpm dev` for the API or the dedicated test server during tests.

## AI feature development

Work is isolated on `feature/ai-assistance`. Run `pnpm ai:demo` for the local,
network-free example and open the assistant button beside logout. The demo
preserves local setup; its small synthetic interpreter is not a live LLM.
See [AI development and owner setup](docs/AI-DEVELOPMENT.md) for implemented scope,
durable spending limits, operator commands, provider/account prerequisites and
verification limitations. Paid use and feature-branch Vercel deployment each
require explicit configuration; no production AI is enabled automatically.

## Managing trips

See [data guide](docs/DATA.md), [API reference](docs/API.md), [deployment guide](docs/DEPLOYMENT.md) and [architecture](docs/ARCHITECTURE.md), and [verification notes](docs/TESTING.md).

```sh
pnpm trip travel another-trip local-data/change.json --dry-run
pnpm trip travel another-trip local-data/change.json
pnpm trip list
pnpm trip create another-trip local-data/new-trip.yaml
pnpm trip pull another-trip local-data/new-trip.json
pnpm trip validate local-data/new-trip.json
pnpm trip diff another-trip local-data/new-trip.json
pnpm trip push another-trip local-data/new-trip.json --dry-run
pnpm trip push another-trip local-data/new-trip.json
```

The CLI uses the agent token in `.env.local` locally; set `ITINERARY_API_URL`, `ITINERARY_API_TOKEN` and optionally `ITINERARY_ENV_FILE` for a deployed app. Exported data and tickets belong under ignored `local-data/`, never in this public repository.

## Storage and hosting

React + Vite + TypeScript, React Router, TanStack Query, Zod, Dexie, Workbox and PDF.js. Hono serves native Vercel Node Functions. Local development uses files; Vercel uses a **private** Blob store for trip documents, plan snapshots and original ticket files. No database or external authentication service is required. The app uses a shared browser access key, a signed HttpOnly cookie and a separate agent token.

Vercel Hobby and Blob's included quotas suit a small personal app. Quotas are finite; no paid plan is necessary to start. Each device needs an explicit offline download. External booking sites and navigation need connectivity. Offline copies cannot be remotely erased while a device is disconnected. Automatic directions follow the selected POI waypoints; the written street guide is advisory rather than turn-by-turn navigation.
