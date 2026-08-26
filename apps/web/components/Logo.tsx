import * as React from "react";
import { cn } from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * The Kaname mark.
 *
 * A keystone — the tapered wedge at the crown of an arch that holds
 * every other stone in place — drawn as one closed path with the
 * central point marked. Two elements only, because the mark has to
 * survive 16px in the sidebar and 16px as a favicon.
 *
 * Abstract on purpose: the name is Japanese, the symbol is structural.
 * There is no glyph, no torii, no seal.
 * ------------------------------------------------------------------ */

export interface LogoProps extends Omit<React.SVGProps<SVGSVGElement>, "children"> {
  size?: number;
  /** Hidden from assistive tech when a sibling already names the product. */
  title?: string;
}

export const Logo = React.forwardRef<SVGSVGElement, LogoProps>(function Logo(
  { size = 20, title, className, ...props },
  ref,
) {
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinejoin="round"
      strokeLinecap="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0", className)}
      {...props}
    >
      {title && <title>{title}</title>}
      <path d="M5.6 5h12.8l-2.6 14H8.2z" />
      <circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none" />
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
      className={cn("inline-flex select-none items-center gap-2", className)}
      {...props}
    >
      <Logo size={size} className="text-[var(--kn-accent-400)]" />
      {!markOnly && (
        <span className="text-md font-medium tracking-tight text-[var(--kn-text)]">Kaname</span>
      )}
      <span className="sr-only">{markOnly ? "Kaname" : ""}</span>
    </span>
  );
});
