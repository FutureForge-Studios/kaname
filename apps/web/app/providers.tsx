"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ToastProvider } from "@kaname/ui";
import { isApiError } from "@/lib/api";
import { connectEventStream, type EventStreamStatus, type StreamMessage } from "@/lib/events";
import {
  JobDrawerProvider,
  LIST_STALE_TIME,
  SessionProvider,
  eventTouchesDashboard,
  familiesForEvent,
  invalidateFamilies,
  queryKeys,
  useJobDrawer,
  useSession,
} from "@/lib/queries";
import { CommandPaletteProvider } from "@/components/CommandPalette";

/* ------------------------------------------------------------------ *
 * Client providers.
 *
 * Composition order matters: toasts sit above everything so a failure
 * can be reported from any layer, the session is resolved before the
 * job drawer and the palette because both filter on permissions, and
 * the event bridge runs innermost because it needs all three.
 * ------------------------------------------------------------------ */

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /*
         * Fleet lists are joined, counted and enriched on the control
         * plane, so refetching them because a window regained focus is
         * pure cost. Freshness arrives over SSE instead, which is both
         * cheaper and more truthful than a focus heuristic.
         */
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        staleTime: LIST_STALE_TIME,
        gcTime: 5 * 60_000,
        /* A 403 does not become a 200 on the third attempt. */
        retry: (failureCount, error) => {
          if (isApiError(error)) return error.retryable && failureCount < 2;
          return failureCount < 1;
        },
        retryDelay: (attempt) => Math.min(4000, 500 * 2 ** attempt),
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  // One client per browser session; creating it during render would
  // share cache between requests when this tree is rendered on the server.
  const [client] = React.useState(makeQueryClient);

  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <SessionProvider>
          <JobDrawerProvider>
            <CommandPaletteProvider>
              <EventBridge />
              {children}
            </CommandPaletteProvider>
          </JobDrawerProvider>
        </SessionProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

/* ------------------------------------------------------------------ *
 * SSE bridge.
 *
 * The whole app stays live off one connection. Events name a topic, not
 * a query key, so the translation happens here once: a `job.succeeded`
 * carrying `service.restart` refreshes the services list, the servers
 * list and the Command Center without any of those pages knowing the
 * stream exists.
 * ------------------------------------------------------------------ */

/** Bursts are common — a fan-out job emits one event per host. */
const FLUSH_MS = 250;

function EventBridge() {
  const client = useQueryClient();
  const drawer = useJobDrawer();
  const { session } = useSession();

  const drawerRef = React.useRef(drawer);
  drawerRef.current = drawer;

  const signedIn = Boolean(session?.user ?? session?.api_key);

  React.useEffect(() => {
    if (!signedIn) return;

    const pending = new Set<string>();
    let dashboardDirty = false;
    let timer = 0;

    const flush = () => {
      timer = 0;
      if (pending.size > 0) {
        invalidateFamilies(client, pending);
        pending.clear();
      }
      if (dashboardDirty) {
        dashboardDirty = false;
        void client.invalidateQueries({ queryKey: queryKeys.dashboard() });
      }
    };

    const onMessage = (message: StreamMessage) => {
      if (message.topic === "jobs") {
        drawerRef.current.note(message);
        // A log line or a progress tick changes nothing any list shows.
        // Refetching /jobs and /dashboard for each of them — several
        // times a second during a backup — was the panel's own worst
        // load on the control plane.
        if (message.type === "job.log" || message.type === "job.progress") return;
      }

      for (const family of familiesForEvent(message)) pending.add(family);
      if (eventTouchesDashboard(message)) dashboardDirty = true;

      if (timer === 0) timer = window.setTimeout(flush, FLUSH_MS);
    };

    // A stream that dropped and came back missed every event in between
    // — typically because the control plane was replaced. Nothing that
    // was published then will be replayed, so everything is refetched.
    let previous: EventStreamStatus = "connecting";
    const onStatusChange = (status: EventStreamStatus) => {
      if (previous === "reconnecting" && status === "open") void client.invalidateQueries();
      previous = status;
    };

    const disconnect = connectEventStream({ onMessage, onStatusChange });

    return () => {
      disconnect();
      if (timer !== 0) window.clearTimeout(timer);
    };
  }, [client, signedIn]);

  return null;
}
