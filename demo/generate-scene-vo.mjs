/** Generate per-scene HeyGen VO clips for A/V sync. */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VOICE_ID = "4fb113051a204040826fddb19f29c21c";
const KEY = process.env.HEYGEN_API_KEY;
if (!KEY) {
  console.error("Missing HEYGEN_API_KEY");
  process.exit(1);
}

const scenes = JSON.parse(readFileSync(join(__dirname, "scenes.json"), "utf8"));
const outDir = join(__dirname, "scenes");
mkdirSync(outDir, { recursive: true });

async function tts(text) {
  const attempts = [
    { model: "heygen-voice-1-turbo-free", expressiveness_boost: 0.55 },
    { model: "heygen-voice-1", expressiveness_boost: 0.55 },
  ];
  for (const extra of attempts) {
    const res = await fetch("https://api.heygen.com/v3/models/audio/tts", {
      method: "POST",
      headers: { "X-Api-Key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ voice_id: VOICE_ID, text, language: "en", ...extra }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      const url = json.audio_url || json.data?.audio_url;
      if (url) return { url, duration: json.duration ?? json.data?.duration, model: extra.model };
    }
    console.error("attempt failed", extra.model, res.status, JSON.stringify(json).slice(0, 200));
  }
  throw new Error("TTS failed");
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`dl ${r.status}`);
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

function probeDuration(path) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], { encoding: "utf8" });
  return Number(r.stdout.trim());
}

const timings = [];
for (const scene of scenes) {
  process.stdout.write(`TTS ${scene.id}... `);
  const { url, duration, model } = await tts(scene.text);
  const wav = join(outDir, `${scene.id}.wav`);
  await download(url, wav);
  const probed = probeDuration(wav);
  timings.push({ id: scene.id, page: scene.page, duration: probed, heygen_duration: duration, model });
  console.log(`${probed.toFixed(2)}s (${model})`);
  // gentle rate limit
  await new Promise((r) => setTimeout(r, 800));
}

writeFileSync(join(outDir, "timings.json"), JSON.stringify(timings, null, 2));
console.log("TIMINGS", join(outDir, "timings.json"));
console.log("TOTAL", timings.reduce((s, t) => s + t.duration, 0).toFixed(2));
