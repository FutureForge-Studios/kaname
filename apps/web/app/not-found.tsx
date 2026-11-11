"use client";

import { useRouter } from "next/navigation";
import { Button, GridBackdrop, Kbd, PageHero, StatusLine } from "@kaname/ui";
import { Wordmark } from "@/components/Logo";

/*
 * The root 404: an address outside every route the app has, so there is
 * no shell to render inside. It is one of the standalone screens, and it
 * uses their anatomy — the blueprint canvas with frame rails, and the
 * hero (eyebrow, tight headline with the gradient second line, lede,
 * pills). A missing resource *inside* the panel is handled by
 * (panel)/not-found.tsx, which keeps the sidebar and the palette.
 */
export default function RootNotFound() {
  const router = useRouter();

  return (
    <GridBackdrop rails fade className="flex min-h-dvh flex-col px-6 sm:px-16">
      <header className="flex h-[var(--kn-topbar-h)] shrink-0 items-center">
        <Wordmark size={22} />
      </header>
      <main className="flex flex-1 items-center py-16">
        <PageHero
          eyebrow="404"
          title="Nothing at"
          accent="this address."
          lede="The page may have moved, or the link was mistyped. Everything you can reach is one search away."
          actions={
            <>
              <Button variant="primary" size="lg" arrow onClick={() => router.push("/")}>
                Go to the Command Center
              </Button>
              <Button size="lg" onClick={() => router.back()}>
                Go back
              </Button>
            </>
          }
          status={
            <StatusLine tone="neutral">
              <span className="inline-flex items-center gap-1.5">
                <Kbd keys="mod+k" size="xs" /> searches every resource once you are in the panel
              </span>
            </StatusLine>
          }
        />
      </main>
    </GridBackdrop>
  );
}
