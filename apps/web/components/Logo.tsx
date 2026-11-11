import * as React from "react";
import { cn } from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * The Kaname mark.
 *
 * Drawn in the FutureForge family: solid, forward-leaning slabs in the
 * brand purple, two-tone, no outline. Where the FutureForge mark is an
 * F made of two raked bars, Kaname's is a K made of three — a raked
 * stem and two arms that meet it at one point. That meeting point is
 * the name: 要 (kaname) is the pivot pin of a folding fan, the one
 * piece everything else turns on.
 *
 * Three filled polygons only, because the mark has to survive 16px in
 * the sidebar and 16px as a favicon. app/icon.svg and app/apple-icon.svg
 * repeat this geometry with literal colours.
 * ------------------------------------------------------------------ */

export interface LogoProps extends Omit<React.SVGProps<SVGSVGElement>, "children"> {
  size?: number;
  /** Hidden from assistive tech when a sibling already names the product. */
  title?: string;
  /** One flat colour (currentColor) instead of the two-tone purple. */
  mono?: boolean;
}

export const Logo = React.forwardRef<SVGSVGElement, LogoProps>(function Logo(
  { size = 20, title, mono = false, className, ...props },
  ref,
) {
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0", className)}
      {...props}
    >
      {title && <title>{title}</title>}
      {/* stem */}
      <path d="M6.2 3h4.6L7.8 21H3.2z" fill={mono ? "currentColor" : "var(--kn-accent-500)"} />
      {/* upper arm */}
      <path
        d="M16.1 3h5.3l-7.5 9.2h-4.6z"
        fill={mono ? "currentColor" : "var(--kn-accent-400)"}
      />
      {/* lower arm */}
      <path
        d="M9.9 13.4h4.7L19.2 21h-5.1z"
        fill={mono ? "currentColor" : "var(--kn-accent-500)"}
      />
    </svg>
  );
});

export interface WordmarkProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: number;
  /** Hides the word, leaving the mark — the collapsed sidebar state. */
  markOnly?: boolean;
}

export const Wordmark = React.forwardRef<HTMLSpanElement, WordmarkProps>(function Wordmark(
  { size = 20, markOnly = false, className, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn("inline-flex select-none items-center gap-2.5", className)}
      {...props}
    >
      <Logo size={size} />
      {!markOnly && (
        <span
          className="font-medium leading-none tracking-[-0.03em] text-[var(--kn-text)]"
          style={{ fontSize: Math.round(size * 0.82) }}
        >
          Kaname
        </span>
      )}
      <span className="sr-only">{markOnly ? "Kaname" : ""}</span>
    </span>
  );
});
