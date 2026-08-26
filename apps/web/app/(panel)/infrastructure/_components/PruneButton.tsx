"use client";

import * as React from "react";
import { Eraser } from "lucide-react";
import type { Server } from "@kaname/contract";
import { Button, Checkbox, ConfirmDialog, type ButtonSize } from "@kaname/ui";
import { useCan } from "@/lib/queries";
import { useContainerPrune } from "../_lib/infra";

/* ------------------------------------------------------------------ *
 * Prune.
 *
 * Reclaiming space is the one container action with no undo and no
 * per-object confirmation, so the dialog states exactly what each
 * checkbox widens the blast radius to, and the host name has to be
 * typed before it runs.
 * ------------------------------------------------------------------ */

export interface PruneButtonProps {
  /** Null on a fleet-wide view: pruning is always scoped to one host. */
  server: Server | null;
  size?: ButtonSize;
}

export function PruneButton({ server, size = "sm" }: PruneButtonProps) {
  const can = useCan();
  const prune = useContainerPrune();
  const [open, setOpen] = React.useState(false);
  const [includeImages, setIncludeImages] = React.useState(false);
  const [includeVolumes, setIncludeVolumes] = React.useState(false);

  React.useEffect(() => {
    if (open) return;
    setIncludeImages(false);
    setIncludeVolumes(false);
  }, [open]);

  const allowed = server !== null && can("infra.containers:delete", server.id);
  const connected = server?.connection === "connected";

  return (
    <>
      <Button
        variant="secondary"
        size={size}
        icon={Eraser}
        disabled={!allowed || !connected}
        onClick={() => setOpen(true)}
      >
        Prune
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Prune containers on ${server?.name}?`}
        description="Every stopped container on the host is deleted. Running containers are untouched."
        confirmText={server?.name}
        confirmLabel="Prune"
        loading={prune.isPending}
        onConfirm={() => {
          if (server) {
            prune.mutate({
              serverId: server.id,
              serverName: server.name,
              includeImages,
              includeVolumes,
            });
          }
          setOpen(false);
        }}
      >
        <div className="flex flex-col gap-2">
          <Checkbox
            checked={includeImages}
            onChange={(event) => setIncludeImages(event.target.checked)}
            label="Also prune unused images"
            description="Any image no container references. Re-pulling them costs bandwidth, not data."
          />
          <Checkbox
            checked={includeVolumes}
            onChange={(event) => setIncludeVolumes(event.target.checked)}
            label="Also prune unused volumes"
            description="This deletes data. A volume no container currently references may still be the only copy of something."
          />
        </div>
      </ConfirmDialog>
    </>
  );
}
