# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the authoritative contributor guide (Chinese): conventions, security invariants, release checklist, and per-area maintenance rules. Read it before changing behavior. This file covers the pieces that are only visible by reading several files at once.

## Commands

```bash
npm install                 # dependencies are locked; npm ci in CI
npm run dev                 # Vite dev server, 127.0.0.1:5173 (proxies /api → 8787)
npm run dev:server          # API with --watch, 127.0.0.1:8787
npm run build               # tsc -b --force && vite build (always re-runs typecheck)
npm test                    # full Vitest suite
npm run test:browser        # Playwright flows (needs Chromium; set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH for system Chrome)
npm run verify:teaching     # real server + mocked model, teaching-analysis API check
npm run school:invite -- create|list|revoke   # school invite codes
node cli/scripts/build-packages.mjs           # build the two npm packages into .npm-packages/
```

- **Single test**: `node node_modules/vitest/vitest.mjs run server/accounts.test.ts` (add `-t "name"` to filter). Vitest lives beside the module it covers (`server/<module>.test.ts`); browser flows are `tests/browser/*.pw.mjs`.
- **Local run needs config**: copy `.env.example` to `.env` with `APP_SECRET` (≥32 chars) and `DATA_DIR`, then `node --env-file=.env server/index.mjs`. Without `DATA_DIR` the server uses `<repo>/data` (gitignored).
- On this Windows machine `node_modules/.bin` shims are sometimes broken; run entry files directly with `node` (`node node_modules/vite/bin/vite.js …`) instead of reinstalling dependencies. The full `npm test` also has known platform-specific failures locally (fsync EPERM, `/proc` cgroup, admission); CI on Ubuntu covers those.

## Architecture

Two deployables share one runtime:

- **Web app**: `server/index.mjs` is the composition root — reads env, opens `node:sqlite`, runs `migrateDatabase(db, {schemaSql})` before serving, mounts route modules through `register*(app, ctx)`, and serves the built `dist/` as static files. `src/` is the React SPA; `src/main.tsx` holds the shell and the same-page workspaces (chapters mount on first visit and stay mounted).
- **CLI package** (`cli/`, published as `@turtlelnc/msh` and `@turtlelnc/mes-homework`): `cli/src/cli.mjs` dispatches commands and reuses `tools/installer/runtime/` (`locations`, `prepareConfig`, `launch.mjs`) so it manages the same data directory as the native installers. The admin console (`cli/src/admin.mjs`) and MCP server (`cli/src/mcp.mjs`) operate on the same SQLite file.

Data model and migration:

- `server/schema.sql` is the source of truth for new databases; `server/migrations.mjs` aligns existing databases at startup inside one transaction (table rebuilds, `alignReleaseSchema` re-runs the schema, `schemaDifferences` verifies columns/constraints/indexes and aborts on mismatch).
- Everything is scoped by `school_id`/account; all SQL is parameterized.

Model calls (`server/`):

- `model-access.mjs` resolves which account owns the credential per school mode (school-wide / teacher+class / teacher+parent).
- `providers.mjs` holds the API-key vendor presets, `MODEL_OUTPUT_LIMITS`, and `modelOutputLimit()`; `provider-protocol.mjs` has `outputTokenLimit()` and the request/response adapters. Requests clamp `max_tokens` to the preset limit, and `cost-budget.mjs` reserves against the same clamped value.
- Grading runs through `recognition-queue.mjs` (bounded concurrency from `runtime-profile.mjs`) and `model-budget.mjs` (per-school/per-user in-flight limits); review modes live in `review.mjs`, `grading.mjs`, `direct-grading.mjs`, `mistakes-guide.mjs`.

Invariants that span files:

- Creating a school consumes a one-time code from `school_invites`; consumption and school creation happen in one transaction with **no `await` inside** (`registerSchool` derives the password hash first), and a fresh deployment with no schools issues a bootstrap code at startup.
- `/api/capabilities` is the only source for stage list and registration policy; the frontend must not invent defaults.
- Browser tests run against `dist/`, not the Vite dev server — rebuild before running them after a UI change.
- A version bump touches `package.json`, `package-lock.json`, `server/version.mjs`, `src/version.ts`, `server/version.test.ts`, README/README.EN badges and lines, deployer defaults, and `docs/releases/<version>.md` (full checklist in `AGENTS.md`).

Native installers live in `tools/installer/` (`assemble.mjs`, `build.mjs`, smoke scripts); `.github/workflows/native-installers.yml` builds all platforms and only produces draft pre-releases. `tools/deployer/` is historical and is not re-enabled.
