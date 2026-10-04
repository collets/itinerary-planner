# Contributor and itinerary agent instructions

- Code/documentation English; all product-facing text Italian.
- Node 24, pnpm 10. Quick start: `pnpm install`, `pnpm run setup`, `pnpm dev`.
- Run `pnpm check`; production browser checks: `pnpm exec playwright install chromium webkit`, `pnpm test:e2e`.
- Trip edits: read `docs/DATA.md` and `docs/API.md`. Use the CLI or authenticated API, stable IDs and ETags. Preserve live operational state. Resolve 412 by re-reading and merging.
- Personal source itineraries, JSON/YAML exports, tickets and credentials belong in ignored `local-data/`. This repository is public: never add those files to Git, never put them in frontend bundles, and never log credentials.
- All serving/storage paths must remain private and authenticated. Never switch ticket storage to public Blob.
- Changes to source verification dates/prices/routing need evidence; label uncertain material as an estimate. Do not invent reservations or coordinates.
- Keep domain schemas/utilities independent of React so they remain reusable later.
- Use the shared ordered stop/leg sequence in both itinerary modes.
