// Cloudflare Worker: POST /api/summarize
// Body: { url?: string, transcript?: string, lang?: string }
// The Workers AI binding "AI" is declared in wrangler.jsonc.
// The web page itself is the PAGE constant below and is served at "/".

const MODEL = "@cf/meta/llama-3.1-8b-instruct"; // change here to try another Workers AI model
const CHUNK_SIZE = 8000; // characters per piece sent to the model
const MAX_CHUNKS = 10;   // about 80,000 characters of transcript at most

// Keep this list in sync with the <select id="lang"> in index.html.
const LANGUAGES = ["English", "Hindi", "Spanish", "French", "German", "Portuguese"];

const finalPrompt = (language) => `You summarize YouTube videos for students.
Use only the text you are given. Write the whole reply in ${language}, including the headings.
Use Markdown with exactly this shape:
## Overview
(2 to 3 sentences)
## Key points
(5 to 8 bullets starting with "- ")
## Takeaway
(1 to 2 sentences)`;

const PART_PROMPT =
  "Summarize this part of a video transcript in 5 to 8 short bullet points. Keep names, numbers and facts.";

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function handleSummarize(request, env) {
  try {
    if (!env.AI) {
      throw new HttpError(
        "Workers AI is not connected. Check that wrangler.jsonc contains the ai binding named AI, then redeploy.",
        500
      );
    }

    const { url = "", transcript = "", lang = "English" } = await request.json();
    const language = LANGUAGES.includes(lang) ? lang : "English";
    let text = transcript.trim();
    let title = "";

    if (!text) {
      const id = getVideoId(url);
      if (!id) throw new HttpError("That does not look like a YouTube link. Check it and try again.", 400);
      ({ text, title } = await getTranscript(id));
    }

    text = text.replace(/\s+/g, " ").trim();
    if (text.length < 80) {
      throw new HttpError("The transcript is too short to summarize.", 422);
    }

    const { summary, truncated } = await summarize(env, text, language);
    return json({ title, summary, truncated });
  } catch (err) {
    return json({ error: err.message || "Unexpected error." }, err.status || 500);
  }
}

function getVideoId(input) {
  const value = input.trim();
  try {
    const u = new URL(value);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (u.hostname.endsWith("youtube.com")) {
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    // not a URL, fall through
  }
  return /^[\w-]{11}$/.test(value) ? value : null;
}

// Unofficial: reads the caption track YouTube exposes for the video.
// YouTube can change or block this at any time, which is why the page has a paste-transcript fallback.
async function getTranscript(id) {
  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
    },
    body: JSON.stringify({
      context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
      videoId: id,
    }),
  });
  if (!res.ok) throw new HttpError("Could not reach YouTube. Paste the transcript instead.", 422);

  const data = await res.json();
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) {
    throw new HttpError("This video has no captions available. Paste the transcript instead.", 422);
  }

  const track = tracks.find((t) => t.languageCode?.startsWith("en")) || tracks[0];
  const capRes = await fetch(track.baseUrl + "&fmt=json3");
  if (!capRes.ok) throw new HttpError("Could not download the captions. Paste the transcript instead.", 422);

  const caps = await capRes.json();
  const text = (caps.events || [])
    .filter((e) => e.segs)
    .map((e) => e.segs.map((s) => s.utf8).join(""))
    .join(" ");

  return { text, title: data?.videoDetails?.title || "" };
}

async function ask(env, system, user, maxTokens) {
  const out = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
  });
  return (out.response || "").trim();
}

// Map-reduce: summarize each chunk, then summarize the notes.
async function summarize(env, text, language) {
  const limit = CHUNK_SIZE * MAX_CHUNKS;
  const truncated = text.length > limit;
  text = text.slice(0, limit);

  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) chunks.push(text.slice(i, i + CHUNK_SIZE));

  const source =
    chunks.length === 1
      ? chunks[0]
      : (await Promise.all(chunks.map((c) => ask(env, PART_PROMPT, c, 350)))).join("\n");

  const summary = await ask(env, finalPrompt(language), source, 1000);
  if (!summary) throw new HttpError("The AI returned an empty answer. Try again.", 502);
  return { summary, truncated };
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Short Cut: YouTube video summarizer</title>
<meta name="description" content="Paste a YouTube link and get a short summary with key points.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;800&family=Source+Serif+4:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#f2f5fb; --card:#fff; --ink:#14213d; --muted:#55607a;
  --line:#d3dbec; --mark:#ffd23f; --on-mark:#14213d; --err:#b42318;
  --head:"Bricolage Grotesque",system-ui,sans-serif;
  --body:"Source Serif 4",Georgia,serif;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#0e1424;--card:#161e36;--ink:#eef1fa;--muted:#a3adc7;--line:#2b3658;--err:#ff8a80}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:1.05rem/1.7 var(--body)}
main{max-width:700px;margin:0 auto;padding:clamp(32px,8vw,88px) 20px 80px}
h1{font:800 clamp(2.2rem,7vw,3.6rem)/1.05 var(--head);letter-spacing:-.03em;margin:0 0 14px}
.sub{color:var(--muted);margin:0 0 32px;max-width:52ch}
label,summary,button,.meta{font-family:var(--head)}
label{display:block;font-weight:600;margin-bottom:8px}
input,textarea,select{width:100%;padding:14px 16px;border:2px solid var(--ink);border-radius:6px;background:var(--card);color:var(--ink);font:1rem var(--body)}
input:focus-visible,textarea:focus-visible,select:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid var(--mark);outline-offset:2px}
.lang{margin-top:18px}
select{max-width:240px}
details{margin:16px 0 0}
summary{cursor:pointer;color:var(--muted);font-weight:600;font-size:.95rem}
details textarea{margin-top:10px;border-color:var(--line)}
button{margin-top:20px;padding:14px 26px;border:2px solid var(--ink);border-radius:6px;background:var(--mark);color:var(--on-mark);font-weight:800;font-size:1rem;cursor:pointer}
button:hover:not(:disabled){background:var(--ink);color:var(--bg)}
button:disabled{opacity:.6;cursor:wait}
#status{margin:28px 0 0;font-family:var(--head);font-weight:600}
#status.error{color:var(--err)}
#status.loading::before{content:"";display:inline-block;width:.9em;height:.9em;margin-right:.6em;border:3px solid var(--line);border-top-color:var(--ink);border-radius:50%;animation:spin .8s linear infinite;vertical-align:-.1em}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#status.loading::before{animation:none}}
#result{display:none;margin-top:36px;padding:28px clamp(20px,5vw,36px);background:var(--card);border:2px solid var(--ink);border-radius:6px;box-shadow:8px 8px 0 var(--mark)}
#result h2{font:800 1.5rem/1.2 var(--head);margin:0 0 6px}
#result h3{font:600 .95rem var(--head);color:var(--muted);margin:26px 0 8px}
#result p{margin:0 0 12px}
#result ul{margin:0;padding:0;list-style:none}
#result li{padding:8px 0 8px 18px;border-left:5px solid var(--mark);margin-bottom:8px}
.meta{color:var(--muted);font-size:.85rem;margin:0 0 4px}
#copy{margin-top:18px;padding:8px 16px;font-size:.9rem;background:var(--card);color:var(--ink)}
</style>
</head>
<body>
<main>
  <h1>Paste a YouTube link. Get the short version.</h1>
  <p class="sub">Short Cut reads the captions of a video and writes a summary with the key points, usually in under 30 seconds.</p>

  <form id="form">
    <label for="url">YouTube link</label>
    <input id="url" type="url" placeholder="https://www.youtube.com/watch?v=..." autocomplete="off">
    <label class="lang" for="lang">Summary language</label>
    <select id="lang">
      <option>English</option><option>Hindi</option><option>Spanish</option>
      <option>French</option><option>German</option><option>Portuguese</option>
    </select>
    <details id="paste">
      <summary>No captions found? Paste the transcript instead</summary>
      <textarea id="transcript" rows="6" placeholder="Paste the transcript text here"></textarea>
    </details>
    <button id="go" type="submit">Summarize video</button>
  </form>

  <p id="status" role="status" aria-live="polite"></p>

  <section id="result" aria-live="polite">
    <p class="meta">Summary</p>
    <h2 id="title"></h2>
    <div id="summary"></div>
    <button id="copy" type="button">Copy summary</button>
  </section>
</main>

<script>
const $ = (s) => document.querySelector(s);
const btn = $("#go"), statusEl = $("#status"), result = $("#result");

function setStatus(type, msg) {
  statusEl.className = type;
  statusEl.textContent = msg;
}

// Turns the model's simple Markdown (## headings, - bullets) into safe DOM nodes.
function renderSummary(md) {
  const box = $("#summary");
  box.textContent = "";
  let list = null;
  for (const raw of md.split("\n")) {
    const line = raw.trim().replace(/\*\*/g, "");
    if (!line) continue;
    if (/^[-*•]\s+/.test(line)) {
      if (!list) { list = document.createElement("ul"); box.appendChild(list); }
      const li = document.createElement("li");
      li.textContent = line.replace(/^[-*•]\s+/, "");
      list.appendChild(li);
      continue;
    }
    list = null;
    const heading = line.match(/^#{1,4}\s+(.*)/);
    const el = document.createElement(heading ? "h3" : "p");
    el.textContent = heading ? heading[1] : line;
    box.appendChild(el);
  }
}

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("#url").value.trim();
  const transcript = $("#transcript").value.trim();
  if (!url && !transcript) return setStatus("error", "Enter a YouTube link to start.");

  btn.disabled = true;
  result.style.display = "none";
  setStatus("loading", "Reading the video and writing your summary…");

  try {
    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, transcript, lang: $("#lang").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 422) $("#paste").open = true;
      throw new Error(data.error || "Something went wrong. Try again in a moment.");
    }
    $("#title").textContent = data.title || "Video summary";
    renderSummary(data.summary);
    if (data.truncated) {
      const note = document.createElement("p");
      note.className = "meta";
      note.textContent = "This video is long, so only the first part was summarized.";
      $("#summary").appendChild(note);
    }
    result.style.display = "block";
    setStatus("", "");
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setStatus("error", err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#title").textContent + "\n\n" + $("#summary").innerText);
    $("#copy").textContent = "Copied";
    setTimeout(() => ($("#copy").textContent = "Copy summary"), 1500);
  } catch {
    setStatus("error", "Could not copy. Select the text and copy it manually.");
  }
});
</script>
</body>
</html>
`;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/summarize") {
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      return handleSummarize(request, env);
    }
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return json({ error: "Not found." }, 404);
  },
};
