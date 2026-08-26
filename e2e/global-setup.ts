import { boot } from "./support/stack.js";

/* Boots the database, the control plane, the simulated fleet and the
 * panel. Anything that fails here takes its child processes down with
 * it, so a broken run never leaves a port held. */
export default async function globalSetup(): Promise<void> {
  const started = Date.now();
  await boot();
  console.log(`stack ready in ${Math.round((Date.now() - started) / 1000)}s`);
}
