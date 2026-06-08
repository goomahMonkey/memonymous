// Hashing helpers. Author-identity hashing has been removed; what remains is
// content hashing (dedupe / integrity) and small random id generation.

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Random hex token, default 16 bytes (128-bit). Used for memoir ids. */
export function randomHex(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a.buffer);
}

/** SHA-256 hex of an arbitrary string. Used for content dedupe + IP hashing. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return toHex(digest);
}
