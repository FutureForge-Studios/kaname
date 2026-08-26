"use client";

import * as React from "react";
import { cn, variant } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Avatar.
 *
 * Square-cornered, not circular: the only pill in the product is a
 * status badge. The fallback tone is hashed from the name so the same
 * person is the same colour on every page, and it is drawn from the
 * chart ramp rather than the semantic triad — an operator must never
 * read "red avatar" as "critical".
 * ------------------------------------------------------------------ */

export type AvatarSize = "xs" | "sm" | "md" | "lg";

const SIZES: Record<AvatarSize, string> = {
  xs: "h-4 w-4 text-2xs rounded-[var(--kn-r-xs)]",
  sm: "h-5 w-5 text-2xs rounded-[var(--kn-r-sm)]",
  md: "h-6 w-6 text-xs rounded-[var(--kn-r-sm)]",
  lg: "h-8 w-8 text-sm rounded-[var(--kn-r-md)]",
};

const TONES = [
  "var(--kn-chart-1)",
  "var(--kn-chart-2)",
  "var(--kn-chart-3)",
  "var(--kn-chart-4)",
  "var(--kn-chart-5)",
  "var(--kn-chart-6)",
] as const;

/** FNV-1a: stable across processes, unlike anything derived from Math.random. */
function toneFor(name: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return TONES[Math.abs(hash) % TONES.length] ?? TONES[0];
}

export function initialsOf(name: string): string {
  const source = name.includes("@") ? name.slice(0, name.indexOf("@")) : name;
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const first = parts[0] ?? "";
  if (!first) return "?";
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  if (!last) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

export interface AvatarProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Display name or email. Drives the initials, the tone and the label. */
  name: string;
  src?: string | null;
  size?: AvatarSize;
}

export const Avatar = React.forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { name, src, size = "md", className, ...props },
  ref,
) {
  const [failed, setFailed] = React.useState(false);
  const tone = toneFor(name);
  const showImage = Boolean(src) && !failed;

  return (
    <span
      ref={ref}
      role="img"
      aria-label={name}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center overflow-hidden border font-medium text-[var(--kn-text)]",
        variant(SIZES, size, "md"),
        className,
      )}
      style={
        showImage
          ? undefined
          : {
              background: `color-mix(in oklab, ${tone} 22%, var(--kn-surface-2))`,
              borderColor: `color-mix(in oklab, ${tone} 38%, transparent)`,
            }
      }
      {...props}
    >
      {showImage ? (
        <img
          src={src ?? undefined}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
});
