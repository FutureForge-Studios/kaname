import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import "./globals.css";

/* ------------------------------------------------------------------ *
 * Root layout.
 *
 * Dark is the default and the design target; light ships with the same
 * token names inverted. The choice is applied before first paint by the
 * inline script below — a theme resolved in an effect would flash the
 * wrong palette on every navigation, which on a near-black panel is a
 * white strobe.
 * ------------------------------------------------------------------ */

export const metadata: Metadata = {
  title: {
    default: "Kaname",
    template: "%s · Kaname",
  },
  description: "The control plane for your infrastructure.",
  applicationName: "Kaname",
  /* This panel is reachable only with a session; nothing here belongs in an index. */
  robots: { index: false, follow: false },
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0c0e" },
    { media: "(prefers-color-scheme: light)", color: "#fbfbfc" },
  ],
  colorScheme: "dark light",
};

/** Mirrors applyTheme() in components/Topbar.tsx. */
const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem("kaname.theme");var t=s==="light"||s==="dark"?s:(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.setAttribute("data-theme",t)}catch(e){document.documentElement.setAttribute("data-theme","dark")}})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
