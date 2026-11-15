// Error text can embed a connection string. Never log one.

const URL_WITH_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^\s"'@/]*@[^\s"']*/gi;
const ANY_DB_URL = /(mongodb(\+srv)?|postgres(ql)?):\/\/[^\s"']*/gi;

export function redact(text: string): string {
  return text.replace(URL_WITH_CREDENTIALS, "[redacted-url]").replace(ANY_DB_URL, "[redacted-url]");
}

export function safeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return redact(`${err.name}${code ? `(${String(code)})` : ""}: ${err.message}`);
  }
  return redact(String(err));
}
