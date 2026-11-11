"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * PillLink — a navigation link dressed as the kit's secondary `xs` pill
 * with the trailing arrow. The kit's Button renders a <button> only, and
 * "Open in Services" is navigation, so it stays a real link (middle
 * click, copy address) while reading like every other action.
 * ------------------------------------------------------------------ */

export function PillLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group/btn inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--kn-r-pill)] border border-[var(--kn-border-strong)] bg-transparent px-2.5 text-xs text-[var(--kn-text)]",
        "transition-[border-color,background-color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)] hover:border-[var(--kn-line-control)] hover:bg-[var(--kn-neutral-soft)]",
        "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
        className,
      )}
    >
      {children}
      <ArrowRight
        size={12}
        aria-hidden
        className="shrink-0 transition-transform duration-[var(--kn-dur)] ease-[var(--kn-ease)] group-hover/btn:translate-x-0.5 motion-reduce:transition-none"
      />
    </Link>
  );
}
