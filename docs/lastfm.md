# Last.fm metadata

Last.fm is an optional source of **community tags and recognized music styles**.
It is not an audio provider or a source of historical Spotify monthly listeners.

## Configuration

Obtain this application's own API key at <https://www.last.fm/api/account/create>
and set `LASTFM_API_KEY` in `.env.local`, then restart the local server. Do not use
the `VITE_` prefix: the key stays on the server. Visitors need no Last.fm account,
login, installation, or separate API key. No API key is included in the project.

`GET /api/catalog/providers` reports whether the application is configured. It
does not expose the key. `configured: true` means a key was supplied, rather than
a claim that Last.fm has accepted it or is currently available.

## Lookup and genre rules

- `track.getInfo` is called only during metadata enrichment (`details: true`),
  never for the fast cover request or the player request with `details: false`.
- Autocorrection is disabled. The returned complete title and artist must match
  after case/punctuation normalization. Live, remix, cover and other title
  suffixes are preserved by that comparison.
- `tags` contains the track's community annotations. Only exact entries in the
  small recognized-style alias map become `genres`; personal labels, years,
  countries, and moods remain tags. This mapping is deliberately conservative
  and incomplete. It does not analyze audio or claim that all tags are genres.
- When a verified track has no recognized genre tags, `artist.getInfo` supplies
  a shared artist fallback. These are explicitly marked `genreScope: 'artist'`
  and also retained in `artistTags`/`artistGenres`.
- Existing album genres are preserved. `genreSources` keeps provenance and
  `lastfmUrl` links to the matching Last.fm catalog page for attribution.
- Only metadata is requested. Last.fm artwork, audio, biographies, listener
  counts, and personal scrobble data are not fetched or imported.

Metadata and negative results use bounded RAM caches with in-flight request
deduplication. No media or Last.fm data is written to disk. Cache-Control
`max-age`, `no-cache`, and `no-store` are respected, with a six-hour maximum.
The default request spacing is 350 ms, an application setting rather than an
official throughput promise. HTTP 429/API error 29 pauses requests and honors
Retry-After; invalid/suspended keys pause for an hour. Other providers continue
working if Last.fm is unavailable.

## What the API does not solve

`artist.getInfo` statistics belong to Last.fm, rather than Spotify's rolling
monthly audience. `user.getWeeklyArtistChart` is one user's listening chart, not
a historical count of an artist's Spotify listeners. Neither is mixed into the
app's Spotify audience-growth coefficient. The old Radio API is deprecated and
cannot provide a free full-song catalog. Audio continues to use the app's
separate playback providers.

## Official references

- [track.getInfo](https://www.last.fm/api/show/track.getInfo)
- [track.getTopTags](https://www.last.fm/api/show/track.getTopTags)
- [artist.getInfo](https://www.last.fm/api/show/artist.getInfo)
- [user.getWeeklyArtistChart](https://www.last.fm/api/show/user.getWeeklyArtistChart)
- [Deprecated Radio API](https://www.last.fm/api/radio)
- [API terms](https://www.last.fm/api/tos): attribution/catalog links, caching,
  usage limits, and separate conditions for commercial use.
