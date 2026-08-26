import { shutdown } from "./support/stack.js";

/* Reads the pids global setup recorded and takes each tree down. It
 * works from a fresh process, so it also cleans up after a runner that
 * was interrupted before it could tear anything down. */
export default function globalTeardown(): void {
  shutdown();
}
