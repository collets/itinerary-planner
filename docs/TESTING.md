# Verification

`pnpm check` runs TypeScript, ESLint, domain/API tests and the production PWA build. `pnpm test:e2e` uses an isolated temporary store and the actual production build.

Mobile Chromium and mobile WebKit workflows cover full-day overview, stop/leg navigation, route POIs, visible timing, no horizontal page overflow, progress, shared ticket upload, traveler filters, explicit offline download, offline deep-link reload, dated EUR budget display, offline checklist synchronization, and first-time PDF rendering offline.

The Vercel adapter test checks that native API rewrites preserve HTTPS Origin and Secure cookies. API tests exercise authentication, cross-origin rejection, concurrency/ETags, snapshot restores, private original bytes, invalid file signatures, attached-step validation, plan dry runs/patches, machine-readable schemas and exchange-rate caching/outage fallback. These tests use fictional places and test credentials.

WebKit tests stop the local origin server to verify cached navigation. Playwright 1.63 has an [upstream offline-emulation bug](https://github.com/microsoft/playwright/issues/42775) that rejects service-worker requests when `context.setOffline(true)` is used even if the worker returns a literal cached response. Chromium uses standard browser offline emulation. The test-only control port (3002) is confined to `scripts/e2e-server.ts` and is never part of the production API.

Browser device profiles do not replace a physical phone check. Before travel, open each required ticket in airplane mode on each real device. Native iOS home-screen behavior and large, scanned or unusual PDFs may differ from automated browser-engine tests; download the original file as a fallback.
