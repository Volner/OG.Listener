# HTTP API

The API returns public music metadata and external artwork and audio URLs. Personal history ZIP/JSON files are parsed in the browser and are not uploaded to the server. On GitHub Pages, requests target a separate Vercel origin configured through the public build variable `VITE_API_BASE_URL`; regular local mode uses the same origin.

Environment and CORS configuration are covered in [deployment](deployment.md). Set `VITE_API_BASE_URL` to an HTTPS origin only, without `/api` or other paths. For a separate frontend, its exact origin must be listed in `CORS_ORIGINS`. The API does not use authentication cookies. Allowed preflight requests receive 204; `Retry-After` is exposed to the browser through CORS. CORS restricts browser requests and is not authentication for this public API.

## Routes

| Method and path | Purpose |
| --- | --- |
| `POST /api/catalog/resolve` | Resolve metadata for a batch of 1-100 tracks |
| `GET /api/tracks/:id` | Resolve one track and search for available audio |
| `GET /api/tracks?query=…` | Search an external catalog for candidates; returns `{ results, exactMatchRequired: true }` |
| `GET`, `HEAD /api/artwork/:id` | 302 redirect to a known external artwork URL from the cache |
| `GET`, `HEAD /api/audio/:id` | 302 redirect to a known full recording or preview URL from the cache |
| `GET /api/audio/providers` | Audio sources and their configuration status |
| `GET /api/catalog/providers` | Optional metadata provider status without exposing keys |
| `GET /api/audience/providers` | Audience history sources and their limitations |
| `POST /api/audience/resolve` | Verified audience observations for 1-100 artists |
| `POST /api/audience/import` | A compatibility route for the same task, accepting 1-20 artists |
| `GET /api/status` | Instance status: `{ ok, storage: "memory", mediaFiles: 0 }` |
| `GET`, `HEAD /healthz` | Server handler availability; GET returns `{ "ok": true }` |

POST requests require `Content-Type: application/json`. The routes `/api/upload`, `/api/catalog`, `/api/catalog/jobs`, `/api/catalog/pause`, and `/api/catalog/resume` have been removed and return 410. The server does not accept archives, host personal libraries, or create archive import jobs.

## Catalog and playback

Example request; replace the title and artist with your own values:

```json
{
  "tracks": [
    { "id": "local:example", "name": "Track title", "artist": "Artist name" }
  ],
  "details": true,
  "apple": false
}
```

A track accepts `id`, `name` (`title` is also accepted), `artist`, and an optional `uri`. The `id` is a 22-character Spotify ID or an opaque identifier prefixed with `local:`. Send names alongside IDs: they are needed for exact matching in other catalogs. Do not send your full personal event history to this route.

In a batch, `details` defaults to `true`, while Apple lookup is enabled only with `apple: true`. Set `details: false` to skip additional genre enrichment. Batches do not search for full recordings: this is a separate playback action.

The response shape is `{ entries, errors, storage: "memory", mediaFiles: 0 }`. `entries` is an object keyed by track IDs; `errors` contains individual failures. HTTP success does not mean every track was found.

An entry may include `artwork`, `artistArtwork`, `genres`, `artistGenres`, `tags`, `artistTags`, `previewUrl`, `audioUrl`, `audioKind`, provider page URLs, and data provenance fields. These fields are optional. `audioKind: "full"` indicates a verified full recording; when only a preview is available, the value is `"preview"`. Missing data is not replaced with invented values.

Single-track requests support the query parameters `title`, `artist`, `apple`, `details`, and `full`. On this GET route, the last three are enabled by default and disabled with the string `false`. A fast playback request is:

```text
GET /api/tracks/:id?title=…&artist=…&full=true&details=false
```

Encode the `:id` segment and query values with `encodeURIComponent`. This is especially important for opaque `local:` IDs containing slashes, spaces, Unicode, or `%`. IDs are not filesystem paths.

Media routes only redirect to an already resolved URL that has not expired. Resolve the track first; a missing cache entry returns 404. The API does not proxy audio or image bytes or save them to files. See [audio sources](audio-sources.md) and [genres](genre-filters.md).

## Audience history

```json
{
  "provider": "kworb",
  "artists": [
    { "name": "Artist name", "firstPlayed": "2022-11-10T00:00:00.000Z" }
  ]
}
```

The default `provider` is `kworb`; optional `chartmetric` requires the server-side `CHARTMETRIC_REFRESH_TOKEN`. Each artist needs a name and a valid first-listen date that is not in the future. Optional `artistId` or `spotifyArtistId` values must be 22-character Spotify artist IDs.

Responses contain `provider`, `snapshots`, `coverage`, and `errors`; Kworb also returns `summary`. A response can contain available observations, a missing suitable baseline, and deferred work at the same time. Listing a provider does not guarantee coverage for every artist or year.

For Kworb, the `archiveChecked` field in each entry of the `coverage` array contains up to six real archive capture IDs such as `0:20240101000000`. To continue, pass that list in `artists[].archiveChecked` with the same artist identity and first-listen date. The server validates IDs against CDX and skips completed requests. The list does not accept arbitrary URLs or listener counts and cannot establish a baseline on its own.

The browser stores verified observations and merges them with new responses for the same provider and artist. This allows loading to continue after a Vercel cold start without storing personal libraries on the server. The growth formula, coverage status, and limitations are described in [audience history](audience-sources.md).

## Errors, caching, and limits

JSON bodies are limited to 1 MiB for catalog requests and 256 KiB for audience requests, including bodies already parsed by the platform. Invalid JSON returns 400, an unsupported Content-Type returns 415, and an oversized body returns 413. General errors include `error`; audience errors also include `code`, and throttling errors may include `retryAfterSeconds`.

Overload may return 429 with a `Retry-After` header; clients should wait before retrying. The `API_*` settings limit queueing and request rates within one API instance only. They are not a shared Vercel or provider quota. Individual providers may also throttle requests or become temporarily unavailable.

Caches use bounded instance memory, expire entries, and deduplicate identical in-flight work. They contain public metadata, not a shared personal listening history. Cold starts clear the caches; API HTTP responses use `Cache-Control: no-store`. Archives, configuration files, and source files are not served through the API.
