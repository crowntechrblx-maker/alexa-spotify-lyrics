# Spotify Lyrics for Echo Show

A self-hosted, full-screen **"Now Playing" synced-lyrics display** for Spotify, built for the
**Echo Show 8 (2nd gen)** Silk browser (1280×800 touch screen). It also works fine in a laptop
browser.

- Album art, title, artist and a progress bar on the left; lyrics on the right.
- **Spicy Lyrics–style lyrics:** each word fills from dim to bright as it's sung, the current word
  lifts and glows slightly, lines blur more the further they are from the current one, and
  interludes show three filling, breathing dots.
- **Tap a lyric line** to jump the song to that line.
- Animated, blurred background made from the album art's colours.
- **Tap the album art** for play/pause/previous/next (needs Spotify Premium).
- Idle clock screen with the last played artwork when nothing is playing.
- Lyrics come from [LRCLIB](https://lrclib.net) (free, no key needed) and are cached in PostgreSQL.
  Optionally, Spotify's own lyrics fill the gaps ([see below](#optional-spotifys-own-lyrics)).

> **How the timing works:** the page follows whatever is playing on your Spotify account, on any
> device. It checks Spotify every 3 seconds, keeps a smooth local clock in between, and corrects
> any drift on each check. LRCLIB lyrics are usually **line-timed**, so the karaoke sweep across
> the words is spread across each line's time by word length. When LRCLIB has real word
> timings (enhanced LRC), those are used instead.

---

## Contents

1. [Create the Spotify developer app](#1-create-the-spotify-developer-app)
2. [Run it locally](#2-run-it-locally)
3. [Deploy for free (Render + Neon, optional subdomain)](#3-deploy-to-render)
4. [Log in to Spotify once](#4-log-in-to-spotify-once)
5. [Put it on the Echo Show](#5-put-it-on-the-echo-show)
6. [Reference: API, settings, troubleshooting](#reference)

---

## 1. Create the Spotify developer app

1. Go to <https://developer.spotify.com/dashboard> and log in with your normal Spotify account.
2. Click **Create app**.
   - **App name:** anything, e.g. `Echo Lyrics`
   - **App description:** anything
   - **Redirect URIs:** add **both** of these (press *Add* after each):
     - `http://127.0.0.1:3000/auth/callback` (for running on your computer)
     - `https://lyrics.example.com/auth/callback`, using your real domain from step 3. You can
       add this later. If you don't use a custom domain, use
       `https://YOUR-SERVICE.onrender.com/auth/callback`.
   - Under *Which API/SDKs are you planning to use?* tick **Web API**.
3. Accept the terms and click **Save**.
4. Open the app's **Settings**. Copy the **Client ID**, then click **View client secret** and copy
   the **Client secret**. You'll need both shortly.

Notes:
- Spotify no longer accepts `localhost` in redirect URIs. Use `127.0.0.1` exactly as above.
- New apps start in *Development mode*, which is fine for a single user (you). If your dashboard
  has a **User Management** tab, add your own Spotify account's email address there.
- The redirect URI must match **exactly**, including `https`, with no trailing slash.

## 2. Run it locally

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/crowntechrblx-maker/alexa-spotify-lyrics.git
```

```bash
cd alexa-spotify-lyrics
```

```bash
npm install
```

```bash
cp .env.example .env
```

Open `.env` in a text editor and fill it in:

| Variable | What to put |
| --- | --- |
| `SPOTIFY_CLIENT_ID` | From step 1 |
| `SPOTIFY_CLIENT_SECRET` | From step 1 |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:3000/auth/callback` |
| `DATABASE_URL` | Leave empty locally (an in-memory cache is used) |
| `SESSION_SECRET`, `ADMIN_KEY`, `DISPLAY_TOKEN` | A different long random string for each |

To make a random string, run this command and copy the result. Run it once per variable.

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Start the server:

```bash
npm start
```

Then, in your browser:

1. Open `http://127.0.0.1:3000/auth/login?key=YOUR_ADMIN_KEY` and approve the Spotify screen.
2. The success page shows your display link, `http://127.0.0.1:3000/?t=YOUR_DISPLAY_TOKEN`.
   Open it and play something on Spotify.

**Just want to look at it first?** `npm run demo` runs the display against a built-in fake
Spotify with placeholder songs (no account needed). Open the link it prints.

**Tests:** `npm test`. To also test against PostgreSQL, set `TEST_DATABASE_URL` first.

## 3. Deploy to Render

Everything here is **free**: [Render](https://render.com) runs the server and
[Neon](https://neon.tech) provides the PostgreSQL database. Neon's free database doesn't expire,
unlike Render's.

### 3a. Create the free database on Neon

1. Sign up at <https://neon.tech> (you can log in with GitHub). No card is needed.
2. Create a project with any name. Pick the region closest to where you'll run Render.
3. On the project dashboard, click **Connect** and copy the **connection string**. It looks like
   `postgresql://user:password@ep-something.eu-central-1.aws.neon.tech/neondb?sslmode=require`.
   Keep it handy; this is your `DATABASE_URL`. The app creates its tables by itself on first start.

### 3b. Create the web service on Render

1. Push this project to your GitHub account (it already is if you're reading this there).
2. In the Render dashboard click **New → Blueprint** and pick this repository.
3. Render reads `render.yaml` and shows one free web service (`spotify-lyrics`). It asks for the
   values it can't generate:
   - `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`: from step 1.
   - `SPOTIFY_REDIRECT_URI`: `https://lyrics.example.com/auth/callback` with your own domain. If
     you're skipping the custom domain, put `https://example.com/auth/callback` for now; you'll
     see your real `onrender.com` address after the first deploy and can change it then.
   - `DATABASE_URL`: the Neon connection string from 3a.
4. Click **Apply**. `SESSION_SECRET`, `ADMIN_KEY` and `DISPLAY_TOKEN` are generated for you.
5. When the deploy shows **Live**, copy your address from the top of the page (e.g.
   `https://spotify-lyrics-xxxx.onrender.com`).
6. Set the redirect URI to that address plus `/auth/callback` in **both** places:
   - Render → service → **Environment** → `SPOTIFY_REDIRECT_URI` (saving redeploys), and
   - the Spotify dashboard → your app → **Settings → Edit → Redirect URIs**.
7. While you're on Render's **Environment** page, reveal and copy `ADMIN_KEY` and
   `DISPLAY_TOKEN`. You'll need them in steps 4 and 5.

**Don't skip `DATABASE_URL` on Render.** Render's free servers lose their files whenever they
restart or wake from sleep. Without a database you'd have to log in to Spotify again after every
restart.

About the free plan: a free Render service goes to sleep after about 15 minutes with no visitors,
and the next visit takes about a minute to wake it. While the Echo shows the page it checks in
every 3 seconds, so it stays awake. The free plan's monthly hours cover one service running all
month.

### 3c. Add a custom subdomain (optional)

Example: `lyrics.example.com`.

1. In Render, open the web service → **Settings → Custom Domains → Add Custom Domain** and enter
   `lyrics.example.com`.
2. Render shows a DNS record to create. At your domain registrar or DNS provider (Cloudflare,
   Namecheap, GoDaddy…), add a **CNAME** record:
   - **Name/Host:** `lyrics`
   - **Value/Target:** your service's `something.onrender.com` address, as shown by Render.
   - If you use Cloudflare, set the record to **DNS only** (grey cloud) until Render verifies it.
3. Back in Render, click **Verify**. Render issues the HTTPS certificate automatically, which can
   take a few minutes.
4. Make sure `https://lyrics.example.com/auth/callback` is both:
   - in the Spotify dashboard's Redirect URIs (step 1), and
   - the value of `SPOTIFY_REDIRECT_URI` in Render → Environment. Saving there redeploys.

## 4. Log in to Spotify once

On your computer or phone (anything with a keyboard), open:

```
https://lyrics.example.com/auth/login?key=YOUR_ADMIN_KEY
```

Approve the Spotify screen. You'll land on a **"Spotify connected"** page showing your display
link. The refresh token is now stored in Postgres, and the server renews access tokens by itself,
so you never need to log in on the Echo, or again at all unless you revoke access.

## 5. Put it on the Echo Show

1. Say **"Alexa, open Silk"** (or "Alexa, open Silk browser").
2. Type just your site address, e.g. `lyrics.example.com`. No token needed. The screen shows a
   **6-digit code**.
   - On your phone or computer, open your full display link (`/?t=…`, shown after the Spotify
     login) once, then go to `lyrics.example.com/pair` in that same browser and enter the code.
     The "Spotify connected" page also has a ready-made `/pair` link.
   - The Echo links itself within a couple of seconds and remembers it from then on.
   - Alternatively, type the full `https://lyrics.example.com/?t=YOUR_DISPLAY_TOKEN` link once.
3. **Bookmark it:** open Silk's menu (the **⋮** or bookmark icon next to the address bar) and add
   a bookmark. Next time, say "Alexa, open Silk" and tap the bookmark.
4. Tap the screen once. On touch screens the page asks to go **full screen** on first touch, which
   also lets it ask the browser to keep the screen on.
5. **Keep the screen on as long as possible.** The page uses the Wake Lock API, plus a tiny
   invisible video as a fallback, to stop the browser from sleeping. The Echo's own settings still
   apply, and menu names differ between software versions:
   - Swipe down from the top of the screen → **Settings → Display**, and set any screen
     timeout or sleep option to its maximum (or *Never*, if offered).
   - Turn off anything that dims or rotates the screen when idle, such as *Adaptive Brightness* or
     night dimming, if you want it bright.
   - Some Echo software versions return to the Home screen after a while regardless. If that
     happens, reopen your Silk bookmark. Starting music from the Echo itself tends to keep Silk
     open longer.

Tips:
- Tap the album art for play/pause/skip (the buttons hide after 5 seconds). Tap a lyric line to
  jump there.
- **Full screen:** tap the album art and use **Full screen**, or double-tap any empty part of
  the screen (also works on the clock screen). On a laptop, press **F**. Touch screens switch to
  full screen by themselves on the first tap.
- **Lyrics a bit early or late?** Tap the album art and use **Earlier** / **Later**. Each tap moves
  the lyrics 0.1 s, and the setting is saved on that screen.
- If animations stutter on your Echo, add `&lite=1` to the link. That turns off the blur, masks
  and glow and stops the background from drifting.

---

## Reference

### Project layout

```
src/
  server.js    Express app: OAuth routes, API routes, static files
  spotify.js   Token refresh, throttled now-playing, controls
  lyrics.js    LRCLIB lookup (get → search fallback) + caching
  lrc.js       LRC parser (incl. enhanced word timings)
  store.js     PostgreSQL store, with in-memory fallback
  config.js    Environment variables
public/        The display page (plain HTML/CSS/JS, no build step)
scripts/       Demo mode and fake Spotify/LRCLIB used by tests
test/          node:test suites
render.yaml    Render blueprint
```

### Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | yes | Spotify app client ID |
| `SPOTIFY_CLIENT_SECRET` | yes | Spotify app client secret |
| `SPOTIFY_REDIRECT_URI` | yes | `https://your-host/auth/callback`; must match the dashboard |
| `DATABASE_URL` | no | PostgreSQL connection string; in-memory if empty |
| `SESSION_SECRET` | yes | Signs the OAuth `state` value |
| `ADMIN_KEY` | yes | Required as `?key=` on `/auth/login` |
| `DISPLAY_TOKEN` | yes | Required as `?t=` on the page and for every `/api` call |
| `DATABASE_SSL` | no | `true` or `false` to override automatic SSL detection |
| `SPOTIFY_SP_DC` | no | Turns on Spotify's own lyrics as a fallback (unofficial, see above) |
| `PORT` | no | Defaults to 3000 (Render sets it automatically) |

### API

Every `/api` route needs the display token, either as `?t=TOKEN` or as an `X-Display-Token`
header.

| Route | Description |
| --- | --- |
| `GET /api/now-playing` | `{ isPlaying, type, trackId, title, artists, album, albumArtUrl, durationMs, progressMs, serverTimestamp, lastPlayed }`. `type` is `track`, `episode`, `ad` or `none` (nothing playing). |
| `GET /api/lyrics?trackId=…` | `{ status: synced \| plain \| instrumental \| none, synced, wordSynced, lines: [{ timeMs, text, words? }], plainLyrics, message, cached }` |
| `POST /api/control/play\|pause\|next\|previous` | Playback control (Premium). `403 premium_required` or `404 no_active_device` explain failures. |
| `POST /api/control/seek?positionMs=…` | Jump to a position (used by tap-a-line). |
| `GET /api/art?url=…` | Same-origin copy of Spotify album art, used only if colour extraction is blocked by CORS. |
| `GET /auth/login?key=ADMIN_KEY` | Starts Spotify login. |
| `GET /auth/check?key=ADMIN_KEY` | Setup self-check: Spotify login, database, `sp_dc` cookie. |
| `GET /healthz` | Health check for Render. |

**Rate limiting:** however many screens are polling, the server calls Spotify's
currently-playing endpoint at most once every 2 seconds. In between, it serves the last snapshot
with the progress moved forward. If Spotify returns `429`, the server waits for the time in its
`Retry-After` header and keeps serving the last snapshot.

**Lyrics cache:** results are stored per Spotify track ID, including "no lyrics found". Misses are
retried after 3 days in case someone adds the lyrics to LRCLIB.

### Optional: Spotify's own lyrics

Some songs have lyrics in the Spotify app but not on LRCLIB. If you set `SPOTIFY_SP_DC`, the
server asks Spotify's web player for lyrics whenever LRCLIB has no synced lyrics.

**Read this first:** this uses a private Spotify endpoint, not the public API. It's against
Spotify's terms, it can stop working whenever Spotify changes things, and the cookie is
effectively your Spotify login, so keep it secret. LRCLIB is always tried first.

1. On a computer, open <https://open.spotify.com> in Chrome or Edge and make sure you're logged in.
2. Press **F12** to open the developer tools and go to the **Application** tab (in Firefox,
   **Storage**).
3. In the left panel, expand **Cookies** and click `https://open.spotify.com`.
4. Find the row named **`sp_dc`** and copy its whole **Value**. It's a long string.
5. In Render → your service → **Environment**, add `SPOTIFY_SP_DC` with that value and save.
6. After the redeploy, open `/auth/check?key=YOUR_ADMIN_KEY`. It should say **"The sp_dc
   cookie works"**.

Then:
- **If logging out of Spotify in that browser:** the cookie may stop working. Remove the browser's
  cookies instead of logging out, or just repeat the steps.
- **When the cookie expires** (roughly yearly): repeat the steps.
- **If `/auth/check` reports "Could not load web player secrets":** the community-maintained list
  of the web player's rotating keys has moved. Set `SPOTIFY_SECRETS_URL` to its new address.

Songs that previously had no lyrics are looked up again automatically once this is switched on.

### Troubleshooting

- **"Spotify isn't connected yet"**: do step 4. If you revoked the app's access in your Spotify
  account settings, do step 4 again.
- **`INVALID_CLIENT: Invalid redirect URI`** on the Spotify screen: `SPOTIFY_REDIRECT_URI` and
  the dashboard entry differ. Check `http`/`https`, the domain and the path.
- **"Login link expired or invalid"**: start from `/auth/login?key=…` again, in the same browser,
  within 10 minutes.
- **"Invalid display token"**: the `?t=` value doesn't match `DISPLAY_TOKEN`.
- **Controls show "needs Spotify Premium"**: Spotify only allows playback control for Premium
  accounts. Lyrics still work without Premium.
- **Lyrics slightly early or late**: tap the album art and use **Earlier** / **Later**.
- **Screen asks for a code again**: the `DISPLAY_TOKEN` changed on the server, or the Echo's browser
  data was cleared. Enter the new code at `/pair`.
