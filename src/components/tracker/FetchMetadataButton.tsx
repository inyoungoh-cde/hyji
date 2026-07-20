import { useState } from "react";
import { usePapersStore } from "../../stores/papers";
import { useNetworkStore } from "../../stores/network";
import { fetchMetadataForPaper, type FetchedMetadata } from "../../lib/metadataFetch";
import type { Paper } from "../../types";

interface FieldDiff {
  key: keyof Paper;
  label: string;
  current: string;
  fetched: string;
  apply: boolean;
}

/** "Fetch metadata" button + confirm-before-overwrite diff dialog. */
export function FetchMetadataButton({ paper }: { paper: Paper }) {
  const updatePaper = usePapersStore((s) => s.updatePaper);
  const offlineMode = useNetworkStore((s) => s.offlineMode);
  const fetchConsented = useNetworkStore((s) => s.fetchConsented);
  const grantFetchConsent = useNetworkStore((s) => s.grantFetchConsent);
  const [busy, setBusy] = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [result, setResult] = useState<{ meta: FetchedMetadata; diffs: FieldDiff[] } | null>(null);

  const handleFetch = () => {
    if (busy || offlineMode) return;
    if (!fetchConsented) {
      setShowConsent(true);
      return;
    }
    void runFetch();
  };

  const runFetch = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const meta = await fetchMetadataForPaper(paper);
      const candidates: Array<[keyof Paper, string, string]> = [
        ["title", "Title", meta.title],
        ["authors", "Authors", meta.authors],
        ["year", "Year", meta.year ? String(meta.year) : ""],
        ["venue", "Journal / Conf.", meta.venue],
        ["ref_type", "Type", meta.refType],
        ["publisher", "Publisher", meta.publisher],
        ["pages", "Pages", meta.pages],
        ["doi", "DOI", meta.doi],
        ["abstract_text", "Abstract", meta.abstract],
        ["link", "Link", meta.link],
      ];
      const diffs: FieldDiff[] = [];
      for (const [key, label, fetched] of candidates) {
        const current = String(paper[key] ?? "");
        if (!fetched.trim() || fetched.trim() === current.trim()) continue;
        diffs.push({ key, label, current, fetched, apply: true });
      }
      if (diffs.length === 0) {
        const { message } = await import("@tauri-apps/plugin-dialog");
        await message(`Metadata from ${meta.source} matches what you already have — nothing to update.`, {
          title: "Fetch Metadata", kind: "info",
        });
        return;
      }
      setResult({ meta, diffs });
    } catch (e) {
      const { message } = await import("@tauri-apps/plugin-dialog");
      await message(String(e instanceof Error ? e.message : e), { title: "Fetch Metadata", kind: "warning" });
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!result) return;
    const fields: Partial<Record<keyof Paper, unknown>> = {};
    for (const d of result.diffs) {
      if (!d.apply) continue;
      fields[d.key] = d.key === "year" ? parseInt(d.fetched, 10) : d.fetched;
      if (d.key === "authors") {
        fields.first_author = d.fetched.split(",")[0]?.trim() ?? "";
      }
    }
    await updatePaper(paper.id, fields as Partial<Paper>);
    setResult(null);
  };

  return (
    <>
      <button
        onClick={handleFetch}
        disabled={busy || offlineMode}
        className="w-full mb-3 px-3 py-1.5 rounded-[6px] border border-border bg-bg-tertiary text-body text-text-secondary hover:text-text-primary hover:border-accent/40 disabled:opacity-50 transition-colors"
        title={
          offlineMode
            ? "Offline mode is on — enable online features in Tools → Preferences… → Network & privacy"
            : "Look up this paper on Crossref / arXiv using its DOI or arXiv ID"
        }
      >
        {busy ? "Fetching…" : "🌐 Fetch metadata (DOI / arXiv)"}
      </button>

      {showConsent && (
        <div
          className="fixed inset-0 z-[350] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onMouseDown={() => setShowConsent(false)}
        >
          <div
            className="w-[480px] max-w-[92vw] bg-bg-secondary border border-border rounded-[12px] shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-4 pb-2">
              <h3 className="text-body font-semibold text-text-primary">
                Before the first online lookup
              </h3>
            </div>
            <div className="px-5 py-1 text-body text-text-secondary leading-relaxed flex flex-col gap-2">
              <p>
                HYJI will send <span className="text-text-primary font-medium">only this
                paper's DOI or arXiv ID</span> — nothing else — directly to{" "}
                <span className="font-mono text-small">api.crossref.org</span> or{" "}
                <span className="font-mono text-small">export.arxiv.org</span> (both
                non-profit scholarly services) and read back the public metadata.
              </p>
              <p>
                Your PDFs, notes, highlights, and library never leave this computer.
                Lookups happen only when you click this button, and you can disable
                them entirely in Tools → Preferences… → Network &amp; privacy.
              </p>
            </div>
            <div className="px-5 py-3 mt-1 border-t border-border flex justify-end gap-2">
              <button
                onClick={() => setShowConsent(false)}
                className="px-4 py-1.5 rounded text-body text-text-secondary hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  grantFetchConsent();
                  setShowConsent(false);
                  void runFetch();
                }}
                className="px-4 py-1.5 rounded bg-accent text-bg-primary text-body font-medium hover:bg-accent/90 transition-colors"
              >
                OK, look it up
              </button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div
          className="fixed inset-0 z-[350] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onMouseDown={() => setResult(null)}
        >
          <div
            className="w-[560px] max-w-[92vw] max-h-[80vh] flex flex-col bg-bg-secondary border border-border rounded-[12px] shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-4 pb-2">
              <h3 className="text-body font-semibold text-text-primary">
                Metadata found on {result.meta.source === "crossref" ? "Crossref" : "arXiv"}
              </h3>
              <p className="text-caption text-text-tertiary mt-0.5">
                Untick anything you don't want overwritten, then Apply.
              </p>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-2 flex flex-col gap-2">
              {result.diffs.map((d, i) => (
                <label key={d.key} className="flex items-start gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={d.apply}
                    onChange={(e) => {
                      const diffs = [...result.diffs];
                      diffs[i] = { ...d, apply: e.target.checked };
                      setResult({ ...result, diffs });
                    }}
                    className="accent-[#58a6ff] mt-1"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-caption font-bold uppercase tracking-wider text-text-tertiary">
                      {d.label}
                    </span>
                    {d.current && (
                      <span className="block text-small text-text-tertiary line-through truncate">
                        {d.current}
                      </span>
                    )}
                    <span className="block text-body text-text-primary break-words line-clamp-3">
                      {d.fetched}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
              <button
                onClick={() => setResult(null)}
                className="px-4 py-1.5 rounded text-body text-text-secondary hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleApply}
                disabled={!result.diffs.some((d) => d.apply)}
                className="px-4 py-1.5 rounded bg-accent text-bg-primary text-body font-medium hover:bg-accent/90 disabled:opacity-40 transition-colors"
              >
                Apply {result.diffs.filter((d) => d.apply).length} field
                {result.diffs.filter((d) => d.apply).length === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
