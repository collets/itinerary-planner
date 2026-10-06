# Verification

## AI assistance

The feature branch adds ledger concurrency/rollover/uncertain-charge tests,
bounded synthetic intent evaluation cases, context privacy, atomic proposals,
discovered stops, atomic middle-stop replacement with both connecting routes and
undo, follow-up ownership, protected bookings, independent operator
auth and provider HTTP contract tests. All providers are mocked; no API keys or
paid model calls are needed. Browser tests additionally cover the header
assistant's full-screen chat, approval, follow-up, cached/offline draft,
logout cleanup, stop selection from cards/details/header, replacement demo limits,
targeted timing changes, and a manual draft plus route/POI proposal. Tests use fictional
data and an isolated temporary file store. These checks do not evaluate real
model quality, physical-phone behavior or routing/account configuration; those
remain explicit live-evaluation gates in [AI-DEVELOPMENT.md](AI-DEVELOPMENT.md).

`pnpm check` runs TypeScript, ESLint, domain/API tests and the production PWA build. `pnpm test:e2e` uses an isolated temporary store and the actual production build.

If the local app occupies the default ports, set `E2E_PORT_OFFSET=20` for an
isolated test server at 5193 (API 3021, control 3022). The default ports used by CI
remain unchanged.

The localhost-only test control endpoint recreates the application between tests
to isolate process-local throttles. It preserves real throttle thresholds,
storage and the durable budget ledger. API tests separately verify the 30/minute
AI mutation limit. This control endpoint is never included in the deployed API.

Every production build also runs `pnpm check:server`: TypeScript compiles the API and domain code with NodeNext resolution, then plain Node imports the emitted JavaScript and checks health and secure login. Server imports use explicit `.js` extensions so Vercel's native ESM loader can resolve them. This check does not use Vite or tsx, which accept extensionless imports that fail in production.

Mobile Chromium and mobile WebKit workflows cover full-day overview, stop/leg navigation, route POIs, visible timing, no horizontal page overflow, progress, shared ticket upload, traveler filters, explicit offline download, offline deep-link reload, dated EUR budget display, offline checklist synchronization, and first-time PDF rendering offline.

The Vercel adapter test checks that native API rewrites preserve HTTPS Origin and Secure cookies. API tests exercise authentication, cross-origin rejection, concurrency/ETags, snapshot restores, private original bytes, invalid file signatures, attached-step validation, plan dry runs/patches, machine-readable schemas and exchange-rate caching/outage fallback. These tests use fictional places and test credentials.

WebKit tests stop the local origin server to verify cached navigation. Playwright 1.63 has an [upstream offline-emulation bug](https://github.com/microsoft/playwright/issues/42775) that rejects service-worker requests when `context.setOffline(true)` is used even if the worker returns a literal cached response. Chromium uses standard browser offline emulation. The test-only control port (3002) is confined to `scripts/e2e-server.ts` and is never part of the production API.

Browser device profiles do not replace a physical phone check. Before travel, open each required ticket in airplane mode on each real device. Native iOS home-screen behavior and large, scanned or unusual PDFs may differ from automated browser-engine tests; download the original file as a fallback.

## Travel editing coverage

Domain/API tests cover cascading delays and spare time, booked anchors, archive/reinclude, independent versus conflicting notes/day changes, safe undo and restore, actual departure, multi-leg route preservation, cross-day moves, serialization-stable preconditions, idempotent retries, V1 update requirements and disabled-editing reads. Browser tests run on Chromium and WebKit: reorder with an explicit provisional route, annotate, reload offline, archive/reinclude, reconnect and drain the ordered journal; two independent browser sessions retain a conflicting day change until comparison, preview and confirmation. Existing mobile navigation and offline image/PDF ticket tests remain in the same suite.

For manual staging validation, use the real itinerary copy for layout and the separate **Laboratorio di viaggio** for edits. Its booking and tickets are labelled ESEMPIO. Try a delay that fits, a delay that crosses the museum booking, skip the booked museum after acknowledging the reservation, reinclude it, move a flexible visit to day two, add a stop with route estimates, inspect original/history, then repeat an offline change and a simultaneous change from the other phone. Verify both ticket owners and the budget's original-estimate label.
