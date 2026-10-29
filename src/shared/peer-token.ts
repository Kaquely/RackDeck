/**
 * Peer token format, shared by the server and the dashboard.
 *
 * A token is 32 random bytes encoded as base64url with an `hlp_` prefix. The format is
 * deliberately fixed-length: validation is a cheap shape check, and the server compares
 * hashes rather than the strings so a wrong token cannot leak its length through timing.
 *
 * This module has no Node imports so the browser bundle can use the same validator and
 * generator as the server and the two cannot drift.
 */

export const PEER_TOKEN_PATTERN = /^hlp_[A-Za-z0-9_-]{43}$/;

const TOKEN_BYTES = 32;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** True when `value` has the exact peer-token shape. Accepts `unknown` for form input. */
export function isPeerToken(value: unknown): value is string {
  return typeof value === "string" && PEER_TOKEN_PATTERN.test(value);
}

/**
 * Encode bytes as base64url without padding.
 *
 * Implemented locally instead of with `Buffer` or `btoa(String.fromCharCode(...))` so it works
 * identically in the browser and in Node, and does not risk a stack overflow from spreading a
 * large array into a function call.
 */
function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const remaining = bytes.length - index;

    output += BASE64URL_ALPHABET[first >> 2] ?? "";
    output += BASE64URL_ALPHABET[((first & 0x03) << 4) | (second >> 4)] ?? "";
    if (remaining > 1) {
      output += BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] ?? "";
    }
    if (remaining > 2) {
      output += BASE64URL_ALPHABET[third & 0x3f] ?? "";
    }
  }

  return output;
}

/**
 * Generate a fresh peer token.
 *
 * Uses the platform CSPRNG (`crypto.getRandomValues`), which is available in both a modern
 * browser and Node. Called only while the add-peer dialog is open; the result is never
 * persisted in browser storage.
 */
export function generatePeerToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return `hlp_${encodeBase64Url(bytes)}`;
}
