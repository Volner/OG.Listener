# Last.fm integration

Last.fm adds track genres and tags. This integration is optional: without a key, users can still import an archive, view statistics, and use the other artwork and audio sources. Website visitors do not need a Last.fm account, authentication, or scrobbling enabled.

## Configuration

Obtain an application key from [Last.fm API](https://www.last.fm/api/account/create) and set `LASTFM_API_KEY` in the server API's environment. On Vercel, use the project's Environment Variables and redeploy after changing them. For local development, use an ignored `.env.local`, as described in the [deployment guide](deployment.md).

The key must not have a `VITE_` prefix or appear in GitHub Pages, browser code, or commits. The browser calls OG.Listener's API, and the server sends the Last.fm request. `GET /api/catalog/providers` exposes only the source's `configured` state and capabilities.

## Methods used

| Method | Purpose |
| --- | --- |
| [`track.getInfo`](https://www.last.fm/api/show/track.getInfo) | Match a song by title and artist, obtain `toptags` and the track page URL |
| [`artist.getInfo`](https://www.last.fm/api/show/artist.getInfo) | Obtain artist tags when the matched track's tags contain no recognized musical styles |

Both methods use `autocorrect=0`. The returned artist name and title are checked against the request after normalizing case, diacritics, punctuation, and whitespace. Nonmatching results are rejected. The current code does not call `track.getTopTags` or `artist.getTopTags`.

Community tags are kept as `tags`, and fallback artist tags as `artistTags`. Only values in a limited dictionary of recognized musical styles become genres. For example, `rnb` becomes `R&B`; countries and personal labels are not automatically treated as genres.

Metadata records the genre's source and scope: track or artist. Last.fm genres can supplement other catalogs' data. When a track has no suitable tags, its artist's fallback genre describes the artist's music in general and can be inaccurate for an individual song. See [genre filtering](genre-filters.md).

The card includes a “Last.fm tags and metadata” link when the provider returns an accepted track page URL.

## Queue, cache, and errors

Last.fm is queried while enriching visible cards with additional details. The initial artwork request and audio requests using `details=false` do not wait for these tags. An optional source error does not hide artwork or a recording already found elsewhere.

Identical pending requests are shared. Results use a bounded cache in the API instance's memory: by default, up to 3000 entries and up to 6 hours; missing matches are cached for up to 5 minutes. A shorter `Cache-Control: max-age` reduces the lifetime, while `no-store` and `no-cache` prevent storing the response in this cache. The combined server catalog entry is also limited by the expiry of the Last.fm data. This is not a permanent metadata database; a Vercel cold start begins with an empty cache.

Requests to the source are paced; the application's default interval is 350 ms within one API instance. HTTP 429 and Last.fm error 29 trigger a temporary pause using `Retry-After` where provided. Invalid or suspended key errors also temporarily block repeated calls. These application settings are not a guaranteed Last.fm quota and are not shared across Vercel instances.

## Limitations

This integration does not analyze the song's sound, provide complete audio files, or fetch images from Last.fm. The application does not save media files to the user's computer or the server.

Last.fm listener and play counters describe its own database. They are not Spotify monthly listeners and are not substituted into the Spotify audience growth chart. This integration does not reconstruct personal listening history either: that comes from the imported archive. Audience chart sources are documented [separately](audience-sources.md).

Before using your key publicly, review the [Last.fm API terms](https://www.last.fm/api/tos). Actual tag coverage depends on the catalog and community activity; missing genres remain unknown.
