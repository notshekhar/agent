/**
 * A failure, as a sentence.
 *
 * The transcript used to render these with `JSON.stringify`, which is wrong in
 * both directions at once: a thrown `Error` stringifies to `{}` (message, name
 * and stack are all non-enumerable), and an `AI_APICallError` stringifies to
 * kilobytes of request dump — the whole system prompt and every tool
 * definition — with the one line that matters ("invalid x-api-key") buried
 * inside `responseBody`. MEASURED on a real turn: a failed `write` showed `{}`
 * and a 401 showed a 29 KB blob.
 *
 * Ported from `packages/cli/src/interactive/format-error.ts` (pure, no node
 * dependencies). KEEP IN SYNC — the app and the terminal should name the same
 * failure the same way.
 */

/** Keep one-liners short: first line only, trimmed, capped. */
function firstLine(value: string): string {
  const line = (value.split("\n")[0] ?? value).trim();
  return line.length > 500 ? `${line.slice(0, 500)}…` : line;
}

/** Pull the human-readable message out of a provider's JSON error body. */
function providerMessage(body: unknown): string | undefined {
  if (!body) return undefined;
  let parsed: unknown = body;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return undefined;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return firstLine(trimmed); // plain-text body
    }
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return firstLine(message);
    }
    if (typeof error === "string" && error.trim()) return firstLine(error);
    if (typeof record.message === "string" && record.message.trim()) return firstLine(record.message);
  }
  return undefined;
}

/** Node/Bun syscall errno codes look like EPERM, ENOENT, ECONNREFUSED. */
function isErrno(value: unknown): value is string {
  return typeof value === "string" && /^E[A-Z]{2,}$/.test(value);
}

/**
 * Walk the error and its `.cause` chain for a diagnostic code worth showing.
 * The real syscall failure is routinely buried a level down — a flat `.code`
 * read reports a vague fetch message where an ECONNREFUSED was available.
 */
function errorCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 5) return undefined;
  const record = error as Record<string, unknown>;
  if (isErrno(record.code)) return record.code;
  const fromCause = errorCode(record.cause, depth + 1);
  if (fromCause) return fromCause;
  if (typeof record.code === "string" && record.code.trim() && record.code !== "ERR_UNHANDLED_ERROR") {
    return record.code;
  }
  const name = typeof record.name === "string" ? record.name : "";
  if (name && name !== "Error" && name !== "TypeError" && name !== "AI_APICallError") return name;
  return undefined;
}

/** Append a "(CODE)" tag when one is available and not already in the message. */
function withCode(message: string, error: unknown): string {
  const code = errorCode(error);
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

export function formatError(error: unknown): string {
  // RetryError wraps the underlying failure once retries are exhausted.
  if (error && typeof error === "object" && "lastError" in error && (error as { lastError?: unknown }).lastError) {
    return formatError((error as { lastError: unknown }).lastError);
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const isApiError =
      record.name === "AI_APICallError" ||
      "responseBody" in record ||
      "statusCode" in record ||
      "url" in record;
    if (isApiError) {
      const status = typeof record.statusCode === "number" ? record.statusCode : undefined;
      const real = providerMessage(record.data) ?? providerMessage(record.responseBody);
      if (real) return status ? `${real} (HTTP ${status})` : withCode(real, record);
      if (typeof record.message === "string" && record.message.trim()) {
        return withCode(firstLine(record.message), record);
      }
      if (status) return `request failed (HTTP ${status})`;
      return withCode("request failed", record);
    }
    // A plain Error that crossed the wire: the RPC server rewrites it into
    // `{name, message, …}` so the message is here rather than lost. An older
    // loop sends `{}`, which has nothing to read and falls through below.
    if (typeof record.message === "string" && record.message.trim()) {
      return withCode(firstLine(record.message), record);
    }
  }

  if (error instanceof Error) return withCode(firstLine(error.message), error);
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return "the call failed";
  try {
    const json = JSON.stringify(error);
    // `{}` is what an un-rewritten Error serialises to; printing it tells the
    // reader nothing except that something went wrong in a JSON-shaped way.
    return json === "{}" || json === undefined ? "the call failed" : json;
  } catch {
    return String(error);
  }
}
