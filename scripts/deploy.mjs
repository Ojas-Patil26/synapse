// Deploys Synapse: backend stack (Serverless Framework), then the frontend to S3 + CloudFront.
//
// Run from the repo root:
//   node --env-file=.env scripts/deploy.mjs                 full deploy
//   node --env-file=.env scripts/deploy.mjs --backend-only
//   node --env-file=.env scripts/deploy.mjs --frontend-only
//
// Secrets come from the environment (loaded by --env-file) and are never printed.
// Set SITE_CERT_ARN (ACM certificate in us-east-1) to attach the custom domain.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGION = "us-east-2";
const STAGE = "dev";
const STACK = `synapse-${STAGE}`;
const args = new Set(process.argv.slice(2));
const doBackend = !args.has("--frontend-only");
const doFrontend = !args.has("--backend-only");

function run(cmd, cmdArgs, cwd, { capture = false } = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (res.status !== 0) {
    console.error(`\nFAILED: ${cmd} ${cmdArgs.join(" ")} (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
  return res.stdout ?? "";
}

for (const name of ["GEMINI_API_KEY", "SUPERMEMORY_API_KEY", "MONGODB_URI", "TIGERDATA_URL"]) {
  if (!process.env[name]) {
    console.error(`Missing ${name}. Run with: node --env-file=.env scripts/deploy.mjs`);
    process.exit(1);
  }
}

if (doBackend) {
  console.log(`\n== Deploying backend stack ${STACK} to ${REGION} ==`);
  console.log(process.env.SITE_CERT_ARN ? "Custom domain: enabled (SITE_CERT_ARN set)" : "Custom domain: off (no SITE_CERT_ARN)");
  run("serverless", ["deploy", "--stage", STAGE, "--region", REGION], root);
}

const raw = run(
  "aws",
  ["cloudformation", "describe-stacks", "--stack-name", STACK, "--region", REGION, "--query", "Stacks[0].Outputs", "--output", "json"],
  root,
  { capture: true },
);
const outputs = Object.fromEntries(JSON.parse(raw).map((o) => [o.OutputKey, o.OutputValue]));
const required = ["HttpApiUrl", "UserPoolId", "UserPoolClientId", "SiteBucketName", "SiteDistributionId", "SiteDistributionDomain"];
for (const key of required) {
  if (!outputs[key]) {
    console.error(`Stack output ${key} is missing.`);
    process.exit(1);
  }
}

if (doFrontend) {
  console.log("\n== Building frontend ==");
  writeFileSync(
    join(root, "frontend", ".env.production"),
    [
      `VITE_API_BASE_URL=${outputs.HttpApiUrl}`,
      `VITE_COGNITO_USER_POOL_ID=${outputs.UserPoolId}`,
      `VITE_COGNITO_CLIENT_ID=${outputs.UserPoolClientId}`,
      "VITE_USE_FIXTURES=false",
      "",
    ].join("\n"),
  );
  run("npm", ["run", "build"], join(root, "frontend"));

  console.log("\n== Uploading site ==");
  const bucket = `s3://${outputs.SiteBucketName}`;
  run("aws", ["s3", "sync", "dist", bucket, "--delete", "--region", REGION, "--cache-control", "public,max-age=31536000,immutable", "--exclude", "index.html"], join(root, "frontend"));
  run("aws", ["s3", "cp", "dist/index.html", `${bucket}/index.html`, "--region", REGION, "--cache-control", "no-cache"], join(root, "frontend"));
  run("aws", ["cloudfront", "create-invalidation", "--distribution-id", outputs.SiteDistributionId, "--paths", "/*", "--query", "Invalidation.Status", "--output", "text"], root);
}

console.log("\n== Done ==");
console.log(`API:            ${outputs.HttpApiUrl}`);
console.log(`Site (always):  https://${outputs.SiteDistributionDomain}`);
if (process.env.SITE_CERT_ARN) console.log("Site (custom):  https://synapse-op.us  and  https://www.synapse-op.us");
console.log(`User pool:      ${outputs.UserPoolId}   client: ${outputs.UserPoolClientId}`);
