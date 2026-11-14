# Short Cut: YouTube Video Summarizer

Paste a YouTube link, get a summary with key points.

- `public/index.html`: the whole front end (HTML, CSS, JS)
- `src/index.js`: a Cloudflare Worker that gets the captions and summarizes them with Workers AI
- `wrangler.jsonc`: Cloudflare config (static files, the `/api/*` route and the Workers AI binding)

## Deploy

1. **GitHub**: put these files in your repo, keeping the folders: `public/index.html`, `src/index.js`, `wrangler.jsonc`.
2. **Cloudflare**: Workers & Pages > Create application > Connect to Git > pick the repo.
   Leave the build command empty and keep the default deploy command (`npx wrangler deploy`).
   The project name must match `"name"` in `wrangler.jsonc` (`summarize`).
3. Click Deploy. The Workers AI binding comes from `wrangler.jsonc`, so there is nothing else to set up.
4. Open your `*.workers.dev` link and try a video.

Every `git push` to the main branch redeploys the site automatically.

## Good to know

- Captions are read with an unofficial YouTube endpoint. It can stop working or get blocked, so the page has a "paste the transcript" box as a fallback.
- Workers AI has a free daily allowance. If you hit it, summaries fail until it resets (or you move to a paid plan).
- The language list lives in two places: `LANGUAGES` in `src/index.js` and the `<select id="lang">` in `public/index.html`. Keep them in sync.
- The page follows the device's light or dark setting automatically.
- To use a different model, change `MODEL` at the top of `src/index.js`.
