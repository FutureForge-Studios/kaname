import { describe, expect, it } from "vitest";
import { base64ToBytes, base64ToText, bytesToBase64, textToBase64 } from "./base64";

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes, including 0x00 and 0xff", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("encodes terminal input as UTF-8", () => {
    expect(textToBase64("ls\r")).toBe("bHMN");
    expect(base64ToText(textToBase64("héllo ✓ 日本"))).toBe("héllo ✓ 日本");
  });

  it("matches the standard alphabet", () => {
    expect(bytesToBase64(new TextEncoder().encode("Man"))).toBe("TWFu");
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe("+/8=");
  });

  it("handles payloads larger than the chunk size", () => {
    const big = new Uint8Array(100_000).map((_, i) => (i * 31) & 0xff);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });

  it("decodes ANSI escape output byte-exact", () => {
    const b64 = textToBase64("\x1b[32mok\x1b[0m\r\n");
    expect(Array.from(base64ToBytes(b64)).slice(0, 2)).toEqual([0x1b, 0x5b]);
  });
});
