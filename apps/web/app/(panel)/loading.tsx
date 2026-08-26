import { Skeleton } from "@kaname/ui";

/*
 * Matches the real page shape — header band, toolbar row, dense rows —
 * so the transition into loaded content does not reflow. A centred
 * spinner would be smaller to write and worse to look at forty times a
 * day.
 */
export default function PanelLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy>
      <div className="border-b border-[var(--kn-border)] px-6 py-4">
        <Skeleton className="h-6 w-52" label="Loading page" />
        <Skeleton className="mt-2 h-3 w-72" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
        <div className="overflow-hidden rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface)]">
          <div className="flex h-10 items-center gap-2 border-b border-[var(--kn-border)] px-2">
            <Skeleton className="h-7 w-48 rounded-[var(--kn-r-sm)]" />
            <Skeleton className="h-7 w-28 rounded-[var(--kn-r-sm)]" />
            <Skeleton className="ml-auto h-7 w-7 rounded-[var(--kn-r-sm)]" />
          </div>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
            <div
              key={row}
              className="flex h-[var(--kn-row-h)] items-center gap-3 border-b border-[var(--kn-border-subtle)] px-3 last:border-b-0"
            >
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="ml-auto h-3 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
