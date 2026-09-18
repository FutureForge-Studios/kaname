import { NextResponse, type NextRequest } from "next/server";
import type { SetupState } from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * Where a request lands before it renders anything.
 *
 * Onboarding is guarded on the control plane — every /setup endpoint
 * refuses once an account exists — and this is the second half of that:
 * it stops an un-onboarded instance from showing a login form nobody can
 * use, and stops an onboarded one from showing a wizard that would only
 * be refused. Hiding the route in the browser is not the control; the
 * API is. This is the routing.
 * ------------------------------------------------------------------ */

const CONTROL_PLANE = process.env.KANAME_CONTROL_PLANE_URL ?? "http://localhost:4000";

export const config = {
  // Only the three entry points can be wrong about this. Everything
  // else is behind the session and answers 401 on its own.
  matcher: ["/", "/login", "/setup"],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const state = await readSetupState(request);

  // The control plane not answering is not a routing decision. Let the
  // page render and report the failure properly, with the message and
  // the remediation the API gives it.
  if (!state) return NextResponse.next();

  const { pathname } = request.nextUrl;

  if (pathname === "/setup") {
    // Finished: the owner who reloads lands in the panel, not on a
    // sign-in form for a session they already hold.
    if (!state.needs_onboarding) return redirect(request, state.authorized ? "/" : "/login");
    // Once an account exists, only that account may finish setting the
    // instance up. An anonymous visitor gets the login form — never a
    // second pass at creating an owner — and is brought back here by it.
    if (state.has_owner && !state.authorized) return redirect(request, "/login", "/setup");
    return NextResponse.next();
  }

  if (!state.has_owner) return redirect(request, "/setup");
  // An owner whose wizard is unfinished — a lapsed session, a sign-in
  // from another machine — resumes it rather than landing on a panel
  // with no name, no confirmed server and completed_at never set.
  if (state.needs_onboarding && state.authorized) return redirect(request, "/setup");
  return NextResponse.next();
}

function redirect(request: NextRequest, pathname: string, next?: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  if (next) url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

async function readSetupState(request: NextRequest): Promise<SetupState | null> {
  try {
    const response = await fetch(`${CONTROL_PLANE}/api/v1/setup/state`, {
      headers: {
        accept: "application/json",
        // Forwarded so `authorized` reflects this visitor rather than
        // the middleware runtime.
        ...(request.headers.get("cookie") ? { cookie: request.headers.get("cookie")! } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    return ((await response.json()) as { data: SetupState }).data;
  } catch {
    return null;
  }
}
