export type Tab =
  | { id: string; kind: "fleet"; connectionId: string }
  | {
      id: string;
      kind: "terminal";
      connectionId: string;
      serverId: string;
      serverName: string;
      containerId?: string;
      containerName?: string;
    };

export const fleetTabId = (connectionId: string) => `fleet:${connectionId}`;

/** After closing tab `id`, which tab becomes active: the right neighbour, else the left. */
export function nextActiveAfterClose(tabs: Tab[], id: string, activeId: string | null): string | null {
  if (activeId !== id) return activeId;
  const index = tabs.findIndex((t) => t.id === id);
  const rest = tabs.filter((t) => t.id !== id);
  if (rest.length === 0) return null;
  return (rest[Math.min(index, rest.length - 1)] ?? rest[0]!).id;
}
