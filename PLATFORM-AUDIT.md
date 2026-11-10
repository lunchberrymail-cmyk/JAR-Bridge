# JAR-Bridge platform audit — partial migration

This review does **not** certify the entire extension as compliant with the requested supported-interface boundary. UUID generation is migrated; the existing gaps below remain unresolved. The user subsequently authorized local testing and a staging push after successful validation. No main merge or release is included.

## What changed

Baseline: staging `698fb3a`, extension version 0.8.0. Release version is unchanged.

- Removed `src/uuid.ts`. Its only production caller was `src/client.ts`, which now obtains its request-ID UUID prefix from the official host API.
- Added `src/uuid-client.ts` and `src/uuid-host.ts`; registered the UUID handler in the existing backend with cleanup.
- Kept client construction synchronous and made UUID initialization asynchronous. Requests wait for initialization; replacing/cancelling/closing a pending request rejects immediately and does not send a late JAR job.
- A failed UUID startup attempt is now discarded, so an explicit user retry requests a fresh official host UUID. Concurrent requests still share one pending initialization; cancellation, disposal and late-reply isolation remain intact. Timeout, send failure, invalid reply, host generation failure and explicitly unsupported host replies have distinct guidance. A timeout no longer claims the host lacks `uuid-v1`.
- Pinned SDK 0.6.79 and updated the lockfile. Separated browser and Bun backend build targets and rebuilt both shipped bundles.
- Updated regression fixtures for asynchronous host IDs and replaced the obsolete AGENTS UUID instruction.
- Kept the 32-byte random ownership challenge in `owner-binding.ts`. It is a cryptographic token, not a UUID. Kept native/fallback content SHA-256 hashing in `content-hash.ts` for HTTP compatibility; hashing is not UUID generation.
- Added `bun run typecheck`, a strict production-source tsconfig, TypeScript 7.0.2, and CSS module declarations. Native SHA-256 now copies the supplied byte view into an ArrayBuffer-backed Uint8Array accepted by WebCrypto; this fixes its BufferSource type mismatch and preserves exact content identities, subarray boundaries, shared-buffer input and the plain-HTTP fallback.
- Updated README compatibility requirements to agree with the manifest. No runtime package dependency or new permission was introduced.

## Verified contracts and compatibility

Reviewed on 2026-11-10 against the current official SDK `lumiverse-spindle-types@0.6.79` (npm registry and official repository agree), SDK commit `fe412d6e378466dfe42a2df16649fa037e428c06`, and official Lumiverse staging commit `68c0fa961f0ef4cffa72ee0557aaadffa3ced2f1` (version 1.3.0). Official main at `45f8db563e1c314ed2aab227613b28eb5ea1084e` reports 1.2.5 and does not contain this UUID contract. This is snapshot evidence, not a claim about the first release that will include the feature.

- [Backend UUID documentation](https://github.com/prolix-oc/Lumiverse/blob/68c0fa961f0ef4cffa72ee0557aaadffa3ced2f1/developer-docs/docs/backend-api/uuid.md): `await spindle.uuid.v4(): Promise<string>`; free, no user ID or permission. `v7()` is also documented but unnecessary here.
- [Published UUID types](https://github.com/prolix-oc/lumiverse-spindle-types/blob/fe412d6e378466dfe42a2df16649fa037e428c06/src/uuid.ts), [SpindleAPI.uuid](https://github.com/prolix-oc/lumiverse-spindle-types/blob/fe412d6e378466dfe42a2df16649fa037e428c06/src/spindle-api.ts), [frontend context](https://github.com/prolix-oc/lumiverse-spindle-types/blob/fe412d6e378466dfe42a2df16649fa037e428c06/src/dom.ts): UUID generation is backend-only; the frontend context has no UUID generator.
- [Frontend messaging](https://github.com/prolix-oc/Lumiverse/blob/68c0fa961f0ef4cffa72ee0557aaadffa3ced2f1/developer-docs/docs/frontend-api/backend-communication.md) and [backend messaging/routing](https://github.com/prolix-oc/Lumiverse/blob/68c0fa961f0ef4cffa72ee0557aaadffa3ced2f1/developer-docs/docs/backend-api/frontend-communication.md): `ctx.sendToBackend(payload)`, `ctx.onBackendMessage(handler)`, `spindle.onFrontendMessage((payload,userId,frontendSessionId) => ...)`, and `spindle.sendToFrontend(payload,userId,{frontendSessionId})`.
- [Manifest/version rules](https://github.com/prolix-oc/Lumiverse/blob/68c0fa961f0ef4cffa72ee0557aaadffa3ced2f1/developer-docs/docs/getting-started/manifest.md) and [permissions](https://github.com/prolix-oc/Lumiverse/blob/68c0fa961f0ef4cffa72ee0557aaadffa3ced2f1/developer-docs/docs/getting-started/permissions.md).

Both the backend `uuid-v1 >= 1` and `frontend-session-routing-v1 >= 1` capabilities are required. The manifest minimum is now 1.3.0; runtime checks still apply because a version number alone does not prove capability availability. There is no new permission or scanner capability declaration. Frontend requests use a monotonically increasing correlation counter, not a locally generated UUID. Backend replies use only host-supplied account/document identity. Missing support produces a bounded failure with no local generator or broadcast fallback.

Remote plain HTTP remains supported by the UUID path: it requires neither `crypto.randomUUID`, browser crypto, HTTPS, nor a new secure-context feature. Regression tests remove browser crypto entirely. No live remote-host installation or mobile-device test was performed for these changes.

Ordinary DOM construction, browser JavaScript, and non-UUID crypto were not presumed forbidden. [UI placement](https://github.com/prolix-oc/Lumiverse/blob/68c0fa961f0ef4cffa72ee0557aaadffa3ced2f1/developer-docs/docs/frontend-api/ui-placement.md) explicitly renders native DOM nodes in host-owned roots. [Backend capabilities](https://github.com/prolix-oc/Lumiverse/blob/68c0fa961f0ef4cffa72ee0557aaadffa3ced2f1/developer-docs/docs/getting-started/capabilities.md) describes specific backend restrictions; it does not prohibit every crypto operation.

## Other platform interactions

| Finding | Evidence / status |
| --- | --- |
| Networking to local JAR | Supported path: `spindle.cors(url, options)` in `transport.ts`; [official CORS docs](https://github.com/prolix-oc/Lumiverse/blob/68c0fa961f0ef4cffa72ee0557aaadffa3ced2f1/developer-docs/docs/backend-api/cors-proxy.md) explicitly allow loopback/private integrations. Options method/headers/body/responseType match SDK RequestInitDTO. cors_proxy is declared; grants are checked before/after asynchronous requests, in addition to host enforcement. No native backend fetch, socket, process or filesystem transport was introduced. |
| Backend persistence | `spindle.storage.read/write/exists` for installation.json and jar-links.json is supported [scoped storage](https://github.com/prolix-oc/Lumiverse/blob/68c0fa961f0ef4cffa72ee0557aaadffa3ced2f1/developer-docs/docs/backend-api/storage.md). Operator installations share this directory; personal installations do not. The link index is therefore installation-wide by design; use userStorage if product requirements change to per-account archives. This is a scoping recommendation, not a blanket violation. |
| Account/document targeting | Existing backend uses host-supplied message identity, checks user roles and ownership proofs, and targets replies by session. No caller-supplied user ID is trusted by the new UUID path. |
| Scope detection | **Unverified semantic dependency:** `owner-binding.ts` distinguishes personal/operator scope by the exact error text from `users.getRole()` without a user ID. The SDK documents getRole(userId?) and operator/user scoping, but not that error string as a stable scope-discovery API. No supported explicit installation-scope accessor was verified. Existing fail-closed behavior remains; no substitute identity API was invented. |
| Attach lorebooks | Uses `spindle.world_books.get` and `spindle.characters.get/update` with authenticated userId and characters/world_books grants, matching the [backend SDK](https://github.com/prolix-oc/lumiverse-spindle-types/blob/fe412d6e378466dfe42a2df16649fa037e428c06/src/spindle-api.ts). Existing metadata parity should be reviewed before any broader import migration. |
| UI integration | Drawer tab, modal, navigation through host surfaces, permission requests and event notifications use documented context surfaces. See [UI placement](https://github.com/prolix-oc/Lumiverse/blob/68c0fa961f0ef4cffa72ee0557aaadffa3ced2f1/developer-docs/docs/frontend-api/ui-placement.md) and [host surfaces](https://github.com/prolix-oc/Lumiverse/blob/68c0fa961f0ef4cffa72ee0557aaadffa3ced2f1/developer-docs/docs/frontend-api/host-surfaces.md). No private frontend store or host-function monkeypatch was found in reviewed production source. |
| Browser storage | localStorage holds guide dismissal, account-switch tip and the vectorize preference, not credentials or archives. No documented blanket prohibition was found. ctx.settings/userStorage may improve per-account/host consistency; this is a recommendation. |
| Application REST imports | **Unverified as extension contracts:** character import, world-book import and chat migration use same-origin application REST with manual grant checks. Supported CRUD exists, but exact native import/migration parity (including extension metadata, identities, messages and format behavior) was not verified through a supported extension interface. These paths remain unresolved. |
| Summaries/embeddings/vectorization REST | **Unresolved:** character summaries, embeddings config and world-book convert-to-vectorized are direct application calls. In particular, a durable conversion through REST is not demonstrated to receive the same extension permission enforcement as a Spindle method. No exact supported conversion interface was verified. Do not infer a complete permission solution by adding arbitrary permissions. |
| Non-UUID crypto | Random challenge bytes and content hashing have distinct security purposes. The reviewed backend scanner rules contain no blanket crypto prohibition. They were not replaced with UUIDs or removed merely for using crypto. |

### Existing REST call-site inventory

All are under `/api/v1`.

- `import-flow.ts`: POST /characters/import and POST /world-books/import.
- `chat-import.ts`: POST /migrate/chats.
- `chats-ui.ts` and `lorebooks-ui.ts`: GET /characters/summary.
- `lorebooks-ui.ts`: GET /embeddings/config and POST /world-books/:id/convert-to-vectorized.

## Validation

- Build: passed; browser frontend and Bun backend rebuilt.
- Full suite plus new regression coverage: **202 passed, 0 failed** (13 files).
- Strict TypeScript 7.0.2 against pinned SDK 0.6.79: **all production TypeScript passed** via `bun run typecheck`. Passing types is not certification of supported-interface compliance.
- Upstream staging backend scanner, executed unchanged on the rebuilt backend: **no findings**, no opt-outs. This does not establish installation approval or all permission semantics.
- Production source/shipped bundles: no custom UUID generator or randomUUID call; one official UUID v4 call in the backend. The remaining getRandomValues call is the 32-byte ownership challenge, including in dist/backend.js.
- Tests cover UUID routing/missing support/no browser crypto/timeout/teardown, pending-initialization cancellation, ownership proof isolation and existing imports, lorebooks, permissions, cleanup and request handling.
- Hash regressions verify the selected byte range and SharedArrayBuffer-backed input produce the same SHA-256 as native UTF-8 text hashing; the existing LAN HTTP cases also pass.
- Follow-up UUID regressions verify recovery after startup timeout/send failure, rejection of a late response from the previous attempt, disposal while retrying, and update guidance only after an explicit unsupported-host response.
- The local Lumiverse 1.3.0 checkout's existing UUID suite passed **4 tests / 158 assertions**, including actual worker/process transport.
- Signed-in live test at `http://127.0.0.1:7860/`: backed up installed runtime files, deployed this manifest and both rebuilt bundles, restarted through the native Extensions UI, and reloaded. The import assistant opened normally. With JAR stopped, Check JAR connection returned the expected actionable connection failure. Started the existing local JAR on loopback for the test; the same check then reported **JAR 0.4.0 is running**. This exercises asynchronous host UUID initialization, document-targeted messaging, existing permissions and the supported backend CORS transport. No browser console errors were recorded. No archive import, JanitorAI login, capture or LLM request was performed; live import parity and mobile/LAN operation are not established by this smoke test.
- git diff --check passed. Staging delivery is authorized; main and release versions remain unchanged.

## Follow-up on the usual server

The signed-in native Diagnostics UI at `lumiverse.lunchrelay.win` reported frontend/backend 1.3.0 and staging commit `68c0fa96`. A fresh JAR connection check passed UUID initialization and returned the existing JAR-network connection failure at the configured loopback address. Therefore, the originally reported generic UUID error does not establish missing host support on that server. The original failing browser session was not captured; its precise transport/startup trigger remains unverified. Code review did confirm that a rejected initialization promise previously poisoned all retries in the same client, and the regression tests above now cover that defect. No host restriction, permission check or UUID API was bypassed.

The follow-up build also passed a signed-in local connection check against the existing JAR 0.4.0 server after replacing both bundles and restarting through the native Extensions UI. No browser console errors appeared. Timeout recovery itself is exercised deterministically by the regression test; the live check does not claim to reproduce the original browser's failure.
