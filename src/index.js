// Cloudflare Worker: POST /api/summarize
// Body: { url?: string, transcript?: string, lang?: string }
// The Workers AI binding "AI" is declared in wrangler.jsonc.
// Everything in /public (index.html) is served by Workers static assets.

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
        "Workers AI is not connected. Add a binding named AI in your Cloudflare Pages settings, then redeploy.",
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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/summarize") {
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      return handleSummarize(request, env);
    }
    return json({ error: "Not found." }, 404);
  },
};
