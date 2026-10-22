# Deploying OG.Listener

The frontend runs on GitHub Pages and the API runs on Vercel. Spotify archives are parsed in the browser; the API looks up public metadata and external media URLs. Visitors do not need to install an application or obtain provider keys.

## Repository layout

Place `package.json`, `vercel.json`, `.github/`, `api/`, `server/`, and `src/` at the repository root. If your working project is inside a `site` directory, publish the contents of that directory as the repository root. The GitHub Pages workflow expects this layout.

Keep `package-lock.json`, tests, build scripts, and both workflows: they support reproducible installs and verification. `node_modules/`, `dist/`, `.vercel-static/`, local keys, and personal archives are excluded by [`.gitignore`](../../.gitignore).

## 1. Vercel API

Import the GitHub repository into Vercel and configure the project:

| Setting | Value |
| --- | --- |
| Framework Preset | Other |
| Node.js | 24.x |
| Root Directory | The directory containing `package.json` and `vercel.json`; the repository root with the recommended layout |
| Build Command, Output Directory, Install Command | Keep the configuration provided by `vercel.json` |

[`vercel.json`](../../vercel.json) runs `node scripts/prepare-vercel.mjs` and exposes the API through `api/index.js`. The script creates a single `index.html` in `.vercel-static` with a minimal API page and a link to `/healthz`: Vercel does not accept an empty Output Directory. The frontend is built separately for Pages; source files, archives, and personal data are not copied into this directory. Do not replace these settings with `npm run build` and `dist`. The server uses built-in Node.js modules. The regular dependency installation step is skipped; the Node.js Function builder may install dependencies from `package.json` separately when packaging the function.

Set the following Environment Variables for **Production**:

| Variable | Purpose |
| --- | --- |
| `CORS_ORIGINS` | Allowed frontend origins, such as `https://username.github.io` |
| `LASTFM_API_KEY` | Optional Last.fm tags and genres |
| `JAMENDO_CLIENT_ID` | An optional additional source of full recordings |
| `CHARTMETRIC_REFRESH_TOKEN` | An optional paid source of historical monthly listeners |

All variable names and request limit settings are listed in [`.env.example`](../../.env.example). Keep keys on the API only; variables prefixed with `VITE_` are included in the public frontend code. Redeploy after changing the server environment.

`CORS_ORIGINS` accepts comma-separated exact origins: scheme, hostname, and port when applicable. For `https://username.github.io/OG.Listener/`, use **`https://username.github.io`**. For a custom domain, use its actual origin. Paths, a trailing `/`, `*` wildcards, URL parameters, and credentials are rejected. Public origins must use HTTPS; HTTP is allowed only for local loopback. An empty value permits same-origin requests only and does not support a separate Pages frontend.

The production API must be accessible to visitors **without signing in to Vercel**. If deployment protection is enabled, configure it so that the public production API is accessible; preview deployments can remain protected. Never put protection bypass tokens in the frontend. A successful `OPTIONS` response alone does not confirm that the actual request is accessible.

After deployment, save the stable production origin, such as `https://your-api.vercel.app`. Open `/healthz` in a private window: the expected response is `{"ok":true}`. This route checks the API handler; the static page at `/` does not confirm that it is working. A health check does not check every external provider.

Vercel does not need `HOST`, `PORT`, `API_ONLY`, or `TRUST_PROXY`: the platform invokes the function directly. The adapter uses a validated IP from the platform header only when running in the Vercel environment.

## 2. GitHub Pages frontend

1. In GitHub, open **Settings → Secrets and variables → Actions → Variables**. Create a repository variable named `VITE_API_BASE_URL` containing the API's production origin, such as `https://your-api.vercel.app`. Do not include `/api`, other paths, parameters, or keys.
2. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.
3. Push to `main` or manually run the **Deploy OG.Listener to GitHub Pages** workflow from the Actions tab.

[`static.yml`](../../.github/workflows/static.yml) installs dependencies with `npm ci`, runs tests and `npm run build:pages`, then publishes only `dist/`. It obtains the project path from `configure-pages`; a standard project Pages deployment needs no manual path changes. A missing or invalid `VITE_API_BASE_URL` causes the Pages build to fail before publishing.

Pages uses hash navigation: `https://username.github.io/OG.Listener/#/upload`. Reloading and browser Back/Forward work without server-side SPA redirects. Local development keeps the `/upload` route.

The API origin is embedded at build time: rerun the Pages workflow after changing `VITE_API_BASE_URL`. If the frontend domain changes, also update `CORS_ORIGINS` on Vercel and redeploy the API.

## Checking the published site

1. Open the upload page on Pages and import your own ZIP or JSON.
2. Confirm that statistics appear and the library remains after reloading.
3. Check artwork and playback of available audio. In Network, `/api/…` requests should target Vercel; responses should not be replaced by a sign-in page or blocked by CORS.
4. Open the site in a separate browser profile: another profile's library should not appear there.

If local statistics work but artwork and other external data are missing, check the API origin, production protection, `CORS_ORIGINS`, and provider responses. Some genres, audio, or historical listener data may be unavailable even when the API is working: catalog coverage is limited.

## Limits and traffic

The Vercel configuration sets `maxDuration: 300` seconds, while provider requests have their own shorter budgets. Check allowed resources, execution duration, and costs against your project settings and platform terms; this setting does not reserve resources or guarantee response times.

The API accepts JSON bodies up to 1 MiB for catalog requests and 256 KiB for audience history. Limits apply to streams and bodies already parsed by the platform. Archives and media bytes are not sent through these routes.

Metadata caches, request deduplication, and admission limits live in **one API instance's** memory. Defaults allow 12 active requests and 24 queued requests, with a queue wait of up to 5 seconds. The IP limiter replenishes at 120 requests per minute and allows a burst of up to 30; it retains up to 10,000 IP entries with a bounded lifetime. Overload returns 429 with `Retry-After`. The `API_*` settings are listed in `.env.example`.

A new Vercel instance starts with empty caches and its own limiters. These settings are not a shared quota across instances, a guarantee against all costs, or evidence of support for 10,000 concurrent visitors. Growing traffic requires measurements on the deployed service and, if necessary, a shared cache and distributed request limiter that respect provider rules.

Kworb history loading can continue across instances: the browser stores `archiveChecked` from each entry in the `coverage` array and sends only a bounded list of completed archive capture IDs. The server validates them against the real CDX index and continues the remaining work. Verified observations are merged in the browser; listener counts supplied by a client are not accepted as provider data. See [audience history](audience-sources.md).

## Local development

Node.js 22+ is required; Node.js 24 matches the Vercel configuration. Run these commands from the project root:

```sh
npm ci
npm run dev
```

The development URL is `http://127.0.0.1:5173/upload`. In the normal mode, Vite attaches the local API. Leave external `VITE_API_BASE_URL` unset when you want to use it.

To check a regular production build:

```sh
npm test
npm run build
npm start
```

The URL is `http://127.0.0.1:3000/upload`. The optional `.env.local` file supplies server keys; existing environment variables take precedence. `API_ONLY=true` starts only the API without `dist/`. `HOST` and `PORT` apply only to this local server. `TRUST_PROXY` defaults to `none`; only exact trusted proxy IPs or `loopback` are accepted, and `X-Forwarded-For` is ignored.

To preview a Pages build locally, create an ignored `.env.pages.local` file:

```dotenv
VITE_API_BASE_URL=https://your-api.vercel.app
VITE_BASE_PATH=/OG.Listener/
```

```sh
npm run build:pages
npm run preview -- --mode pages
```

Open `http://127.0.0.1:4173/OG.Listener/#/upload`. To call the external API, temporarily add `http://127.0.0.1:4173` to its `CORS_ORIGINS` and redeploy the API. Preview in Pages mode does not start a built-in API.

## Data and published files

Personal history is stored in IndexedDB for the current origin and browser profile. There is no automatic expiration, but clearing browser data removes the library. It does not sync across devices or domains; importing another archive replaces it. The server does not store visitors' personal listening histories.

Artwork and audio use external URLs. The application does not create local media files; normal browser and CDN HTTP caches may operate independently.

GitHub Pages receives only `dist/`. The `check-public.mjs` script validates the allowed contents of `public/`, and [`.vercelignore`](../../.vercelignore) limits the server files uploaded to Vercel. Keep personal archives and keys out of public directories. If adding external monitoring, remember that metadata request bodies and query parameters may contain music names and first-listen dates.
