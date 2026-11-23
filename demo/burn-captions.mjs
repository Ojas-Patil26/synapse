/**
 * Build timed captions from scene scripts + durations, burn into the demo MP4.
 */
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenes = JSON.parse(readFileSync(join(__dirname, "scenes.json"), "utf8"));
const timings = JSON.parse(readFileSync(join(__dirname, "scenes/timings.json"), "utf8"));
const byId = Object.fromEntries(timings.map((t) => [t.id, t.duration]));

function formatAssTime(s) {
  const ms = Math.max(0, Math.round(s * 100));
  const h = Math.floor(ms / 360000);
  const m = Math.floor((ms % 360000) / 6000);
  const sec = Math.floor((ms % 6000) / 100);
  const cs = ms % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function formatSrtTime(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(milli).padStart(3, "0")}`;
}

function chunkText(text) {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  const chunks = [];
  for (const sentence of sentences) {
    const words = sentence.split(" ");
    if (words.length <= 14) {
      chunks.push(sentence);
      continue;
    }
    let buf = [];
    for (const w of words) {
      buf.push(w);
      const join = buf.join(" ");
      const atBreak = /[,;:—–-]$/.test(w) || buf.length >= 12;
      if (atBreak && buf.length >= 7) {
        chunks.push(join);
        buf = [];
      } else if (buf.length >= 14) {
        chunks.push(join);
        buf = [];
      }
    }
    if (buf.length) chunks.push(buf.join(" "));
  }
  return chunks;
}

function wrapCaption(text) {
  if (text.length <= 44) return text;
  const words = text.split(" ");
  const line1 = [];
  const line2 = [];
  for (const w of words) {
    const target = line1.join(" ").length < 40 && line2.length === 0 ? line1 : line2;
    target.push(w);
  }
  if (!line2.length) return line1.join(" ");
  return `${line1.join(" ")}\\N${line2.join(" ")}`;
}

function wrapSrt(text) {
  return text.replace(/\\N/g, "\n");
}

const cues = [];
let t = 0;
for (const scene of scenes) {
  const dur = byId[scene.id];
  let chunks = chunkText(scene.text);
  // Merge tiny fragments ("Hi.") into the next line
  const merged = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].split(/\s+/).length <= 2 && i + 1 < chunks.length) {
      merged.push(`${chunks[i]} ${chunks[i + 1]}`);
      i++;
    } else {
      merged.push(chunks[i]);
    }
  }
  chunks = merged;
  const weights = chunks.map((c) => Math.max(1, c.split(/\s+/).length));
  const totalW = weights.reduce((a, b) => a + b, 0);
  let cursor = t;
  chunks.forEach((chunk, i) => {
    const slice = (weights[i] / totalW) * dur;
    const start = cursor + (i === 0 ? 0.08 : 0.05);
    const end = cursor + slice - 0.04;
    if (end > start + 0.35) cues.push({ start, end, text: wrapCaption(chunk) });
    cursor += slice;
  });
  t += dur;
}

let srt = "";
cues.forEach((c, i) => {
  srt += `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${wrapSrt(c.text)}\n\n`;
});
writeFileSync(join(__dirname, "captions.srt"), srt);

const ass = `[Script Info]
Title: Synapse JFF Demo
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Helvetica,34,&H00FFFFFF,&H000000FF,&H00000000,&H90000000,0,0,0,0,100,100,0,0,4,0,0,2,60,60,42,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${cues.map((c) => `Dialogue: 0,${formatAssTime(c.start)},${formatAssTime(c.end)},Default,,0,0,0,,${c.text}`).join("\n")}
`;
writeFileSync(join(__dirname, "captions.ass"), ass);
console.log("cues", cues.length);

const r = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    "Synapse-JFF-Future-of-Work-Demo.mp4",
    "-vf",
    "ass=captions.ass",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "medium",
    "-crf",
    "19",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    "Synapse-JFF-Future-of-Work-Demo-captions.mp4",
  ],
  { encoding: "utf8", cwd: __dirname },
);

if (r.status !== 0) {
  console.error(r.stderr?.slice(-2500));
  process.exit(1);
}

spawnSync("cp", ["Synapse-JFF-Future-of-Work-Demo-captions.mp4", "Synapse-JFF-Future-of-Work-Demo.mp4"], { cwd: __dirname });
console.log("OUT Synapse-JFF-Future-of-Work-Demo.mp4");
