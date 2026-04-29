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
