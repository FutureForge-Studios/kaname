import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUDIT_GENESIS,
  auditHash,
  canonicalize,
  constantTimeEquals,
  generateToken,
  hashToken,
  hmac,
  open,
  redact,
  seal,
} from "./crypto.js";

const KEY = randomBytes(32);

describe("envelope encryption", () => {
  it("round-trips a secret", () => {
    const sealed = seal("s3cret-connection-string", KEY);
    expect(sealed.ciphertext).not.toContain("s3cret");
    expect(open(sealed, KEY)).toBe("s3cret-connection-string");
  });

  it("gives every secret its own data key", () => {
    const a = seal("same value", KEY);
    const b = seal("same value", KEY);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("refuses to open with the wrong master key", () => {
    const sealed = seal("secret", KEY);
    expect(() => open(sealed, randomBytes(32))).toThrow();
  });

  it("detects a tampered ciphertext", () => {
    const sealed = seal("secret", KEY);
    const raw = Buffer.from(sealed.ciphertext, "base64");
    raw[0] = (raw[0] ?? 0) ^ 0xff;
    expect(() => open({ ...sealed, ciphertext: raw.toString("base64") }, KEY)).toThrow();
  });

  it("handles unicode and empty values", () => {
    for (const value of ["", "要 — keystone", "🔐"]) {
      expect(open(seal(value, KEY), KEY)).toBe(value);
    }
  });
});

describe("tokens", () => {
  it("prefixes and keeps enough entropy", () => {
    const token = generateToken("kn_enroll");
    expect(token.startsWith("kn_enroll_")).toBe(true);
    expect(token.length).toBeGreaterThan(40);
    expect(generateToken()).not.toBe(generateToken());
  });

  it("compares in constant time without throwing on length mismatch", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });

  it("hashes deterministically", () => {
    expect(hashToken("x")).toBe(hashToken("x"));
    expect(hashToken("x")).not.toBe(hashToken("y"));
  });

  it("separates hmac fields so they cannot be shifted between them", () => {
    // Without a separator, ("ab","c") and ("a","bc") would collide.
    expect(hmac(KEY, "ab", "c")).not.toBe(hmac(KEY, "a", "bc"));
  });
});

describe("canonicalisation", () => {
  it("is stable across key order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("distinguishes values that merely look similar", () => {
    expect(canonicalize({ a: "1" })).not.toBe(canonicalize({ a: 1 }));
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("drops undefined but keeps null", () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("recurses into nested structures", () => {
    expect(canonicalize({ z: { b: 1, a: [{ d: 4, c: 3 }] } })).toBe(
      '{"z":{"a":[{"c":3,"d":4}],"b":1}}',
    );
  });
});

describe("audit hashing", () => {
  it("changes when any field changes", () => {
    const base = { action: "service.restart", target: "nginx" };
    const first = auditHash(AUDIT_GENESIS, base);
    expect(auditHash(AUDIT_GENESIS, base)).toBe(first);
    expect(auditHash(AUDIT_GENESIS, { ...base, target: "apache" })).not.toBe(first);
  });

  it("changes when the previous hash changes, which is what chains it", () => {
    const payload = { action: "a" };
    expect(auditHash(AUDIT_GENESIS, payload)).not.toBe(auditHash("f".repeat(64), payload));
  });
});

describe("redaction", () => {
  it("redacts anything that names a secret", () => {
    const out = redact({
      password: "p",
      api_key: "k",
      access_token: "t",
      dkim_private: "d",
      Authorization: "Bearer x",
      username: "keep",
    });
    expect(out).toEqual({
      password: "[redacted]",
      api_key: "[redacted]",
      access_token: "[redacted]",
      dkim_private: "[redacted]",
      Authorization: "[redacted]",
      username: "keep",
    });
  });

  it("recurses through nested objects and arrays", () => {
    const out = redact({ users: [{ name: "a", password: "p" }], nested: { secret: "s" } }) as {
      users: { name: string; password: string }[];
      nested: { secret: string };
    };
    expect(out.users[0]!.password).toBe("[redacted]");
    expect(out.users[0]!.name).toBe("a");
    expect(out.nested.secret).toBe("[redacted]");
  });

  it("leaves primitives and null alone", () => {
    expect(redact("plain")).toBe("plain");
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
  });
});
