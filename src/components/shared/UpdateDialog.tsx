import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Modal } from "./Modal";
import { useUpdaterStore } from "../../stores/updater";

/** Two-part display version ("3.1.0" → "3.1"), matching the About dialog's scheme. */
function displayVersion(v: string): string {
  const m = /^(\d+)\.(\d+)(?:\.0)?$/.exec(v.trim());
  return m ? `${m[1]}.${m[2]}` : v;
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

export function UpdateDialog() {
  const open = useUpdaterStore((s) => s.open);
  const phase = useUpdaterStore((s) => s.phase);
  const update = useUpdaterStore((s) => s.update);
  const progress = useUpdaterStore((s) => s.progress);
  const downloadedBytes = useUpdaterStore((s) => s.downloadedBytes);
  const error = useUpdaterStore((s) => s.error);
  const install = useUpdaterStore((s) => s.install);
  const close = useUpdaterStore((s) => s.close);

  const [current, setCurrent] = useState("");
  useEffect(() => {
    if (open) getVersion().then(setCurrent).catch(() => setCurrent("?"));
  }, [open]);

  const busy = phase === "downloading" || phase === "installing";
  const title =
    phase === "available" || busy ? `HYJI ${displayVersion(update?.version ?? "")} is available`
    : phase === "checking" ? "Checking for updates…"
    : phase === "error" ? "Update check failed"
    : "Check for Updates";

  return (
    <Modal open={open} onClose={close} title={title}>
      <div className="text-body text-text-primary">
        {phase === "checking" && (
          <p className="text-text-secondary">Contacting the release feed…</p>
        )}

        {phase === "up-to-date" && (
          <p>
            You're up to date ({displayVersion(current)}).
          </p>
        )}

        {phase === "error" && (
          <p className="text-text-secondary whitespace-pre-wrap break-words">{error}</p>
        )}

        {(phase === "available" || busy) && update && (
          <>
            <p className="text-text-secondary">
              You have {displayVersion(current)}
              {update.date && formatDate(update.date) ? ` · released ${formatDate(update.date)}` : ""}
            </p>
            {update.body && (
              <div className="mt-3 max-h-56 overflow-y-auto hyji-pdf-scroll rounded bg-bg-tertiary border border-border px-3 py-2 text-caption text-text-secondary whitespace-pre-wrap break-words font-mono selectable">
                {update.body}
              </div>
            )}

            {busy && (
              <div className="mt-4">
                <div className="h-2 w-full rounded bg-bg-tertiary overflow-hidden">
                  <div
                    className={`h-full bg-accent transition-[width] duration-150 ${progress === null ? "animate-pulse w-1/3" : ""}`}
                    style={progress !== null ? { width: `${Math.round(progress * 100)}%` } : undefined}
                  />
                </div>
                <p className="mt-1.5 text-caption text-text-tertiary">
                  {phase === "installing"
                    ? "Download complete — launching the installer. HYJI will close and restart."
                    : progress !== null
                      ? `Downloading… ${Math.round(progress * 100)}% (${formatBytes(downloadedBytes)})`
                      : `Downloading… ${formatBytes(downloadedBytes)}`}
                </p>
              </div>
            )}
          </>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          {phase === "available" && (
            <>
              <button
                onClick={close}
                className="px-4 py-1.5 rounded text-body text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
              >
                Later
              </button>
              <button
                onClick={install}
                className="px-4 py-1.5 rounded text-body font-medium bg-accent/20 border border-accent/30 text-accent hover:bg-accent/30 transition-colors"
              >
                Download &amp; install
              </button>
            </>
          )}
          {(phase === "up-to-date" || phase === "error") && (
            <button
              onClick={close}
              className="px-5 py-1.5 rounded text-body font-medium bg-bg-tertiary hover:bg-border text-text-primary transition-colors"
            >
              OK
            </button>
          )}
        </div>

        <p className="mt-4 pt-3 border-t border-border text-caption text-text-tertiary leading-relaxed">
          What is sent: the check requests the release feed from{" "}
          <span className="font-mono">github.com</span> only — one request, no account, no
          telemetry, nothing about your library. Downloads come from the same GitHub Releases page
          and are signature-verified before installing.
        </p>
      </div>
    </Modal>
  );
}
