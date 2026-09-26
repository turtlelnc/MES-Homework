# Repository Guidelines

## Project Structure & Module Organization

The React 19 and TypeScript frontend lives in `src/`. `src/main.tsx` contains the application workflows, `src/api.ts` wraps API requests, `src/styles.css` contains shared styling, and `src/components/` holds reusable UI components. The Express and SQLite backend lives in `server/`: `index.mjs` defines routes and persistence, `schema.sql` defines new databases, and `document.mjs`/`word.mjs` handle PDF and Word extraction. Provider presets are maintained in `server/providers.mjs`.

Static assets belong in `public/`. Production output is generated in `dist/`. Runtime databases and uploads are stored under `data/`; never commit that directory. Cloudflare proxy configuration is in `cloudflare-worker.mjs` and `wrangler.jsonc`.

## Build, Test, and Development Commands

- `npm install` installs locked dependencies.
- `npm run dev` starts Vite at `http://127.0.0.1:5173`.
- `npm run dev:server` starts the watched API server on port 8787.
- `npm run build` runs strict TypeScript checks and creates `dist/`.
- `npm test` runs the Vitest suite once.
- `npm start` serves the production API and built frontend.

Set `APP_SECRET` to a random value of at least 32 characters before running production. See `.env.example` for supported variables.

## Coding Style & Naming Conventions

Use two-space indentation and Prettier formatting: `npx prettier --write src server`. Prefer TypeScript for frontend code and ESM (`.mjs`) for server modules. Use `PascalCase` for React components and types, `camelCase` for functions and variables, and descriptive route names such as `/api/mistakes/:id/practice/submit`. Keep database access parameterized and scope every query by school or user identity.

## Testing Guidelines

Tests use Vitest and should be named `*.test.ts` beside the module they cover, as in `server/providers.test.ts`. Add tests for authorization boundaries, database migrations, file parsing, and provider behavior. Run `npm test` and `npm run build` before submitting changes. Never call paid model APIs in automated tests; mock provider responses.

## Commit & Pull Request Guidelines

No Git history is currently available to establish an existing convention. Use concise Conventional Commit subjects, for example `fix: persist provider API keys`. Pull requests should explain the user-visible behavior, migration impact, security considerations, and validation performed. Include screenshots for UI changes and note any new environment variables or deployment steps.

## Security & Data Handling

Do not commit API keys, `.env` files, SQLite databases, uploaded student work, or generated temporary files. Preserve teacher review for consequential grading results, validate uploaded MIME types and sizes, and keep model credentials encrypted on the server.
