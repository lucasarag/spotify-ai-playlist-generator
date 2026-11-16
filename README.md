# Crate: AI playlist agent for Spotify

Chat with an AI agent that creates and edits playlists in your Spotify account. It can build a 200-track themed playlist, prune songs you never play, or add new releases from your top artists. The app runs entirely on free tiers (Gemini or Groq).

Stack: Next.js 15 (App Router) · TypeScript · Tailwind CSS 4 · Vercel AI SDK 7 · Spotify OAuth (PKCE).

**No server secrets.** Anyone can host this or run it locally with zero environment variables. Each user brings their own free accounts, which the app asks for on first visit:

- **A Spotify Client ID.** Login uses the [PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow), which needs no client secret.
- **At least one free AI key**: Gemini, Groq, Cerebras, Mistral or OpenRouter (free `:free` models only). More keys give more fallbacks. There's no model to pick: Crate chooses automatically (see below).

Both are saved in that user's browser (`localStorage`). The AI key and a short-lived Spotify access token go with each chat request and are used for that request only. The server stores and logs neither.

## Run it

```bash
npm install
npm run dev        # http://127.0.0.1:3000
```

Open **http://127.0.0.1:3000**. If you open `localhost`, the app redirects to `127.0.0.1`, because Spotify only accepts loopback-IP redirect URIs. Then follow the on-screen setup:

1. Create an app in the [Spotify dashboard](https://developer.spotify.com/dashboard) and tick *Web API*.
2. Add the redirect URI shown in the app, `<origin>/callback`, for example `http://127.0.0.1:3000/callback`.
3. Paste the app's Client ID, plus a [Gemini](https://aistudio.google.com/apikey) or [Groq](https://console.groq.com/keys) key, and click **Connect Spotify**.

You own your Spotify app, so your account is already allowed. To let other people use *your* Client ID, add them under the app's *User Management*; Development Mode caps how many you can add.

## Deploy to Vercel

The app needs a server route (`/api/chat`) that calls the AI providers and Spotify, so it can't run on GitHub Pages, which only serves static files. Vercel runs Next.js natively, and its free Hobby plan is enough.

1. Push this repository to GitHub.
2. In Vercel, go to **Add New → Project**, import the repository, and click **Deploy**. Vercel detects Next.js, so you don't need any build settings or environment variables.
3. Open the deployed URL (e.g. `https://your-app.vercel.app`). The setup screen shows the exact redirect URI to add in your Spotify app: `https://your-app.vercel.app/callback`. Each person using the app adds it to *their own* Spotify app.
4. Every push to `main` redeploys automatically. Pull requests get preview URLs, and each preview URL needs its own redirect URI in Spotify if you want to log in there.

Optional: set `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` in Vercel to pre-fill a shared Spotify Client ID. It's public, not a secret. With a shared Client ID, the Spotify app owner must add each user under *User Management*.

Long playlist jobs can run for a few minutes. The chat route allows up to 300 seconds (`maxDuration`), which the Hobby plan supports.

## Two modes

**Quick playlist (default)** is built for free AI tiers:

1. **One** LLM call with no tools. The model replies in plain text: a name, a description, the requested count, and one `Title | Artist` per line.
2. The server, without the LLM, searches Spotify for each line as soon as it streams in. It picks the best match by title and artist, removes duplicates, then creates the playlist and adds tracks in batches of 100.
3. If too many suggestions aren't on Spotify, it makes **one** more small call for replacements.

A 200-track playlist costs 1–2 requests of about 2k tokens each. That fits Groq's free tokens-per-minute cap and uses little Gemini quota. Thinking is set to minimal, since writing a song list needs no reasoning. Code: `src/lib/quick/quick-playlist.ts`.

**Agent** is the tool-calling loop described below. It's for editing or analyzing existing playlists (pruning songs you don't play, adding new releases from your top artists). It makes several larger requests, so it's slower and hits free limits sooner.

## How it works

```
src/
  app/page.tsx               → components/app.tsx: setup / connect / chat
  app/callback/page.tsx      Spotify OAuth redirect: PKCE code exchange in the browser
  app/api/chat/route.ts      stateless: streamText + tools, using the credentials sent with the request
  lib/client/spotify-auth.ts PKCE login, automatic token refresh, sign-out
  lib/client/settings.ts     per-user settings in localStorage (Client ID, provider, keys, models)
  lib/ai/model-catalog.ts    discovers the models each key can use, ranks them, tracks cooldowns
  lib/ai/fallback-model.ts   one model that tries the ranked chain and switches on busy/rate-limit errors
  lib/quick/quick-playlist.ts quick mode: one plain-text LLM call → Spotify search → playlist
  lib/ai/tools.ts            the 7 agent tools (async generators → live progress)
  lib/spotify/http.ts        fetch with retry: 429 Retry-After + exponential backoff, 5xx retry, pagination, chunking
  lib/spotify/api.ts         typed endpoint wrappers (post-Feb-2026 Web API)
  components/                landing + settings form, chat, tool run log, playlist card
```

The agent has these tools:

| Tool | What it does |
| --- | --- |
| `getUserPlaylists` | All playlists with owner, ownership and track count; optional name filter |
| `getPlaylistTracks` | Full tracklist, paginated (50 per page) |
| `searchTracks` | Up to 250 queries per call; falls back to plain text when field filters miss; dedupes by URI and by title + primary artist |
| `getUserListeningStats` | Top tracks and artists (short, medium and long term) plus recent plays; with `analyzePlaylistId`, flags likely underplayed tracks |
| `getArtistsLatestReleases` | Albums and singles since N days ago, with their tracks |
| `createPlaylist` | `POST /me/playlists`, then adds tracks in chunks of 100 |
| `updatePlaylistTracks` | Add and/or remove tracks (chunks of 100), skipping duplicates |

**Live progress.** Each tool is an `async function*`. Intermediate `yield`s stream to the UI as preliminary results (for example "Added 100 of 200 songs…"). Only the final `yield` goes back to the model.

**Collections.** Search and release tools save their URIs under a `collectionId`. The model passes `collectionIds` to the write tools instead of re-emitting hundreds of URIs, which saves output tokens and avoids copy errors. Collections last for one response.

**Safety.** The agent is instructed to list tracks and wait for confirmation before removing anything from an existing playlist.

## Spotify API constraints (2026)

The code targets the February 2026 Web API changes for Development Mode apps:

- Search returns at most 10 results per request. Large requests page through results and are rate-limited by `mapLimit`.
- Playlist contents live under `/playlists/{id}/items`, and entries expose `item` rather than `track`.
- You can only read the contents of playlists you own or collaborate on.
- `popularity` and batch endpoints (`/tracks`, `/artists`, artist top tracks) are gone.
- Spotify exposes no play or skip counts. "Underplayed" means the track is not in your top 50 for any time range, not in your last 50 plays, and was added at least 14 days ago.

## Security notes

- Keys live in the browser's `localStorage`, where any script running on the page could read them. The app loads no third-party scripts, and assistant Markdown is rendered without raw HTML.
- On a shared deployment, users' keys pass through that server for each request. Only use deployments you trust, or run it yourself.
- **Disconnect** clears the Spotify tokens from the browser. To revoke access fully, remove the app at <https://www.spotify.com/account/apps/>.

## Automatic model choice and fallback

Users never pick a model. On each request the server:

1. Lists the models each saved key can use (cached for 30 minutes), keeps the ones suited to a fast tool-calling agent, and ranks them.
   - Gemini: newest Flash first, then Flash-Lite. Stable models rank above previews, and TTS, image and audio variants are excluded.
   - Groq: `gpt-oss-120b`, then `gpt-oss-20b`, then Qwen 3 and Llama 3.3 70B.
2. Interleaves the providers (best Gemini, best Groq, next Gemini…), so a provider-wide outage costs a single attempt.
3. Tries the chain in order. A model that is busy ("high demand"), rate-limited, retired, too small for the request, or silent for 45s is skipped, and the next one is tried right away. That applies to each step of the agent loop.
4. Cools down busy or rate-limited models for 60 seconds (or the provider's `Retry-After`) so later requests skip them, and retired models for 30 minutes.

Each answer ends with a small "Answered by …" line, plus a note whenever a switch happened. Adding keys for both providers gives the most resilience. If discovery fails, built-in lists are used instead (`STATIC_MODELS` in `model-catalog.ts`).

## Language

Prompts can be in Portuguese, English or any other language. The agent replies in the language of the latest message and names new playlists in it. It keeps original song titles in searches, so a Portuguese prompt still finds Japanese or English songs. Example prompts and the input placeholder switch to Portuguese when the browser language is `pt`.

## Continuous integration

`.github/workflows/ci.yml` runs lint, type-check and a production build on every push and pull request.

## Scripts

`npm run dev` · `npm run build` · `npm run lint` · `npm run typecheck`
