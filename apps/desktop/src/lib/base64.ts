/* Base64 <-> bytes without Node's Buffer: the webview has none. */

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Terminal input (a JS string from xterm's onData) → base64 of its UTF-8 bytes. */
export function textToBase64(text: string): string {
  return bytesToBase64(encoder.encode(text));
}

export function base64ToText(b64: string): string {
  return decoder.decode(base64ToBytes(b64));
}
