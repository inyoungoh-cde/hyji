import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import {
  getBackupConfig,
  getBackupStatus,
  setBackupConfig,
  triggerManualBackup,
  type BackupConfig,
  type BackupStatus,
} from "../../lib/backup";
import {
  loadStartupLayout,
  saveStartupLayout,
  useUiStore,
  type StartupLayout,
} from "../../stores/ui";
import { useNetworkStore } from "../../stores/network";

const LAYOUT_OPTIONS: { value: StartupLayout; label: string; hint: string }[] = [
  { value: "remember", label: "Remember last layout", hint: "Panels reopen exactly as you left them" },
  { value: "full", label: "Full workspace", hint: "Sidebar + tracker always open on launch" },
  { value: "viewer", label: "Viewer only", hint: "Start with all panels closed — pure PDF reading (Ctrl+B / Ctrl+J to reopen)" },
];

// Stem-darkening strength for PDF text on standard-DPI (100%-scale) monitors.
// pdf.js renders glyphs without hinting, so text can look thinner and lighter
// than Acrobat; the darkening pass compensates. Taste varies — let users pick.
const DARKENING_OPTIONS: { value: number; label: string; hint: string }[] = [
  { value: 0, label: "Off", hint: "pdf.js default rendering — lightest strokes" },
  { value: 0.35, label: "Subtle", hint: "A touch more weight, closest to the default look" },
  { value: 0.65, label: "Standard", hint: "Acrobat-like stroke weight (recommended)" },
  { value: 0.85, label: "Strong", hint: "Boldest — for low-contrast displays" },
];

interface PreferencesDialogProps {
  open: boolean;
  onClose: () => void;
}

const INTERVAL_OPTIONS: { label: string; value: number }[] = [
  { label: "5 minutes", value: 5 },
  { label: "10 minutes", value: 10 },
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
];

function formatBytes(n: number | null | undefined): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function PreferencesDialog({ open, onClose }: PreferencesDialogProps) {
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [status, setStatus] = useState<BackupStatus>({
    last_backup: null,
    last_backup_size: null,
  });
  const [saving, setSaving] = useState(false);
  const [startupLayout, setStartupLayout] = useState<StartupLayout>(loadStartupLayout);
  const offlineMode = useNetworkStore((s) => s.offlineMode);
  const setOfflineMode = useNetworkStore((s) => s.setOfflineMode);
  const pdfTextDarkening = useUiStore((s) => s.pdfTextDarkening);
  const setPdfTextDarkening = useUiStore((s) => s.setPdfTextDarkening);

  const handleLayoutChange = (layout: StartupLayout) => {
    setStartupLayout(layout);
    saveStartupLayout(layout);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [cfg, st] = await Promise.all([getBackupConfig(), getBackupStatus()]);
        if (!cancelled) {
          setConfig(cfg);
          setStatus(st);
        }
      } catch (e) {
        console.error("Load backup config:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const update = <K extends keyof BackupConfig>(key: K, value: BackupConfig[K]) => {
    setConfig((c) => (c ? { ...c, [key]: value } : c));
  };

  const handleBrowse = async () => {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const selected = await openDialog({ directory: true, multiple: false, title: "Select backup folder" });
    if (selected && typeof selected === "string") update("backup_folder", selected);
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await setBackupConfig(config);
      onClose();
    } catch (e) {
      const { message } = await import("@tauri-apps/plugin-dialog");
      await message(`Save failed: ${String(e)}`, { title: "Preferences", kind: "error" });
    } finally {
      setSaving(false);
    }
  };

  const handleBackupNow = async () => {
    if (!config) return;
    if (!config.backup_folder) {
      const { message } = await import("@tauri-apps/plugin-dialog");
      await message("Pick a backup folder first.", { title: "Backup Now", kind: "info" });
      return;
    }
    try {
      await setBackupConfig(config);
      const result = await triggerManualBackup();
      setStatus(result);
    } catch (e) {
      const { message } = await import("@tauri-apps/plugin-dialog");
      await message(`Backup failed: ${String(e)}`, { title: "Backup Now", kind: "error" });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Preferences">
      {!config ? (
        <div className="text-body text-text-tertiary py-6 text-center">Loading…</div>
      ) : (
        <div className="flex flex-col gap-4">
          <Section label="Startup layout">
            <div className="flex flex-col gap-2">
              {LAYOUT_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className="flex items-start gap-2 text-body text-text-primary cursor-pointer"
                >
                  <input
                    type="radio"
                    name="startup-layout"
                    checked={startupLayout === o.value}
                    onChange={() => handleLayoutChange(o.value)}
                    className="accent-[#58a6ff] mt-0.5"
                  />
                  <span>
                    {o.label}
                    <span className="block text-caption text-text-tertiary">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </Section>

          <Section label="PDF text rendering">
            <div className="flex flex-col gap-2">
              {DARKENING_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className="flex items-start gap-2 text-body text-text-primary cursor-pointer"
                >
                  <input
                    type="radio"
                    name="pdf-text-darkening"
                    checked={pdfTextDarkening === o.value}
                    onChange={() => setPdfTextDarkening(o.value)}
                    className="accent-[#58a6ff] mt-0.5"
                  />
                  <span>
                    {o.label}
                    <span className="block text-caption text-text-tertiary">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-caption text-text-tertiary leading-relaxed">
              Text stroke weight on standard-DPI monitors (100% display scale). Applies
              immediately to the open PDF — try each option and pick what reads best.
              High-DPI monitors (125%+ scale) are unaffected.
            </p>
          </Section>

          <Section label="Network & privacy">
            <label className="flex items-start gap-2 text-body text-text-primary cursor-pointer">
              <input
                type="checkbox"
                checked={offlineMode}
                onChange={(e) => setOfflineMode(e.target.checked)}
                className="accent-[#58a6ff] mt-0.5"
              />
              <span>
                Offline mode — disable all online features
                <span className="block text-caption text-text-tertiary">
                  Grays out "Fetch metadata". HYJI then makes no network requests at all.
                </span>
              </span>
            </label>
            <p className="mt-2 text-caption text-text-tertiary leading-relaxed">
              HYJI's only online feature is the metadata lookup, and it runs only when
              you click it. It sends the paper's DOI or arXiv ID — nothing else — directly
              to <span className="font-mono">api.crossref.org</span> or{" "}
              <span className="font-mono">export.arxiv.org</span> (both non-profit).
              Your PDFs, notes, and library never leave this computer.
            </p>
          </Section>

          <Section label="Auto-backup">
            <label className="flex items-center gap-2 text-body text-text-primary cursor-pointer">
              <input
                type="checkbox"
                checked={config.backup_enabled}
                onChange={(e) => update("backup_enabled", e.target.checked)}
                className="accent-[#58a6ff]"
              />
              Enable auto-backup
            </label>

            <div className="mt-3">
              <Label>Backup folder</Label>
              <div className="flex gap-2">
                <input
                  value={config.backup_folder}
                  onChange={(e) => update("backup_folder", e.target.value)}
                  placeholder="C:\HYJI_Backup"
                  className="flex-1 bg-bg-tertiary text-body text-text-primary rounded px-2 py-1.5 outline-none border border-transparent focus:border-accent/40 transition-colors selectable font-mono text-small"
                />
                <button
                  onClick={handleBrowse}
                  className="px-3 py-1.5 rounded bg-bg-tertiary text-body text-text-secondary hover:text-text-primary border border-border hover:border-accent/40 transition-colors"
                >
                  Browse
                </button>
              </div>
            </div>

            <div className="mt-3">
              <Label>Interval</Label>
              <select
                value={config.backup_interval_minutes}
                onChange={(e) => update("backup_interval_minutes", parseInt(e.target.value, 10))}
                className="w-full bg-bg-tertiary text-body text-text-primary rounded px-2 py-1.5 outline-none border border-transparent focus:border-accent/40 transition-colors cursor-pointer"
              >
                {INTERVAL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </Section>

          <Section label="Behavior">
            <label className="flex items-center gap-2 text-body text-text-primary cursor-pointer">
              <input
                type="checkbox"
                checked={config.backup_only_on_change}
                onChange={(e) => update("backup_only_on_change", e.target.checked)}
                className="accent-[#58a6ff]"
              />
              Only backup when changes detected
            </label>

            <div className="mt-3 flex items-center gap-2 text-body text-text-primary">
              <span>Keep last</span>
              <input
                type="number"
                min={1}
                value={config.backup_keep_count}
                onChange={(e) =>
                  update("backup_keep_count", Math.max(1, parseInt(e.target.value, 10) || 1))
                }
                className="w-16 bg-bg-tertiary text-body text-text-primary rounded px-2 py-1 outline-none border border-transparent focus:border-accent/40"
              />
              <span>backups (auto-delete old)</span>
            </div>
          </Section>

          <div className="text-caption text-text-tertiary -mt-1">
            Last backup: {status.last_backup ?? "—"}
            {status.last_backup_size != null && (
              <span> · {formatBytes(status.last_backup_size)}</span>
            )}
          </div>

          <div className="flex justify-between items-center mt-1">
            <button
              onClick={handleBackupNow}
              className="px-3 py-1.5 rounded text-caption text-text-secondary hover:text-accent border border-border hover:border-accent/40 transition-colors"
            >
              Backup now
            </button>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="px-4 py-1.5 rounded text-body text-text-secondary hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-1.5 rounded bg-accent text-bg-primary text-body font-medium hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-caption font-bold uppercase tracking-wider text-text-tertiary mb-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-caption font-bold uppercase tracking-wider text-text-tertiary mb-1">
      {children}
    </div>
  );
}
