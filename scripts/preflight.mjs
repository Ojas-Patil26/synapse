// Preflight: confirms required env vars are present and lists usable Gemini models.
// Run from the repo root:  node --env-file=.env scripts/preflight.mjs
// Never prints secret values.

const required = ["GEMINI_API_KEY", "SUPERMEMORY_API_KEY", "MONGODB_URI", "TIGERDATA_URL", "AWS_REGION"];
let ok = true;
for (const name of required) {
  const present = Boolean(process.env[name] && process.env[name].trim());
  console.log(`${present ? "ok     " : "MISSING"} ${name}`);
  if (!present) ok = false;
}
console.log(`AWS_REGION = ${process.env.AWS_REGION}`);

try {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
  });
  console.log(`Gemini ListModels HTTP ${res.status}`);
  if (res.ok) {
    const { models = [] } = await res.json();
    const usable = models
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => m.name.replace("models/", ""))
      .filter((n) => /^gemini-/.test(n) && !/(tts|image|audio|embedding|live)/.test(n));
    console.log(`Gemini text models (${usable.length}):`);
    for (const n of usable) console.log(`  ${n}`);
  } else {
    ok = false;
  }
} catch (err) {
  ok = false;
  console.log(`Gemini request failed: ${err.name}`);
}

const scheme = (v) => (v ?? "").split("://")[0] || "(none)";
console.log(`MONGODB_URI scheme: ${scheme(process.env.MONGODB_URI)}`);
console.log(`TIGERDATA_URL scheme: ${scheme(process.env.TIGERDATA_URL)}`);

process.exit(ok ? 0 : 1);
