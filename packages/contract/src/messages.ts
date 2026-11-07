import { z, ZodIssueCode, type ZodErrorMap } from "zod";

/* ------------------------------------------------------------------ *
 * Validation messages people can read.
 *
 * Every schema here is validated at the control plane's edge, and the
 * issue messages travel back to the panel as the per-field errors under
 * each input. Zod's defaults are written for developers — "Invalid
 * email", "String must contain at least 1 character(s)", "Array must
 * contain at least 1 element(s)" — so that is what an operator used to
 * read under a form field. This map replaces them with plain English.
 *
 * It only fills in messages a schema did not set itself: an explicit
 * `.regex(re, "must be a lowercase kebab-case slug")` still wins, so a
 * rule that has something specific to say keeps saying it.
 * ------------------------------------------------------------------ */

const plural = (n: number | bigint, one: string, many = `${one}s`) =>
  `${n} ${Number(n) === 1 ? one : many}`;

const STRING_FORMATS: Record<string, string> = {
  email: "Enter a valid email address.",
  url: "Enter a full URL, including https://.",
  uuid: "This is not a valid ID.",
  cuid: "This is not a valid ID.",
  cuid2: "This is not a valid ID.",
  ulid: "This is not a valid ID.",
  nanoid: "This is not a valid ID.",
  datetime: "Enter a date and time, like 2026-01-31T09:30:00Z.",
  date: "Enter a date, like 2026-01-31.",
  time: "Enter a time, like 09:30.",
  duration: "Enter a duration, like PT15M.",
  ip: "Enter a valid IP address.",
  cidr: "Enter a network range, like 10.0.0.0/24.",
  emoji: "Use emoji only.",
  base64: "This is not valid base64.",
  base64url: "This is not valid base64url.",
  jwt: "This is not a valid token.",
  regex: "This is not in the expected format.",
};

const TYPE_NAMES: Record<string, string> = {
  string: "text",
  number: "a number",
  integer: "a whole number",
  bigint: "a whole number",
  boolean: "true or false",
  array: "a list",
  object: "an object",
  date: "a date",
};

export const plainErrorMap: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type: {
      if (issue.received === "undefined" || issue.received === "null") {
        return { message: "This field is required." };
      }
      if (issue.expected === "number" && issue.received === "nan") {
        return { message: "Enter a number." };
      }
      const expected = TYPE_NAMES[issue.expected];
      return { message: expected ? `Must be ${expected}.` : "This value has the wrong type." };
    }

    case ZodIssueCode.invalid_string: {
      const validation = issue.validation;
      if (typeof validation === "object") {
        if ("startsWith" in validation) return { message: `Must start with "${validation.startsWith}".` };
        if ("endsWith" in validation) return { message: `Must end with "${validation.endsWith}".` };
        if ("includes" in validation) return { message: `Must include "${validation.includes}".` };
        return { message: "This is not in the expected format." };
      }
      return { message: STRING_FORMATS[validation] ?? "This is not in the expected format." };
    }

    case ZodIssueCode.too_small: {
      const n = issue.minimum;
      switch (issue.type) {
        case "string":
          // min(1) is how a schema says "required" for text.
          if (Number(n) === 1 && !issue.exact) return { message: "This field is required." };
          if (issue.exact) return { message: `Must be exactly ${plural(n, "character")}.` };
          return { message: `Must be at least ${plural(n, "character")}.` };
        case "array":
        case "set":
          if (issue.exact) return { message: `Choose exactly ${n}.` };
          return { message: Number(n) === 1 ? "Choose at least one." : `Choose at least ${n}.` };
        case "date":
          return { message: `Must be on or after ${new Date(Number(n)).toISOString()}.` };
        default:
          if (issue.exact) return { message: `Must be exactly ${n}.` };
          return { message: issue.inclusive ? `Must be at least ${n}.` : `Must be more than ${n}.` };
      }
    }

    case ZodIssueCode.too_big: {
      const n = issue.maximum;
      switch (issue.type) {
        case "string":
          if (issue.exact) return { message: `Must be exactly ${plural(n, "character")}.` };
          return { message: `Must be ${plural(n, "character")} or fewer.` };
        case "array":
        case "set":
          if (issue.exact) return { message: `Choose exactly ${n}.` };
          return { message: `Choose no more than ${n}.` };
        case "date":
          return { message: `Must be on or before ${new Date(Number(n)).toISOString()}.` };
        default:
          if (issue.exact) return { message: `Must be exactly ${n}.` };
          return { message: issue.inclusive ? `Must be at most ${n}.` : `Must be less than ${n}.` };
      }
    }

    case ZodIssueCode.invalid_enum_value:
      return { message: `Choose one of: ${issue.options.map(String).join(", ")}.` };

    case ZodIssueCode.invalid_literal:
      return { message: `Must be ${JSON.stringify(issue.expected)}.` };

    case ZodIssueCode.unrecognized_keys:
      return {
        message: `Not a field this form accepts: ${issue.keys.join(", ")}.`,
      };

    case ZodIssueCode.invalid_union:
    case ZodIssueCode.invalid_union_discriminator:
      return { message: "This value is not one of the accepted choices." };

    case ZodIssueCode.invalid_date:
      return { message: "Enter a valid date." };

    case ZodIssueCode.not_multiple_of:
      return { message: `Must be a multiple of ${issue.multipleOf}.` };

    case ZodIssueCode.not_finite:
      return { message: "Must be a finite number." };

    case ZodIssueCode.custom:
      // A refine with no message of its own gets "Invalid input" by default.
      return { message: issue.message ?? "This value is not valid." };

    default:
      return { message: ctx.defaultError };
  }
};

/*
 * Installed on import. Zod keeps one global map per module instance and
 * the workspace hoists a single zod, so the control plane's own inline
 * schemas get the same messages as the contract's.
 */
z.setErrorMap(plainErrorMap);
