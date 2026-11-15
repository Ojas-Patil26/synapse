// One place that talks to Gemini. Every call asks for structured JSON, validates and
// repairs the result in code, retries once on a bad result, then gives up with a 502.

import { GoogleGenAI, type Schema } from "@google/genai";
import { HttpError, describeError } from "../http";

export { Type } from "@google/genai";
export type { Schema } from "@google/genai";

/** Thrown by a validator when the model's JSON cannot be repaired into a valid result. */
export class InvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOutputError";
  }
}

export interface GenerateJsonOptions<T> {
  /** Short name used in logs, e.g. "extractConcepts". */
  name: string;
  system: string;
  prompt: string;
  schema: Schema;
  /** Validates and repairs the parsed JSON. Throw InvalidOutputError to trigger the retry. */
  validate: (raw: unknown) => T;
  /** Total time allowed across both attempts. Default 20 s (API Gateway cuts off at 30 s). */
  budgetMs?: number;
  /** Cap for a single attempt. Defaults to whatever is left of the budget. */
  attemptTimeoutMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
}

const DEFAULT_BUDGET_MS = 20_000;
/** Do not start a second attempt with less than this much time left. */
const MIN_ATTEMPT_MS = 4_000;

let client: GoogleGenAI | null = null;
/** Thinking is switched off for speed. If the model rejects that setting we stop sending it. */
let sendThinkingConfig = true;

export function modelName(): string {
  return process.env.GEMINI_MODEL ?? "gemini-flash-latest";
}

function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

function isThinkingConfigRejection(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  const message = err instanceof Error ? err.message : "";
  return status === 400 && /thinking/i.test(message);
}

async function callOnce<T>(opts: GenerateJsonOptions<T>, timeoutMs: number): Promise<T> {
  const request = (withThinkingConfig: boolean) =>
    getClient().models.generateContent({
      model: modelName(),
      contents: opts.prompt,
      config: {
        systemInstruction: opts.system,
        responseMimeType: "application/json",
        responseSchema: opts.schema,
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxOutputTokens ?? 8192,
        ...(withThinkingConfig ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        abortSignal: AbortSignal.timeout(timeoutMs),
        // The SDK would otherwise retry up to 5 times on its own and blow the time budget.
        httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } },
      },
    });

  let response;
  try {
    response = await request(sendThinkingConfig);
  } catch (err) {
    if (!sendThinkingConfig || !isThinkingConfigRejection(err)) throw err;
    sendThinkingConfig = false;
    response = await request(false);
  }

  const text = response.text;
  if (!text || text.trim().length === 0) {
    throw new InvalidOutputError("empty response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    throw new InvalidOutputError("response is not valid JSON");
  }
  return opts.validate(parsed);
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

/**
 * Runs one structured-JSON generation with one retry. Throws HttpError(502) when both
 * attempts fail or the time budget runs out. The 502 message never contains upstream text.
 */
export async function generateJson<T>(opts: GenerateJsonOptions<T>): Promise<T> {
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS && attempt > 1) break;
    const startedAt = Date.now();
    try {
      const timeoutMs = Math.min(Math.max(remaining, 1_000), opts.attemptTimeoutMs ?? Number.MAX_SAFE_INTEGER);
      const result = await callOnce(opts, timeoutMs);
      console.log(`[gemini] ${opts.name} ok attempt=${attempt} ms=${Date.now() - startedAt}`);
      return result;
    } catch (err) {
      lastError = err;
      console.warn(
        `[gemini] ${opts.name} failed attempt=${attempt} ms=${Date.now() - startedAt}: ${describeError(err)}`,
      );
    }
  }

  const reason = lastError instanceof InvalidOutputError ? "returned an unusable answer" : "did not respond in time";
  throw new HttpError(502, "gemini_failed", `The AI service ${reason}. Please try again.`);
}

// ---------- small validation helpers shared by the prompt modules ----------

export function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidOutputError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new InvalidOutputError(`${what} is not an array`);
  return value;
}

/** Trimmed string, or "" when the value is not a string. */
export function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Fisher-Yates shuffle, returns a new array. `random` is injectable for tests. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
