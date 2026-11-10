# GitHub workflow

After completing and validating changes, commit and push them to the `staging` branch on GitHub.

Keep `main` unchanged unless the user explicitly requests a merge or release to `main`.

Include the rebuilt `dist` bundles when extension source changes.

# UUIDs

Generate UUIDs only with the documented backend `spindle.uuid.v4()` API. Frontend callers use `src/uuid-client.ts` and the document-targeted backend handler in `src/uuid-host.ts`; the frontend SDK does not expose a UUID generator. Require the `uuid-v1` and `frontend-session-routing-v1` host capabilities and fail clearly when unavailable. Do not restore local UUID generators or browser-crypto fallbacks. Keep the plain-HTTP, routing, cancellation, and bundle regression checks. Random bytes used for non-UUID security challenges are a separate concern.

Verified against `lumiverse-spindle-types` 0.6.79 and Lumiverse staging 1.3.0 on 2026-11-10; see `PLATFORM-AUDIT.md`. Follow the user's explicit branch/publishing instructions over the default workflow above.
