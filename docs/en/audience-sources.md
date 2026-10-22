# Artist audience history

[Русский](../audience-sources.md)

OG.Listener automatically requests real observations of Spotify monthly listeners from Kworb and the Internet Archive. This is a separate dataset: a user's official listening archive does not contain artists' audience history.

## Free source: Kworb and the Internet Archive

The server reads two shared Kworb tables: the [main ranking](https://kworb.net/spotify/listeners.html) and the [additional ranking](https://kworb.net/spotify/listeners2.html). An artist is matched using a known Spotify artist ID or an unambiguous name match in the current tables. Ambiguous matches are not selected automatically.

For matched artists, the server obtains actual captures of those tables through Wayback CDX. It selects up to three captures per page from the available index: the closest one before the first listen, the first one after it, and the latest one after it. One capture can provide values for several artists; the server does not crawl an independent archive for every name.

Observation dates come from the source response: `Last-Modified` for a current table, or `Memento-Datetime` or the actual capture timestamp in the response URL for an archived table. A page without a trustworthy date does not become a chart point. Each observation includes its source, date, value, and page URL.

Coverage is incomplete. The tables do not include every artist, and the Internet Archive captured them irregularly. If an artist is absent from the shared current index, the application does not start a separate search through all of that artist's old pages. This does not prove that no historical data exists; automatic discovery in the current implementation is limited to the available shared tables. Data for any particular year, including 2019, is not guaranteed.

## Automatic queue and resumable checks

After reading the library, the browser creates a queue of all artists and submits batches of 20. Visible cards receive priority. Closing a card or changing filters does not stop the shared queue; it continues while the application remains open.

Each Kworb server batch has a 40-second budget, an individual request timeout of up to 8 seconds, and a limit of 12 new archived-table requests. These are implementation limits, rather than a quota granted by the source. Unprocessed dates return with a `deferred` status; temporary failures and rate limits trigger automatic retries with a delay. Successfully checked coverage is reused for one day. The API table cache belongs to one server instance and can disappear on a Vercel cold start.

The `archiveChecked` cursor carries progress between API instances. It contains at most six identifiers such as `0:20240101000000`: one of the two table numbers and a capture timestamp, with up to three per table. The browser stores the cursor with the coverage result in IndexedDB. On the next request, the server checks these identifiers against the current real CDX index and skips relevant captures that were already checked. A new Vercel instance can therefore continue without repeatedly starting from the first archived pages.

The cursor contains neither URLs nor listener counts and cannot create observations. Previously received verified observations and new responses are merged only in the browser, checking the artist, source, and metric. Saved listener counts are not sent back to the API as evidence of historical values. A forced recheck resets the cursor; a changed known artist identifier also discards incompatible accumulated observations.

The queue and its results belong to the user's browser. The server's public-table cache is not a shared user library or a persistent background job. Requests do not continue as a separate server task after the site is closed. On the next visit, the application uses saved results and schedules the checks it still needs.

## Early discovery ratio

For Kworb, the baseline is the latest real observation at or before the first listen, no more than 31 days earlier. Its value must be positive. A comparison also requires a later observation from the same source with the same metric.

```text
ratio = latest known listener count / baseline listener count
```

For example, growth from 13 to 2,000,000 gives approximately 153,846×. The values 530,000 / 500,000 give 1.06×, whereas 320 / 300 gives approximately 1.067×: the second ratio is slightly higher. Sorting uses the ratio rather than the absolute increase.

An observation after the first listen cannot replace the baseline. Zero is never used as a divisor. If a suitable baseline or a later observation is missing, the ratio remains unknown. The latest known value may refer to a past date and is not treated as a measurement taken right now.

## Chart

The chart displays one series of monthly listeners from one source. Its line and gradient fill connect real observations; they do not add daily measurements between captures. A single point does not produce a line.

A separate marker shows the first-listen date. If that date falls outside the available observations, the time axis expands without extrapolating audience values. Tooltips refer to existing points. Missing history is not replaced with zeroes, popularity, followers, or estimates.

## Optional source: Chartmetric

The API already includes a Chartmetric adapter, but the server owner must configure `CHARTMETRIC_REFRESH_TOKEN` and have suitable paid access to historical data. Set the token in the Vercel project's environment variables, or in `.env.local` for local development. Never place it in `VITE_*`, frontend code, or Git.

The adapter requests Spotify `listeners` starting 31 days before the first listen, accepts real numeric observations, and rejects points marked as interpolated by the source. Historical depth depends on the artist and access level. The free browser queue uses Kworb; adding a token does not automatically switch it to Chartmetric. Series from different providers are not joined to calculate a ratio.

Last.fm is useful for music metadata, but its listener counts describe Last.fm. They do not replace Spotify monthly listeners and are not used as that series on the chart. See the [Last.fm documentation](lastfm.md).

## API and implementation

- `GET /api/audience/providers` lists providers and their configuration status.
- `POST /api/audience/resolve` checks an artist batch and returns observations, coverage, and a continuation cursor.
- `POST /api/audience/import` is a compatible route for a smaller artist batch.

Routes and limits are described in the [HTTP API reference](api.md); hosting is covered by the [deployment guide](deployment.md). Implementation: [Kworb client](../../server/kworb.mjs), [audience adapter](../../server/audience.mjs), [browser queue](../../src/lib/useAudienceHistory.js), and [chart series preparation](../../src/lib/audience-series.js).

References: [Wayback CDX](https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server), [Internet Archive](https://web.archive.org/), and [Chartmetric historical metrics](https://apidocs.chartmetric.com/reference/tag/artist/get/api/artist/id/stat/source).
