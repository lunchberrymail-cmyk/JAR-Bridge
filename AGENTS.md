# GitHub workflow

After completing and validating changes, commit and push them to the `staging` branch on GitHub.

Keep `main` unchanged unless the user explicitly requests a merge or release to `main`.

Include the rebuilt `dist` bundles when extension source changes.

# Frontend UUIDs

Use the existing `src/uuid.ts` helper for every frontend UUID. Never call `crypto.randomUUID()` in frontend code: it is unavailable on plain HTTP LAN connections. Keep the helper based on `crypto.getRandomValues()` and preserve the regression test that rejects direct UUID API calls.
