import { useEffect } from "react";

interface Props {
  onClose: () => void;
}

interface ShortcutRow {
  label: string;
  keys: string[];
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    rows: [
      { label: "Dashboard (home)", keys: ["Ctrl", "H"] },
      { label: "Toggle Sidebar", keys: ["Ctrl", "B"] },
      { label: "Toggle Tracker Panel", keys: ["Ctrl", "J"] },
      { label: "Keyword Graph (fullscreen)", keys: ["Ctrl", "G"] },
      { label: "Toggle Metadata section", keys: ["Ctrl", "M"] },
    ],
  },
  {
    title: "Papers",
    rows: [
      { label: "Import PDF", keys: ["Ctrl", "O"] },
      { label: "Smart Paste (BibTeX / arXiv)", keys: ["Ctrl", "N"] },
      { label: "New Project folder", keys: ["Ctrl", "Shift", "N"] },
      { label: "Find paper in sidebar", keys: ["Ctrl", "Shift", "F"] },
      { label: "Rename selected item", keys: ["F2"] },
      { label: "Delete paper", keys: ["Delete"] },
      { label: "Exit select mode", keys: ["Esc"] },
    ],
  },
  {
    title: "PDF Viewer",
    rows: [
      { label: "Find in PDF", keys: ["Ctrl", "F"] },
      { label: "Zoom in", keys: ["Ctrl", "="] },
      { label: "Zoom out", keys: ["Ctrl", "−"] },
      { label: "Fit width", keys: ["Ctrl", "0"] },
      { label: "Zoom (mouse wheel)", keys: ["Ctrl", "Scroll"] },
    ],
  },
  {
    title: "Edit",
    rows: [
      { label: "Undo", keys: ["Ctrl", "Z"] },
      { label: "Redo", keys: ["Ctrl", "Shift", "Z"] },
    ],
  },
  {
    title: "General",
    rows: [
      { label: "Keyboard shortcuts", keys: ["Ctrl", "/"] },
      { label: "Close modal / cancel", keys: ["Esc"] },
      { label: "Exit app", keys: ["Alt", "F4"] },
    ],
  },
];

function KeyBadge({ k }: { k: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: k.length > 3 ? "auto" : 22,
        height: 20,
        padding: k.length > 3 ? "0 6px" : "0 4px",
        borderRadius: 4,
        background: "rgba(255,255,255,0.06)",
        border: "1px solid #30363d",
        fontSize: "0.846rem",
        fontFamily: "'SF Mono','Cascadia Code','Fira Code',monospace",
        color: "var(--text-secondary)",
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      {k}
    </span>
  );
}

export function KeyboardShortcutsModal({ onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onMouseDown={onClose}
    >
      <div
        style={{
          background: "#161b22",
          border: "0.5px solid #30363d",
          borderRadius: 12,
          padding: "28px 32px",
          maxWidth: 500,
          width: "100%",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          fontSize: "1.231rem",
          fontWeight: 600,
          color: "var(--text-primary)",
          marginBottom: 20,
          flexShrink: 0,
        }}>
          Keyboard Shortcuts
        </div>

        {/* Scrollable content */}
        <div style={{ overflowY: "auto", flex: 1, marginRight: -8, paddingRight: 8 }}>
          {GROUPS.map((group, gi) => (
            <div key={group.title} style={{ marginBottom: gi < GROUPS.length - 1 ? 20 : 0 }}>
              {/* Group title */}
              <div style={{
                fontSize: "0.769rem",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--text-tertiary)",
                marginBottom: 6,
              }}>
                {group.title}
              </div>

              {/* Rows */}
              {group.rows.map((row) => (
                <div
                  key={row.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "5px 0",
                    borderBottom: "1px solid rgba(48,54,61,0.5)",
                    gap: 12,
                  }}
                >
                  <span style={{ fontSize: "1rem", color: "var(--text-secondary)", flexShrink: 1 }}>
                    {row.label}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
                    {row.keys.map((k, i) => (
                      <span key={i} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                        {i > 0 && (
                          <span style={{ fontSize: "0.769rem", color: "var(--text-tertiary)", margin: "0 1px" }}>+</span>
                        )}
                        <KeyBadge k={k} />
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Divider + OK */}
        <div style={{ height: 1, background: "#30363d", margin: "20px 0 16px", flexShrink: 0 }} />
        <div style={{ display: "flex", justifyContent: "center", flexShrink: 0 }}>
          <button
            onClick={onClose}
            className="px-6 py-1.5 rounded text-body font-medium bg-bg-tertiary hover:bg-border text-text-primary transition-colors"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
