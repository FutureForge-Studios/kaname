import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** The one class-composition helper. Every component uses it. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Tiny variant resolver. We deliberately avoid class-variance-authority:
 * the whole kit needs exactly this, and a dependency that ships its own
 * type gymnastics is not worth 20 lines.
 */
export type VariantMap<K extends string> = Record<K, string>;

export function variant<K extends string>(
  map: VariantMap<K>,
  key: K | undefined,
  fallback: K,
): string {
  return map[key ?? fallback] ?? map[fallback];
}
