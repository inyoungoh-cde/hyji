import { Modal } from "./Modal";

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUT_CATEGORIES: { label: string; shortcuts: [string, string][] }[] = [
  {
    label: "File",
    shortcuts: [
      ["Ctrl+N", "Smart Paste"],
      ["Ctrl+O", "Import PDF"],
      ["Ctrl+Shift+N", "New Project"],
      ["Ctrl+Shift+B", "Export selected as .bib"],
    ],
  },
  {
    label: "Navigation",
    shortcuts: [
      ["Ctrl+H", "Dashboard"],
      ["Ctrl+B", "Toggle Sidebar"],
      ["Ctrl+J", "Toggle Tracker Panel"],
      ["Ctrl+G", "Keyword Graph (expand)"],
      ["Ctrl+M", "Expand Metadata"],
    ],
  },
  {
    label: "PDF",
    shortcuts: [
      ["Ctrl+F", "Find in PDF"],
      ["Ctrl+Shift+F", "Find Paper"],
      ["Ctrl+=", "Zoom In"],
      ["Ctrl+-", "Zoom Out"],
      ["Ctrl+0", "Fit Width"],
      ["Ctrl+Wheel", "Zoom"],
    ],
  },
  {
    label: "Edit",
    shortcuts: [
      ["F2", "Rename paper title"],
      ["Enter", "New bullet"],
      ["Shift+Enter", "Sub-bullet"],
      ["Backspace", "Merge bullet"],
      ["Delete", "Delete paper"],
    ],
  },
  {
    label: "Print / Save",
    shortcuts: [
      ["Ctrl+P", "Print PDF"],
    ],
  },
];

function KeyBadge({ combo }: { combo: string }) {
  const keys = combo.split("+");
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((key, i) => (
        <span key={i}>
          {i > 0 && <span className="text-text-tertiary mx-0.5">+</span>}
          <kbd className="inline-block bg-bg-tertiary border border-border rounded px-1.5 py-0.5 text-[11px] font-mono text-text-secondary leading-tight min-w-[20px] text-center">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  );
}

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard Shortcuts">
      <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1 space-y-4">
        {SHORTCUT_CATEGORIES.map((cat) => (
          <div key={cat.label}>
            <h3 className="text-[11px] font-bold uppercase tracking-[1px] text-text-tertiary mb-2">
              {cat.label}
            </h3>
            <div className="space-y-1.5">
              {cat.shortcuts.map(([combo, desc]) => (
                <div
                  key={combo}
                  className="flex items-center justify-between py-0.5"
                >
                  <span className="text-[12px] text-text-secondary">{desc}</span>
                  <KeyBadge combo={combo} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
