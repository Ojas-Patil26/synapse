/**
 * Build A/V-synced demo:
 * - concat scene WAVs for VO
 * - cut recorded webm using record marks
 * - fit each video slice to that scene's audio duration (trim or freeze-pad)
 * - concat + mux
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenesDir = join(__dirname, "scenes");
const work = join(__dirname, "assemble");
mkdirSync(work, { recursive: true });

const timings = JSON.parse(readFileSync(join(scenesDir, "timings.json"), "utf8"));
const marksFile = JSON.parse(readFileSync(join(scenesDir, "record-marks.json"), "utf8"));
const marks = marksFile.marks;

const rawDir = join(__dirname, "../frontend/raw-synced");
const webm = readdirSync(rawDir).find((f) => f.endsWith(".webm"));
if (!webm) throw new Error("no raw-synced webm");
const rawPath = join(rawDir, webm);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    throw new Error(`${cmd} failed`);
  }
  return r;
}

function probe(path) {
  return Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path]).stdout.trim());
}

// 1) concat audio
const listAudio = timings.map((t) => `file '${join(scenesDir, `${t.id}.wav`)}'`).join("\n");
writeFileSync(join(work, "audio.txt"), listAudio);
run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", join(work, "audio.txt"), "-c", "copy", join(work, "vo.wav")]);
const voDur = probe(join(work, "vo.wav"));
console.log("VO duration", voDur);

// 2) per-scene video slices fitted to audio duration
const videoParts = [];
for (let i = 0; i < timings.length; i++) {
  const t = timings[i];
  const start = marks[i].at;
  const end = i + 1 < marks.length ? marks[i + 1].at : start + Math.max(t.duration, 8);
  const srcDur = Math.max(0.2, end - start);
  const target = t.duration;
  const rawCut = join(work, `${t.id}-raw.mp4`);
  const fitted = join(work, `${t.id}-fit.mp4`);

  // cut source slice
  run("ffmpeg", [
    "-y",
    "-ss",
    String(start),
    "-i",
    rawPath,
    "-t",
    String(srcDur),
    "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    rawCut,
  ]);

  if (srcDur >= target - 0.05) {
    // Prefer the end of overlong slices for action beats (login filled, scrolled landing).
    const keepEnd = new Set(["02-landing-map", "03-login", "05-review"]);
    const trimStart = keepEnd.has(t.id) ? Math.max(0, srcDur - target) : 0;
    run("ffmpeg", [
      "-y",
      "-ss",
      String(trimStart),
      "-i",
      rawCut,
      "-t",
      String(target),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      fitted,
    ]);
  } else {
    // freeze-pad last frame
    const pad = target - srcDur;
    run("ffmpeg", [
      "-y",
      "-i",
      rawCut,
      "-vf",
      `tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`,
      "-t",
      String(target),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      fitted,
    ]);
  }

  const got = probe(fitted);
  console.log(t.id, `src=${srcDur.toFixed(2)} target=${target.toFixed(2)} got=${got.toFixed(2)}`);
  videoParts.push(fitted);
}

const listVideo = videoParts.map((p) => `file '${p}'`).join("\n");
writeFileSync(join(work, "video.txt"), listVideo);
run("ffmpeg", [
  "-y",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  join(work, "video.txt"),
  "-c",
  "copy",
  join(work, "picture.mp4"),
]);

const out = join(__dirname, "Synapse-JFF-Future-of-Work-Demo.mp4");
run("ffmpeg", [
  "-y",
  "-i",
  join(work, "picture.mp4"),
  "-i",
  join(work, "vo.wav"),
  "-filter_complex",
  "[0:v]fade=t=in:st=0:d=0.5,fade=t=out:st=" + (voDur - 1.4).toFixed(2) + ":d=1.2[v];[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.25,afade=t=out:st=" + (voDur - 1.3).toFixed(2) + ":d=1.1[a]",
  "-map",
  "[v]",
  "-map",
  "[a]",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-preset",
  "medium",
  "-crf",
  "19",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-shortest",
  "-movflags",
  "+faststart",
  out,
]);

console.log("OUT", out, "duration", probe(out));
