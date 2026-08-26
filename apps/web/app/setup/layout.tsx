import type { ReactNode } from "react";
import type { Metadata } from "next";

/*
 * Setup renders outside the panel shell. There is no sidebar, no
 * command palette and no server picker, because at this point in an
 * operator's life none of those have anything in them — and a wizard
 * framed by empty chrome reads as a broken product rather than a new
 * one.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Set up Kaname",
};

export default function SetupLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-[var(--kn-bg)]">{children}</div>;
}
