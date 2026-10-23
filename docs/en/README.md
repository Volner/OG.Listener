[Русский](../README.md) · [About the project](../../README.en.md)

# OG.Listener technical documentation

This documentation covers the application's architecture, data sources, local development, and deployment. For a visitor-facing overview, see the [project README](../../README.en.md).

## How data moves through the application

1. The user selects an official Spotify archive in ZIP or JSON format. Both the extended `Streaming_History_Audio` and standard `StreamingHistory` formats are supported.
2. A browser Worker parses the archive into a library of tracks, artists, and listening events. Personal history is stored in IndexedDB in the current browser.
3. The frontend calculates statistics from that history and requests missing public metadata from the API. Artwork and genres load as the user browses, audience history uses a background queue, and full recordings are searched for when the user presses “Listen”.
4. The API matches names and identifiers against external catalogs and returns metadata and URLs. The browser retrieves images and audio from those external URLs.

The frontend is published to GitHub Pages; the API runs as a Node.js Function on Vercel. During local development, Vite attaches the local API. Commands, environment variables, CORS settings, and workflows are covered in the [deployment guide](deployment.md).

## Personal history and shared metadata

The archive and complete listening history are not sent to the API. Metadata requests contain music names and identifiers. Audience history requests also include the artist, the first-listen date, and a bounded list of archive capture IDs already checked. Personal listening events and browser-supplied listener counts are not used as external provider data.

Each visitor sees the library stored for their browser profile and the current site origin. It does not sync across devices or domains. There is no automatic expiration, but clearing browser data removes the library. Importing another archive replaces it.

The server cache holds public metadata in one API instance's memory. It can serve identical requests from different visitors and disappears on a cold start; it does not contain personal libraries. The application does not create local artwork or music files. Normal browser and CDN HTTP caches operate independently.

## Data sources

| Source | Data used | Conditions and limitations |
| --- | --- | --- |
| Spotify oEmbed | Artwork URLs | Requires an available Spotify entry; it does not request the user's history |
| Deezer | Artwork, album genres, previews | Uses title and artist matching; coverage is incomplete |
| Apple Music / iTunes | Additional artwork, previews, primary genre | Additional lookup while preparing playback |
| MusicBrainz | Artist genres | Fallback when an artist match is unambiguous |
| Audius | Complete, openly streamable recordings | Track matching and stream availability are checked; it does not cover the entire Spotify catalog |
| Jamendo | Additional complete recordings | Optional server-side `JAMENDO_CLIENT_ID` |
| Last.fm | Track and artist tags, recognized musical styles | Optional server-side `LASTFM_API_KEY`; tags do not constitute audio analysis |
| Kworb + Internet Archive | Real observations of Spotify monthly listeners | Only matched artists and available captures; dates are sparse |
| Chartmetric | Additional historical monthly listeners | Optional paid access and server-side `CHARTMETRIC_REFRESH_TOKEN`; historical depth depends on access and artist |

The main sources do not require keys. The API owner configures optional integrations through the Vercel environment or a local `.env.local` file; visitors do not need their own keys. Variable names are listed in [`.env.example`](../../.env.example). Keep secrets on the server: all `VITE_*` variables are included in the public frontend build.

An available source does not guarantee data for every track or artist. When no full recording is found, the player can use a labeled preview. Missing audience observations are not estimated or replaced with another metric.

## Guides and reference

| Document | What it covers |
| --- | --- |
| [Deployment and capacity](deployment.md) | Local development, GitHub Pages, Vercel, environment variables, CORS, verification, and traffic limits |
| [HTTP API](api.md) | Routes, request and response formats, limits, and background loading continuation |
| [Genres and filters](genre-filters.md) | Genre sources, incomplete coverage, and filter order |
| [Audio sources](audio-sources.md) | Recording lookup and matching, full streams, previews, and player behavior |
| [Audience history](audience-sources.md) | Kworb, archived observations, background requests, charts, and growth calculation |
| [Last.fm](lastfm.md) | Key configuration, tag use, and integration limits |
| [Metadata preload estimates](preload-estimate.md) | What affects library enrichment time and why sending more requests does not always make it faster |
