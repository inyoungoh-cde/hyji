import { invoke } from "@tauri-apps/api/core";

export interface BackupConfig {
  backup_enabled: boolean;
  backup_folder: string;
  backup_interval_minutes: number;
  backup_only_on_change: boolean;
  backup_keep_count: number;
}

export interface BackupStatus {
  last_backup: string | null;
  last_backup_size: number | null;
}

export async function getBackupConfig(): Promise<BackupConfig> {
  return invoke<BackupConfig>("get_backup_config");
}

export async function setBackupConfig(config: BackupConfig): Promise<void> {
  await invoke("set_backup_config", { config });
}

export async function getBackupStatus(): Promise<BackupStatus> {
  return invoke<BackupStatus>("get_backup_status");
}

export async function triggerManualBackup(): Promise<BackupStatus> {
  return invoke<BackupStatus>("trigger_manual_backup");
}

// Fire-and-forget — never throws into call sites.
export function markDbDirty(): void {
  invoke("mark_db_dirty").catch(() => {});
}
