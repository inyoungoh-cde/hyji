import { useEffect, useRef } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
    >
      {/* Panel is capped to the viewport; the body scrolls when content is
          taller (e.g. Preferences on a small window). Header stays pinned. */}
      <div className="bg-bg-secondary border border-border rounded-card w-full max-w-lg mx-4 shadow-xl flex flex-col max-h-[calc(100vh-48px)]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-body font-semibold text-text-primary">{title}</h2>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text-primary text-title leading-none transition-colors"
          >
            ×
          </button>
        </div>
        <div className="p-5 overflow-y-auto hyji-pdf-scroll">{children}</div>
      </div>
    </div>
  );
}
