# MES Homework Official Website

This directory contains the bilingual static product website served by the Cloudflare Worker. It is intentionally separate from the React application build output in `dist/`, so the marketing site cannot overwrite the application frontend.

## Preview locally

From the repository root, run either:

```bash
npx serve website
```

or:

```bash
python -m http.server 8000 --directory website
```

Open `http://127.0.0.1:8000`.

## Cloudflare deployment

1. Run the MES Homework API/application on the origin host. It requires Node.js 24+, a persistent data directory and a stable `APP_SECRET` of at least 32 characters.
2. Expose the local application port (8787 by default) through a Cloudflare Tunnel. A Quick Tunnel is suitable for a temporary test; use a named, persistent tunnel and a fixed hostname for production.

   ```bash
   cloudflared tunnel --url http://127.0.0.1:8787
   ```

3. Set `ORIGIN_URL` in `wrangler.jsonc` to the HTTPS hostname that reaches the origin application. Do not append an API path.
4. The website's `/app` link redirects visitors to the application root on `ORIGIN_URL`. Set the API server's `APP_ORIGIN` to that exact HTTPS origin, without a path or trailing slash.
5. Deploy the Worker:

   ```bash
   npx wrangler deploy
   ```

The Worker serves this directory as static assets, redirects `/app` to the application root on `ORIGIN_URL`, and proxies `/api`, `/api/*`, `/uploads` and `/uploads/*` to the origin. It does not host SQLite, uploaded files or model execution. D1 and R2 are not required by this architecture.

## Files

- `index.html`: landing page, product information and user guide.
- `site.css`: responsive visual system.
- `site.js`: Chinese/English switching, clipboard actions, mobile navigation and docs navigation.
- `favicon.svg`: site mark.
- `404.html`: missing-page response.
