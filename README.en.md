[Русский](README.md)

# OG.Listener

Interactive analytics for your official Spotify listening history. Upload your ZIP or JSON file to explore your favorite tracks, artists, and how your taste in music has changed.

## Features

- Your entire track and artist library, with artwork sized by play count or artist audience growth.
- A top three, case- and punctuation-insensitive search, and filters for genre, dates, play count, and listening duration.
- Charts of your listening activity and available audience history, plus the date you first heard a track or artist.
- One player that keeps playing after you close a card, using available full recordings or clearly labeled previews.
- A responsive interface in Russian and English, with automatic browser language detection and a saved manual language choice.

## Quick start

Requires **Node.js 22+**. From the repository root:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173/upload** and select your official Spotify archive. Both the extended `Streaming_History_Audio` format and the standard `StreamingHistory` format are supported. Visitors to the deployed site need only a browser and their own archive.

For a local production build:

```sh
npm test
npm run build
npm start
```

The server will be available at **http://127.0.0.1:3000**.

## GitHub Pages + Vercel API

The frontend is published to GitHub Pages; the API runs as a Node.js Function on Vercel. The API fetches artwork, genres, audio, and audience history. Your personal archive is parsed in the browser.

1. Import the repository into Vercel. Select **Other**, Node.js **24.x**, and the directory containing `vercel.json`. In the **Production** environment, set `CORS_ORIGINS=https://username.github.io`, using the frontend address **without the repository path**. For a custom domain, use its origin. The Vercel configuration already defines the API build; it does not need `npm start` or `API_ONLY`. The production API URL must be accessible without Vercel authentication.
2. In your GitHub repository, open **Settings → Secrets and variables → Actions → Variables** and create a variable named `VITE_API_BASE_URL` with the value `https://your-api.vercel.app`, **without `/api` or any other path**.
3. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**. The [pages.yml](.github/workflows/pages.yml) workflow builds and publishes only `dist/` on pushes to `main` or when run manually.

The repository path is handled automatically. On Pages, the upload screen uses `#/upload`, for example `https://username.github.io/OG.Listener/#/upload`; the local `/upload` route continues to work. Provider keys belong only on the API server: all `VITE_*` variables are public.

The configuration is ready; the deployment and URLs still need to be set up in Vercel and GitHub. See the [deployment guide](docs/en/deployment.md) for setup steps, connection checks, and serverless limitations.

## Sources and configuration

Artwork and metadata come from Spotify oEmbed, Deezer, and Apple/iTunes; MusicBrainz adds genre information. Audius provides available full recordings, while Deezer and Apple provide previews. Monthly listener history is requested from Kworb and the Internet Archive.

The main sources do not require keys. Optional Last.fm, Jamendo, and Chartmetric integrations are configured through Vercel environment variables, or through `.env.local` when running locally. Variable names are listed in [.env.example](.env.example). Keep real keys out of Git and `VITE_*` variables.

## Personal data and limitations

Your archive is parsed in the browser and is never uploaded to the server. Personal listening history is stored in IndexedDB, so each visitor sees their own library. It remains available at the same site address and in the same browser profile until browser data is cleared. There is no synchronization between devices. Uploading another archive replaces the library.

The API receives music titles and identifiers to look up metadata. Audience history requests also include the artist and the first listening date. The shared server cache stores public metadata in memory. The browser fetches images and audio directly from providers; the application does not create local media files.

External catalogs have incomplete coverage. Genres come from metadata for tracks that have already been processed. Historical listener counts are available only for artists found in the sources and for actual archived dates; missing values are not invented. If a full recording is unavailable, the player uses an available preview.

## Documentation

- [Deployment and capacity](docs/en/deployment.md)
- [HTTP API](docs/en/api.md)
- [Genres and filters](docs/en/genre-filters.md)
- [Audio sources](docs/en/audio-sources.md)
- [Audience history](docs/en/audience-sources.md)
- [Last.fm](docs/en/lastfm.md)
- [Metadata preload estimates](docs/en/preload-estimate.md)
