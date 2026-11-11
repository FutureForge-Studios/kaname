import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface SheetProps {
  title: string;
  eyebrow?: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

/** A centred modal sheet. Esc closes; focus moves inside and returns on close. */
export function Sheet({ title, eyebrow, onClose, children, footer, width = 460 }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = panelRef.current?.querySelector<HTMLElement>(
      "[autofocus], input:not([type=hidden]), select, textarea, button:not(.sheet-close)",
    );
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, []);

  return (
    <div className="sheet-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
        style={{ width }}
      >
        <header className="sheet-header">
          <div>
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            <h2 className="sheet-title">{title}</h2>
          </div>
          <button className="icon-btn sheet-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-footer">{footer}</footer>}
      </div>
    </div>
  );
}
