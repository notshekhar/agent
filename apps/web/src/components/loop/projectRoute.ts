/**
 * Project ids in URLs.
 *
 * A loop project id is a filesystem path, so it contains `/` and cannot ride
 * in a single route segment as-is. Percent-encoding is not enough on its own
 * either — the router decodes params before handing them over, and a path
 * containing `%2F` round-trips inconsistently across browsers and history
 * entries.
 *
 * base64url avoids the question entirely: the encoded id has no reserved
 * characters, so it survives the URL, the router and a page reload unchanged.
 */

function toBase64Url(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): string {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeProjectRouteId(projectId: string): string {
  return toBase64Url(projectId);
}

/** Returns null for a param that is not a project id this app produced. */
export function decodeProjectRouteId(param: string): string | null {
  try {
    const decoded = fromBase64Url(param);
    return decoded.trim() === "" ? null : decoded;
  } catch {
    return null;
  }
}
