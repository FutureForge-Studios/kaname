import { bootFreshInstall } from "./support/wizard-stack.js";

/* A fresh, un-onboarded instance; see support/wizard-stack.ts. */
export default async function wizardSetup(): Promise<void> {
  const started = Date.now();
  await bootFreshInstall();
  console.log(`fresh install ready in ${Math.round((Date.now() - started) / 1000)}s`);
}
