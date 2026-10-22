# Genres and filters

OG.Listener gets genres from music catalog metadata. It does not analyze the sound or use an AI audio classifier. Users do not need to tag each song manually.

## Genre sources

| Source | Data used | Conditions |
| --- | --- | --- |
| Deezer | Genres of the matched track's album | The complete title and artist match after normalization |
| Last.fm | Recognized musical styles from track tags; artist tags when the track has no recognized styles | The API has `LASTFM_API_KEY`; see the [Last.fm documentation](lastfm.md) |
| MusicBrainz | Artist genres from its dedicated `genres` namespace | Other sources have not supplied a genre, and exactly one artist has a matching name |
| Apple Music / iTunes | The matched song's `primaryGenreName` | Additional lookup while preparing playback |

An album or artist genre can be broader than the style of an individual song. Last.fm tags also include countries, moods, and personal labels: only musical styles in the application's limited dictionary become genres. Other tags remain separate metadata.

## When data becomes available

As users browse the library, cards enter a queue: artwork is requested first, followed by additional details. The same card does not start a new request every time it appears; the queue respects temporary source rate limits.

The application does not scan every track during archive import. Genre filtering uses metadata already received. “Unknown genre” includes both tracks not processed yet and songs for which sources have no suitable genre. Selecting a genre does not automatically scan hidden tracks with an unknown genre. Return to “All genres” and continue browsing to expand coverage.

The filter panel shows how many tracks have a known genre out of the entire imported library. New metadata is held in the page's memory, so some details may be requested again after a reload. This does not affect the saved listening history.

## How filters interact

1. The date range and “Count as played” setting select listening events. Both boundary dates are included as full UTC days.
2. The genre filter selects tracks with matching metadata. Text search ignores case and punctuation.
3. In artist mode, the selected tracks are grouped by artist.
4. The play count range applies to the resulting tracks or artists within the selected period.

With a genre selected, an artist's play count therefore includes only matching tracks. The chart inside a card shows the track's or artist's complete history using the current minimum listening duration, independently of the library's date and genre filters. The first-listened date refers to the complete imported archive.

There is no general synonym system or subgenre hierarchy: `Trap`, `Hip-Hop/Rap`, and `Rap/Hip Hop` can remain separate options. Last.fm tags have a small normalization dictionary, such as `rnb` → `R&B`.

Artwork is displayed using external HTTPS URLs. The application does not create local image or music files; normal browser and CDN HTTP caching is controlled by their settings. See [API](api.md) and [deployment](deployment.md) for API configuration and keys.
