# Audio sources

All available recordings play through one built-in HTML audio player. It lives at application level and continues playing after a card closes, a search, or a change of filters or library mode. Closing the tab or reloading the page stops playback.

## Connected sources

| Source | Format | API configuration |
| --- | --- | --- |
| Audius | A complete, openly streamable recording when an exact match exists | The current integration makes public requests with `app_name=OG.Listener` |
| Jamendo | A complete recording from its available catalog | Optional server-side `JAMENDO_CLIENT_ID` |
| Deezer | A preview, usually around 30 seconds | No separate key is used by the current integration |
| Apple Music / iTunes | A preview | No separate key is used by the current integration |

Complete recordings are searched for when the user presses “Listen”, rather than for every artwork card that appears. Audius and a configured Jamendo are checked in parallel; Audius has priority when both succeed. If a complete recording cannot be found or its stream fails, the player uses an independently matched preview. The player displays the actual format and source, with a link to the recording's page at the provider.

A track's presence in Spotify listening history does not guarantee its availability in another catalog. These integrations do not provide Spotify's complete catalog, and some tracks may have no playable audio at all.

## Recording matching

The complete title and artist name are compared after normalizing case, diacritics, punctuation, and whitespace. A different version with a different title, such as a live recording or remix, is not substituted for the original. Matching the title alone is insufficient.

For Audius, the application also checks stream availability: gated, deleted, unlisted, and conditionally accessible recordings are excluded. Verified artist accounts are preferred among matches, and ambiguous matches across several accounts are rejected. This reduces mismatches but does not replace identification by Spotify ID or ISRC. Jamendo also requires an exact match and a single artist account among the matching results.

A complete recording is identified by a verified response from its source. A URL extension or file duration alone does not turn a preview into a complete recording.

## Player behavior and storage

Pressing play for the same song again toggles pause; choosing another song changes the recording. The seek bar uses the media's actual duration and supports seeking. Volume fades in and out at the beginning and end; programmatic volume control depends on browser support, particularly on mobile devices. Media Session integration is available where supported.

The API returns external audio URLs, and the browser requests the provider's stream directly. `/api/audio/:id` redirects to an external address without proxying the media file. Neither the server nor the application saves songs or artwork to the filesystem, IndexedDB, or Cache Storage; normal browser and CDN network caching may operate independently.

Searches and their results use a bounded cache in the API instance's memory, including short-lived caching of missing recordings. A Vercel cold start clears that cache. Expiring URLs may require another lookup. The application uses Jamendo's `audio` stream and does not offer its `audiodownload` feature.

`GET /api/audio/providers` reports sources and configuration status without exposing keys. `GET /api/tracks/:id?title=...&artist=...&full=true&details=false` searches for audio without waiting for additional genre enrichment. Secrets belong only on the API: see [deployment](deployment.md) and the [API reference](api.md).

## Provider documentation

- [Audius API](https://docs.audius.co/api/).
- [Jamendo: tracks](https://developer.jamendo.com/v3.0/tracks).
- [Apple iTunes Search API](https://performance-partners.apple.com/search-api).

Spotify Web Playback SDK and SoundCloud are not connected to the current player. Last.fm provides [metadata and genres](lastfm.md), rather than complete audio files.
