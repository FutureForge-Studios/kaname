import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createApiKeyInput,
  createUserInput,
  loginInput,
  updateSettingsInput,
  uuid,
} from "./index.js";

/* ------------------------------------------------------------------ *
 * The installed error map. Importing the contract is what installs it,
 * so these parse real contract schemas and read the messages a person
 * would see under a field.
 * ------------------------------------------------------------------ */

function messages(schema: z.ZodTypeAny, value: unknown): Record<string, string> {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  const out: Record<string, string> = {};
  if (!result.success) {
    for (const issue of result.error.issues) out[issue.path.join(".")] = issue.message;
  }
  return out;
}

describe("plain-English validation messages", () => {
  it("the sign-in form: an empty password is required, a bad address is named", () => {
    expect(messages(loginInput, { email: "not-an-address", password: "" })).toEqual({
      email: "Enter a valid email address.",
      password: "This field is required.",
    });
    expect(messages(loginInput, {})).toMatchObject({
      email: "This field is required.",
      password: "This field is required.",
    });
  });

  it("the invite form: no roles, too long a name", () => {
    expect(
      messages(createUserInput, { email: "ines@localhost", name: "x".repeat(97), role_ids: [] }),
    ).toEqual({
      email: "Enter a valid email address.",
      name: "Must be 96 characters or fewer.",
      role_ids: "Choose at least one.",
    });
  });

  it("settings: numbers, enums and blanks", () => {
    expect(
      messages(updateSettingsInput, {
        panel: { name: "", date_format: "julian" },
        security: { session_ttl_hours: 0 },
      }),
    ).toEqual({
      "panel.name": "This field is required.",
      "panel.date_format": "Choose one of: iso, us, eu, relative.",
      "security.session_ttl_hours": "Must be at least 1.",
    });
  });

  it("never leaks a library default", () => {
    const raw = [
      ...Object.values(messages(createApiKeyInput, { name: "", scopes: [] })),
      ...Object.values(messages(uuid, "nope")),
      ...Object.values(messages(z.object({ n: z.number() }), { n: "seven" })),
      ...Object.values(messages(z.string().min(12), "short")),
    ];
    expect(raw).toEqual([
      "This field is required.",
      "Choose at least one.",
      "This is not a valid ID.",
      "Must be a number.",
      "Must be at least 12 characters.",
    ]);
    for (const message of raw) {
      expect(message).not.toMatch(/Invalid|String must|Array must|Number must|Expected|Required/);
    }
  });

  it("leaves a schema's own message alone", () => {
    expect(messages(z.string().regex(/^a/, "must start with a"), "b")).toEqual({
      "": "must start with a",
    });
  });
});
