"use client";

import * as React from "react";
import { Eyebrow, GradientText, GridBackdrop, MonoLabel, cn } from "@kaname/ui";
import { Wordmark } from "@/components/Logo";

/* ------------------------------------------------------------------ *
 * The standalone frame: setup, sign-in and invitations.
 *
 * These three screens sit outside the panel shell, and they are the
 * first thing an owner or a teammate ever sees of the product, so they
 * wear the ffstudios.io homepage: the blueprint canvas with its rails
 * and crosshairs, one restrained glow, a hairline header holding only
 * the wordmark, and a hero on the left with the thing to do on the
 * right. On a phone the two stack — hero, then the card.
 * ------------------------------------------------------------------ */

export function StandaloneFrame({
  caption,
  children,
}: {
  /** Mono label at the right of the header: what this screen is for. */
  caption?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <GridBackdrop rails railInset={12} glow="right" fade className="flex min-h-dvh flex-col">
      <header className="kn-crosshairs shrink-0 border-b border-[var(--kn-border)]">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-4 px-6 sm:px-10 lg:px-16">
          <Wordmark size={22} />
          {caption && (
            <MonoLabel as="p" size="xs" className="m-0 min-w-0 truncate">
              {caption}
            </MonoLabel>
          )}
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-6 py-10 sm:px-10 lg:px-16 lg:py-16">
        {children}
      </main>
    </GridBackdrop>
  );
}

/**
 * Hero left, card right. `center` is for the short screens (sign-in,
 * invite), which sit in the middle of the viewport; the wizard starts
 * at the top so a headline does not move when a step's card grows.
 */
export function HeroSplit({
  hero,
  center = false,
  children,
}: {
  hero: React.ReactNode;
  center?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 flex-1 gap-8 lg:gap-16",
        center
          ? "content-center items-center lg:grid-cols-[minmax(0,1fr)_26rem]"
          : "content-start items-start lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]",
      )}
    >
      <div className={cn("flex min-w-0 flex-col gap-8", !center && "lg:sticky lg:top-12")}>{hero}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * Eyebrow, the big tight headline with its gradient second line, and a
 * lede. `as` is `h1` when the headline is the page's heading (a setup
 * step) and `p` when the heading lives in the card (sign-in, invite).
 */
export function Hero({
  as: Heading = "h1",
  eyebrow,
  title,
  accent,
  lede,
  children,
}: {
  as?: "h1" | "p";
  /** A string becomes the chip; a node is rendered as given. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  accent?: React.ReactNode;
  lede?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-start">
      {eyebrow != null && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {typeof eyebrow === "string" ? <Eyebrow>{eyebrow}</Eyebrow> : eyebrow}
        </div>
      )}
      <Heading className="kn-headline m-0 max-w-full break-words text-4xl text-[var(--kn-text)] xl:text-5xl">
        {title}
        {accent && (
          <>
            {" "}
            <GradientText block>{accent}</GradientText>
          </>
        )}
      </Heading>
      {lede && <p className="kn-lede m-0 mt-5 max-w-xl">{lede}</p>}
      {children}
    </div>
  );
}
