import { useState, useEffect } from "react";
import { Modal } from "./Modal";
import { usePapersStore } from "../../stores/papers";
import { useProjectsStore } from "../../stores/projects";
import { useUiStore } from "../../stores/ui";
import { extractPdfMeta } from "../../lib/pdfMeta";

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  droppedFilePath: string | null;
}

export function ImportDialog({ open, onClose, droppedFilePath }: ImportDialogProps) {
  const [filePath, setFilePath] = useState("");
  const [storageMode, setStorageMode] = useState<"copy" | "link">("link");
  const [title, setTitle] = useState("");
  const [extracting, setExtracting] = useState(false);
  const createPaper = usePapersStore((s) => s.createPaper);
  const updatePaper = usePapersStore((s) => s.updatePaper);
  const activePaperId = useUiStore((s) => s.activePaperId);
  const setActivePaper = useUiStore((s) => s.setActivePaper);
  const selectedProjectId = useUiStore((s) => s.selectedProjectId);
  const papers = usePapersStore((s) => s.papers);
  const activePaper = papers.find((p) => p.id === activePaperId);
  const { projects } = useProjectsStore();

  // Target project defaults to currently selected project (null = unassigned)
  const [targetProjectId, setTargetProjectId] = useState<string | null>(selectedProjectId);

  // Sync target project when selected project changes (e.g. user switches folder while dialog is open)
  useEffect(() => {
    setTargetProjectId(selectedProjectId);
  }, [selectedProjectId]);

  const targetProject = projects.find((p) => p.id === targetProjectId) ?? null;

  const applyFilePath = async (path: string) => {
    setFilePath(path);
    const filename = path.split(/[/\\]/).pop() ?? "";
    const fallback = filename.replace(/\.pdf$/i, "");
    setTitle(fallback);
    setExtracting(true);
    try {
      const { title: extracted } = await extractPdfMeta(path);
      if (extracted) setTitle(extracted);
    } finally {
      setExtracting(false);
    }
  };

  useEffect(() => {
    if (droppedFilePath) applyFilePath(droppedFilePath);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedFilePath]);

  const handleBrowse = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "PDF Files", extensions: ["pdf"] }],
      });
      if (selected) {
        await applyFilePath(selected as string);
      }
    } catch (err) {
      console.error("Dialog error:", err);
    }
  };

  const attachPdf = async (paperId: string) => {
    if (!filePath) return;

    let finalPath = filePath;

    if (storageMode === "copy") {
      try {
        const { copyFile, mkdir } = await import("@tauri-apps/plugin-fs");
        const { appDataDir, join } = await import("@tauri-apps/api/path");
        const filename = filePath.split(/[/\\]/).pop() ?? "paper.pdf";
        const baseDir = targetProject?.folder_path || (await appDataDir());
        const pdfsDir = await join(baseDir, "pdfs");
        await mkdir(pdfsDir, { recursive: true });
        finalPath = await join(pdfsDir, filename);
        await copyFile(filePath, finalPath);
      } catch (err) {
        console.error("Copy failed, falling back to link:", err);
      }
    }

    await updatePaper(paperId, {
      pdf_path: finalPath,
      pdf_storage: storageMode,
    });
    setActivePaper(paperId);
    handleClose();
  };

  const handleAttachToCurrent = async () => {
    if (activePaperId) await attachPdf(activePaperId);
  };

  const handleCreateNew = async () => {
    if (!filePath) return;
    const paper = await createPaper(title || "Untitled Paper", targetProjectId);
    await attachPdf(paper.id);
  };

  const handleClose = () => {
    setFilePath("");
    setTitle("");
    setStorageMode("link");
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Import PDF">
      <div className="flex flex-col gap-3">
        {/* PDF file path */}
        <div>
          <label className="block text-caption font-bold uppercase tracking-wider text-text-tertiary mb-1">
            PDF File
          </label>
          <div className="flex gap-2">
            <input
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="Path to PDF file..."
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

        {/* Title — only when creating new */}
        {!activePaper && (
          <div>
            <label className="block text-caption font-bold uppercase tracking-wider text-text-tertiary mb-1">
              Title
              {extracting && (
                <span className="ml-2 text-accent normal-case font-normal tracking-normal">extracting…</span>
              )}
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Auto-detected from PDF…"
              className="w-full bg-bg-tertiary text-body text-text-primary rounded px-2 py-1.5 outline-none border border-transparent focus:border-accent/40 transition-colors selectable"
            />
          </div>
        )}

        {/* Storage mode */}
        <div>
          <label className="block text-caption font-bold uppercase tracking-wider text-text-tertiary mb-2">
            Storage
          </label>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="storage"
                checked={storageMode === "link"}
                onChange={() => setStorageMode("link")}
                className="accent-[#58a6ff]"
              />
              <div>
                <div className="text-body text-text-primary">Link from current location</div>
                <div className="text-caption text-text-tertiary">Reference the original file</div>
              </div>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="storage"
                checked={storageMode === "copy"}
                onChange={() => setStorageMode("copy")}
                className="accent-[#58a6ff]"
              />
              <div>
                <div className="text-body text-text-primary">Copy into project</div>
                <div className="text-caption text-text-tertiary">
                  {targetProject?.folder_path
                    ? `→ ${targetProject.folder_path}/pdfs/`
                    : "→ App data folder/pdfs/"}
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* Project selector — only when creating new */}
        {!activePaper && (
          <div>
            <label className="block text-caption font-bold uppercase tracking-wider text-text-tertiary mb-1">
              Project
            </label>
            <select
              value={targetProjectId ?? ""}
              onChange={(e) => setTargetProjectId(e.target.value || null)}
              className="w-full bg-bg-tertiary text-body text-text-primary rounded px-2 py-1.5 outline-none border border-transparent focus:border-accent/40 transition-colors cursor-pointer"
            >
              <option value="">— Unassigned —</option>
              {projects.map((proj) => (
                <option key={proj.id} value={proj.id}>
                  {proj.parent_id
                    ? `  ↳ ${proj.name}`
                    : proj.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded text-body text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          {activePaper && (
            <button
              onClick={handleAttachToCurrent}
              disabled={!filePath}
              className="px-4 py-1.5 rounded border border-accent text-accent text-body font-medium hover:bg-accent/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Attach to "{activePaper.title.length > 20
                ? activePaper.title.slice(0, 20) + "…"
                : activePaper.title}"
            </button>
          )}
          <button
            onClick={handleCreateNew}
            disabled={!filePath}
            className="px-4 py-1.5 rounded bg-accent text-bg-primary text-body font-medium hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Create New Paper
          </button>
        </div>
      </div>
    </Modal>
  );
}
