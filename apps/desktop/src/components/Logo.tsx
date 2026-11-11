/** The Kaname mark: a folding fan's pivot, three filled polygons. Kept abstract and small. */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="logo">
      <path d="M12 21 3 8.5A12 12 0 0 1 9.4 4.3Z" fill="currentColor" opacity="0.55" />
      <path d="M12 21 9.9 4.1a12 12 0 0 1 4.2 0Z" fill="currentColor" />
      <path d="M12 21 14.6 4.3A12 12 0 0 1 21 8.5Z" fill="currentColor" opacity="0.55" />
      <circle cx="12" cy="20" r="1.6" fill="var(--kn-accent-500)" />
    </svg>
  );
}
