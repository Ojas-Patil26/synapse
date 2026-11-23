/**
 * Generate demo voiceover via HeyGen TTS.
 * Requires: export HEYGEN_API_KEY=...
 * Voice: 4fb113051a204040826fddb19f29c21c
 */
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VOICE_ID = "4fb113051a204040826fddb19f29c21c";
const KEY = process.env.HEYGEN_API_KEY;

if (!KEY) {
  console.error("Missing HEYGEN_API_KEY. Export it in your terminal, then re-run.");
  process.exit(1);
}

const text = readFileSync(join(__dirname, "script.txt"), "utf8").trim();

async function tryTts(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Api-Key": KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = { raw };
  }
  return { status: res.status, json, headers: Object.fromEntries(res.headers) };
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.length;
}

async function main() {
  // Prefer HeyGen Voice TTS; fall back to catalog speech endpoint.
  let result = await tryTts("https://api.heygen.com/v3/models/audio/tts", {
    model: "heygen-voice-1-turbo-free",
    voice_id: VOICE_ID,
    text,
    language: "en",
    expressiveness_boost: 0.55,
  });

  if (result.status >= 400) {
    console.error("tts turbo-free failed", result.status, JSON.stringify(result.json).slice(0, 500));
    result = await tryTts("https://api.heygen.com/v3/models/audio/tts", {
      model: "heygen-voice-1",
      voice_id: VOICE_ID,
      text,
      language: "en",
      expressiveness_boost: 0.55,
    });
  }

  if (result.status >= 400) {
    console.error("tts paid failed", result.status, JSON.stringify(result.json).slice(0, 500));
    result = await tryTts("https://api.heygen.com/v3/voices/speech", {
      text,
      voice_id: VOICE_ID,
    });
  }

  if (result.status >= 400) {
    console.error("all endpoints failed", result.status, JSON.stringify(result.json).slice(0, 800));
    process.exit(1);
  }

  const audioUrl =
    result.json?.audio_url ||
    result.json?.data?.audio_url ||
    result.json?.data?.url ||
    result.json?.url;

  if (!audioUrl) {
    console.error("No audio_url in response:", JSON.stringify(result.json).slice(0, 800));
    process.exit(1);
  }

  const dest = join(__dirname, "voiceover-heygen.wav");
  const bytes = await download(audioUrl, dest);
  console.log("VOICE", dest, "bytes", bytes, "duration_hint", result.json?.duration ?? result.json?.data?.duration);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
