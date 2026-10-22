# Preloading metadata

[Русский](../preload-estimate.md)

Reading an archive and looking up external data are separate stages. Currently, a browser Worker parses ZIP or JSON files, and the library opens without waiting for external catalogs to process every track. Import does not preload all artwork, genres, and audio.

## Current behavior

- Artwork and metadata are requested for visible cards and selected tracks. The queue fetches basic information first, followed by additional genres and tags.
- The artwork queue permits two concurrent batches of six tracks. Detailed metadata is processed in smaller batches of three after basic requests. The server also paces requests to each source.
- Full-recording lookup starts when the user plays a track. This avoids checking audio availability for the entire library in advance.
- Artist audience history is checked by a separate automatic background queue. It does not block opening the library.

The genre filter uses metadata already obtained. If a genre has not been found, completing the archive import does not assign one to the track. See [genres and filters](genre-filters.md), [audio sources](audio-sources.md), and [audience history](audience-sources.md) for the order of processing and its limits.

## Illustrative time estimate

Time depends on the number of unique tracks, albums, and artists, cache hits, requests per track, network latency, source responses, and retries. The number of listening events alone does not determine the number of external requests.

As an example, suppose 10,000 unique tracks each require exactly one new request to one source, with requests starting at a fixed interval. Multiplying the count by the interval gives this rough queue-time estimate:

| Interval between requests | Calculation for 10,000 requests |
| --- | --- |
| 180 ms | about 30 minutes |
| 220 ms | about 37 minutes |
| 1,050 ms | about 2 hours 55 minutes |
| 3,100 ms | about 8 hours 37 minutes |

These are illustrative calculations, not archive benchmarks or coverage promises. These intervals occur in application settings, but they do not imply that a provider permits the corresponding traffic. A track may require several requests and fallback searches; a shared album or artist may instead allow a result to be reused. Latency, timeouts, and `429` responses increase the time. Independent queues may run in parallel where permitted, so times for different sources do not always add up.

Additional browser Workers can speed up suitable local processing, but they cannot remove network limits. More server instances do not provide a shared quota either: the current API's cache and admission controls belong to individual Vercel instances. Reliable bulk processing would need a shared cache and coordinated request pacing that follows each provider's rules.

## What complete metadata preparation would require

It would require a resumable queue, deduplication across tracks, albums, and artists, source-availability checks, `Retry-After` handling, and storage of permitted metadata with its verification date. Visible cards and playback requests should retain priority so that a long queue does not delay normal use.

Stored results should contain permitted metadata, links, and provenance. The application does not create local artwork or music files: the browser obtains images and audio from external URLs. Audio URLs may expire, so finding a URL in advance does not guarantee that it will play years later. Ordinary browser and CDN HTTP caching follows their own settings.

Even a fully processed queue does not mean that every song has a known genre or full recording, or that every artist has historical audience data. Missing data must remain unknown. The current hosting setup and cache limits are covered by the [deployment guide](deployment.md).
