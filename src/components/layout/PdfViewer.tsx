import { useState, useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUiStore } from "../../stores/ui";
import { usePapersStore } from "../../stores/papers";
import { useAnnotationsStore } from "../../stores/annotations";
import { PdfCanvas } from "../pdf/PdfCanvas";
import type { PdfCanvasHandle } from "../pdf/PdfCanvas";
import { Toolbar } from "../pdf/Toolbar";
import { ContextMenu } from "../pdf/ContextMenu";
import { SmartPaste } from "../shared/SmartPaste";
import { ImportDialog } from "../shared/ImportDialog";
import { ShortcutsModal } from "../shared/ShortcutsModal";
import { onMenuEvent, emitMenuEvent } from "../../lib/menuEvents";
import { useKeywordsStore } from "../../stores/keywords";
import { extractPdfMeta } from "../../lib/pdfMeta";
import { closeDb } from "../../lib/db";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfContextInfo } from "../pdf/PdfCanvas";
import type { PdfContextMenuState } from "../pdf/ContextMenu";
import { MemoEditor } from "../pdf/MemoEditor";
import { Dashboard } from "../home/Dashboard";

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function PdfViewer() {
  const activePaperId = useUiStore((s) => s.activePaperId);
  const scrollToAnnotation = useUiStore((s) => s.scrollToAnnotation);
  const setScrollToAnnotation = useUiStore((s) => s.setScrollToAnnotation);
  const papers = usePapersStore((s) => s.papers);
  const updatePaper = usePapersStore((s) => s.updatePaper);
  // updatePaper is also used for tab title rename (F2 / double-click)
  const activePaper = papers.find((p) => p.id === activePaperId);
  const { annotations, createAnnotation, createNoteLink, updateAnnotation, deleteAnnotation } = useAnnotationsStore();

  const [scale, setScale] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [extractModal, setExtractModal] = useState<{ title: string; paperId: string } | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<PdfCanvasHandle>(null);
  const pageWidthRef = useRef<number | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [goToPage, setGoToPage] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [searchTotal, setSearchTotal] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const [smartPasteOpen, setSmartPasteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [droppedFile, setDroppedFile] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<PdfContextMenuState | null>(null);
  const [editingMemo, setEditingMemo] = useState<{ id: string; x: number; y: number } | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [editingTabTitle, setEditingTabTitle] = useState(false);
  const [tabTitleInput, setTabTitleInput] = useState("");
  const tabTitleInputRef = useRef<HTMLInputElement>(null);

  const onDocLoaded = useCallback((doc: PDFDocumentProxy) => {
    setTotalPages(doc.numPages);
    setCurrentPage(1);
  }, []);

  const handlePageWidth = useCallback((w: number) => {
    pageWidthRef.current = w;
  }, []);

  const handleFitWidth = useCallback(() => {
    if (!viewerRef.current || !pageWidthRef.current) return;
    const containerWidth = viewerRef.current.clientWidth;
    const newScale = Math.round((containerWidth / pageWidthRef.current) * 100) / 100;
    setScale(Math.max(0.25, newScale));
  }, []);

  const onPageChange = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

  const handleGoToPage = useCallback((page: number) => {
    setGoToPage(page);
    setTimeout(() => setGoToPage(null), 100);
  }, []);

  const handleSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
    setSearchIndex(0);
  }, []);

  const onSearchResults = useCallback((count: number) => {
    setSearchTotal(count);
  }, []);

  const handleSearchNext = useCallback(() => {
    setSearchIndex((i) => (searchTotal > 0 ? (i + 1) % searchTotal : 0));
  }, [searchTotal]);

  const handleSearchPrev = useCallback(() => {
    setSearchIndex((i) => (searchTotal > 0 ? (i - 1 + searchTotal) % searchTotal : 0));
  }, [searchTotal]);

  const handleContextMenu = useCallback((info: PdfContextInfo) => {
    setContextMenu({ x: info.x, y: info.y, selectedText: info.selectedText, page: info.page, rects: info.rects });
  }, []);

  const handleSendTo = useCallback(
    async (field: "differentiation" | "questions") => {
      if (!contextMenu || !activePaperId || !activePaper) return;
      const color = field === "differentiation" ? "#ff6b35" : "#7209b7";

      const annotation = await createAnnotation({
        paper_id: activePaperId,
        type: "highlight",
        page: contextMenu.page,
        selected_text: contextMenu.selectedText,
        color,
        rects_json: JSON.stringify(contextMenu.rects || []),
      });

      const singleLine = contextMenu.selectedText.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
      const currentValue = activePaper[field] || "";
      const bullets = currentValue ? currentValue.split("\n") : [];
      const bulletIndex = bullets.length;
      const newValue = currentValue ? currentValue + "\n" + singleLine : singleLine;

      await updatePaper(activePaperId, { [field]: newValue });
      await createNoteLink({
        paper_id: activePaperId,
        annotation_id: annotation.id,
        note_field: field,
        bullet_index: bulletIndex,
      });

      setContextMenu(null);
    },
    [contextMenu, activePaperId, activePaper, createAnnotation, updatePaper, createNoteLink]
  );

  const handleHighlight = useCallback(
    async (color: string) => {
      if (!contextMenu || !activePaperId) return;
      await createAnnotation({
        paper_id: activePaperId,
        type: "highlight",
        page: contextMenu.page,
        selected_text: contextMenu.selectedText,
        color,
        rects_json: JSON.stringify(contextMenu.rects || []),
      });
      setContextMenu(null);
    },
    [contextMenu, activePaperId, createAnnotation]
  );

  const handleAddMemo = useCallback(
    async () => {
      if (!contextMenu || !activePaperId) return;
      const ann = await createAnnotation({
        paper_id: activePaperId,
        type: "memo",
        page: contextMenu.page,
        selected_text: contextMenu.selectedText,
        color: "#ffd166",
        rects_json: JSON.stringify(contextMenu.rects || []),
      });
      setContextMenu(null);
      // Position editor near the context menu click point
      setEditingMemo({ id: ann.id, x: contextMenu.x + 8, y: contextMenu.y });
    },
    [contextMenu, activePaperId, createAnnotation]
  );

  // Auto-extract keywords when active paper or its key fields change.
  // Watching activePaper?.title and pdf_path ensures re-extraction after title edits
  // and after papers finish loading (activePaper goes null→object).
  useEffect(() => {
    if (!activePaper) return;
    useKeywordsStore.getState().regenForPaper(activePaper);
  }, [activePaperId, activePaper?.title, activePaper?.raw_bibtex, activePaper?.pdf_path]);

  // Reset after flash animation completes
  useEffect(() => {
    if (scrollToAnnotation !== null) {
      const t = setTimeout(() => setScrollToAnnotation(null), 2000);
      return () => clearTimeout(t);
    }
  }, [scrollToAnnotation, setScrollToAnnotation]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        setShowSearch((s) => !s);
      }
      if (e.ctrlKey && e.key === "n") {
        e.preventDefault();
        setSmartPasteOpen(true);
      }
      if (e.ctrlKey && e.key === "o") {
        e.preventDefault();
        setImportOpen(true);
      }
      if (e.ctrlKey && e.key === "h") {
        e.preventDefault();
        useUiStore.getState().setActivePaper(null);
      }
      if (e.ctrlKey && e.key === "g") {
        e.preventDefault();
        emitMenuEvent("keyword-graph");
      }
      if (e.ctrlKey && e.key === "b") {
        e.preventDefault();
        useUiStore.getState().toggleSidebar();
      }
      if (e.ctrlKey && e.key === "j") {
        e.preventDefault();
        useUiStore.getState().toggleTracker();
      }
      if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setScale((s) => ZOOM_STEPS.find((z) => z > s) ?? s);
      }
      if (e.ctrlKey && e.key === "-") {
        e.preventDefault();
        setScale((s) => [...ZOOM_STEPS].reverse().find((z) => z < s) ?? s);
      }
      if (e.ctrlKey && e.key === "/") {
        e.preventDefault();
        setShowShortcuts((s) => !s);
      }
      if (e.ctrlKey && e.key === "0") {
        e.preventDefault();
        if (viewerRef.current && pageWidthRef.current) {
          const w = viewerRef.current.clientWidth;
          setScale(Math.max(0.25, Math.round((w / pageWidthRef.current) * 100) / 100));
        } else {
          setScale(1);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Ctrl+Wheel zoom
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setScale((current) => {
        if (e.deltaY < 0) {
          return ZOOM_STEPS.find((s) => s > current) ?? current;
        } else {
          return [...ZOOM_STEPS].reverse().find((s) => s < current) ?? current;
        }
      });
    };
    document.addEventListener("wheel", handler, { passive: false });
    return () => document.removeEventListener("wheel", handler);
  }, []);

  // Menu bar events
  useEffect(() => {
    const unsubs = [
      onMenuEvent("shortcuts", () => setShowShortcuts(true)),
      onMenuEvent("smart-paste", () => setSmartPasteOpen(true)),
      onMenuEvent("import-pdf", () => setImportOpen(true)),
      onMenuEvent("find-pdf", () => setShowSearch((s) => !s)),
      onMenuEvent("regen-keywords", async () => {
        const id = useUiStore.getState().activePaperId;
        if (!id) return;
        const paper = usePapersStore.getState().papers.find((p) => p.id === id);
        if (paper) await useKeywordsStore.getState().regenForPaper(paper);
      }),
      onMenuEvent("zoom-in", () => setScale((s) => ZOOM_STEPS.find((z) => z > s) ?? s)),
      onMenuEvent("zoom-out", () => setScale((s) => [...ZOOM_STEPS].reverse().find((z) => z < s) ?? s)),
      onMenuEvent("fit-width", () => {
        if (viewerRef.current && pageWidthRef.current) {
          const w = viewerRef.current.clientWidth;
          setScale(Math.max(0.25, Math.round((w / pageWidthRef.current) * 100) / 100));
        }
      }),
      onMenuEvent("dashboard", () => {
        useUiStore.getState().setActivePaper(null);
      }),
      onMenuEvent("delete-paper", async () => {
        const id = useUiStore.getState().activePaperId;
        if (!id) return;
        const { papers, deletePaper } = usePapersStore.getState();
        const paper = papers.find((p) => p.id === id);
        const { ask } = await import("@tauri-apps/plugin-dialog");
        const confirmed = await ask(
          `Delete "${paper?.title ?? "this paper"}"?\nThis cannot be undone.`,
          { title: "Delete Paper", kind: "warning" }
        );
        if (confirmed) {
          useUiStore.getState().setActivePaper(null);
          deletePaper(id);
        }
      }),

      onMenuEvent("extract-meta", async () => {
        const id = useUiStore.getState().activePaperId;
        const { message } = await import("@tauri-apps/plugin-dialog");
        if (!id) {
          await message("Open a paper first to extract its PDF metadata.", { title: "Extract PDF Metadata", kind: "info" });
          return;
        }
        const paper = usePapersStore.getState().papers.find((p) => p.id === id);
        if (!paper?.pdf_path) {
          await message("This paper has no PDF attached.", { title: "Extract PDF Metadata", kind: "info" });
          return;
        }
        const result = await extractPdfMeta(paper.pdf_path);
        if (!result.title) {
          await message("Could not extract a title from this PDF.", { title: "Extract PDF Metadata", kind: "info" });
          return;
        }
        setExtractModal({ title: result.title, paperId: id });
      }),

      onMenuEvent("db-backup", async () => {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { copyFile } = await import("@tauri-apps/plugin-fs");
        const { appDataDir, join } = await import("@tauri-apps/api/path");
        const { message } = await import("@tauri-apps/plugin-dialog");

        const destPath = await save({
          defaultPath: "hyji-backup.db",
          filters: [{ name: "SQLite Database", extensions: ["db"] }],
        });
        if (!destPath) return;

        try {
          const dataDir = await appDataDir();
          const srcPath = await join(dataDir, "hyji.db");
          await copyFile(srcPath, destPath);
          await message("Database backed up successfully.", { title: "Backup Complete", kind: "info" });
        } catch (e) {
          await message(`Backup failed: ${String(e)}`, { title: "Backup Error", kind: "error" });
        }
      }),

      onMenuEvent("db-restore", async () => {
        const { open, ask, message } = await import("@tauri-apps/plugin-dialog");
        const { copyFile } = await import("@tauri-apps/plugin-fs");
        const { appDataDir, join } = await import("@tauri-apps/api/path");

        const srcPath = await open({
          title: "Select backup file",
          filters: [{ name: "SQLite Database", extensions: ["db"] }],
          multiple: false,
          directory: false,
        });
        if (!srcPath || Array.isArray(srcPath)) return;

        const confirmed = await ask(
          "This will replace all current data (papers, notes, highlights) with the backup.\n\nThe app will reload automatically.\n\n⚠ Note: PDF files are stored separately and are not included in the backup. If PDF files have moved since the backup was made, they will not open correctly after restore.\n\nContinue?",
          { title: "Restore from Backup", kind: "warning" }
        );
        if (!confirmed) return;

        try {
          const dataDir = await appDataDir();
          const destPath = await join(dataDir, "hyji.db");
          await closeDb();
          await copyFile(srcPath, destPath);
          window.location.reload();
        } catch (e) {
          await message(`Restore failed: ${String(e)}`, { title: "Restore Error", kind: "error" });
        }
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, []);

  // Tauri native file drop
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    try {
      const win = getCurrentWindow();
      win.onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          const paths = event.payload.paths;
          const pdfPath = paths.find((p) => p.toLowerCase().endsWith(".pdf"));
          if (pdfPath) {
            setDroppedFile(pdfPath);
            setImportOpen(true);
          }
        }
      }).then((fn) => { unlisten = fn; })
        .catch(console.error);
    } catch (e) {
      console.error("Drag drop setup failed:", e);
    }
    return () => { unlisten?.(); };
  }, []);

  if (!activePaper) {
    return (
      <>
        <Dashboard
          onImportPdf={() => setImportOpen(true)}
          onSmartPaste={() => setSmartPasteOpen(true)}
        />
        <SmartPaste open={smartPasteOpen} onClose={() => setSmartPasteOpen(false)} />
        <ImportDialog
          open={importOpen}
          onClose={() => { setImportOpen(false); setDroppedFile(null); }}
          droppedFilePath={droppedFile}
        />
        <ShortcutsModal open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      </>
    );
  }

  const hasPdf = !!activePaper.pdf_path;
  const setActivePaper = useUiStore.getState().setActivePaper;

  return (
    <div ref={viewerRef} className="h-full flex flex-col bg-bg-primary">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-bg-secondary shrink-0 px-1 py-0.5 gap-1">
        <div className="flex-1 flex items-center min-w-0 bg-bg-tertiary rounded px-2 py-1 gap-2">
          <span className="text-[11px] text-text-tertiary flex-shrink-0">📄</span>
          {editingTabTitle ? (
            <input
              ref={tabTitleInputRef}
              value={tabTitleInput}
              onChange={(e) => setTabTitleInput(e.target.value)}
              onBlur={async () => {
                if (tabTitleInput.trim() && activePaper) {
                  await updatePaper(activePaper.id, { title: tabTitleInput.trim() });
                }
                setEditingTabTitle(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") {
                  setEditingTabTitle(false);
                }
              }}
              className="flex-1 min-w-0 bg-transparent text-body text-text-primary outline-none border-b border-accent selectable"
              autoFocus
            />
          ) : (
            <span
              className="truncate text-body text-text-primary flex-1 min-w-0 cursor-text"
              onDoubleClick={() => {
                setTabTitleInput(activePaper.title);
                setEditingTabTitle(true);
                setTimeout(() => tabTitleInputRef.current?.select(), 0);
              }}
              title="Double-click or F2 to rename"
            >
              {activePaper.title}
            </span>
          )}
          <button
            onClick={() => setActivePaper(null)}
            className="text-[11px] text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
            title="Close (return to Dashboard)"
          >
            ✕
          </button>
        </div>
        <button
          onClick={() => setImportOpen(true)}
          className="text-[13px] text-text-tertiary hover:text-accent transition-colors px-1.5 py-0.5 rounded hover:bg-bg-tertiary"
          title="Import PDF"
        >
          ＋
        </button>
      </div>

      {hasPdf && (
        <Toolbar
          currentPage={currentPage}
          totalPages={totalPages}
          scale={scale}
          onScaleChange={setScale}
          onFitWidth={handleFitWidth}
          onGoToPage={handleGoToPage}
          searchQuery={searchQuery}
          searchIndex={searchIndex}
          searchTotal={searchTotal}
          onSearchChange={handleSearchChange}
          onSearchNext={handleSearchNext}
          onSearchPrev={handleSearchPrev}
          showSearch={showSearch}
          onToggleSearch={() => setShowSearch((s) => !s)}
          status={activePaper.status}
          importance={activePaper.importance}
          onPrint={async () => {
            const imgs = await pdfCanvasRef.current?.getPrintImages();
            if (!imgs || imgs.length === 0) return;
            const iframe = document.createElement("iframe");
            iframe.style.cssText = "position:fixed;width:0;height:0;border:none;left:-9999px;";
            document.body.appendChild(iframe);
            const iDoc = iframe.contentDocument!;
            iDoc.open();
            iDoc.write(`<!DOCTYPE html><html><head><style>@page{margin:0;size:auto}body{margin:0}img{width:100%;display:block;page-break-after:always}</style></head><body>${imgs.map((s) => `<img src="${s}">`).join("")}</body></html>`);
            iDoc.close();
            setTimeout(() => {
              iframe.contentWindow?.print();
              setTimeout(() => iframe.remove(), 3000);
            }, 300);
          }}
          onSave={async () => {
            if (!activePaper?.pdf_path || annotations.length === 0) return;
            try {
              const { PDFDocument, rgb } = await import("pdf-lib");
              const { readFile, writeFile } = await import("@tauri-apps/plugin-fs");
              const { save } = await import("@tauri-apps/plugin-dialog");

              const bytes = await readFile(activePaper.pdf_path);
              const pdfDoc = await PDFDocument.load(bytes);
              const pages = pdfDoc.getPages();

              const hexToRgb = (hex: string) => {
                const r = parseInt(hex.slice(1, 3), 16) / 255;
                const g = parseInt(hex.slice(3, 5), 16) / 255;
                const b = parseInt(hex.slice(5, 7), 16) / 255;
                return rgb(r, g, b);
              };

              for (const ann of annotations) {
                if (ann.type !== "highlight") continue;
                let rects: { x: number; y: number; w: number; h: number; pageIndex?: number }[] = [];
                try { rects = JSON.parse(ann.rects_json || "[]"); } catch { continue; }
                if (rects.length === 0) continue;

                for (const rect of rects) {
                  const pageNum = (rect.pageIndex ?? ann.page) - 1;
                  const page = pages[pageNum];
                  if (!page) continue;
                  const { height } = page.getSize();
                  // pdf.js uses top-left origin; pdf-lib uses bottom-left
                  page.drawRectangle({
                    x: rect.x,
                    y: height - rect.y - rect.h,
                    width: rect.w,
                    height: rect.h,
                    color: hexToRgb(ann.color.slice(0, 7)),
                    opacity: 0.35,
                  });
                }
              }

              const outBytes = await pdfDoc.save();
              const savePath = await save({
                defaultPath: activePaper.pdf_path.replace(/\.pdf$/i, "_highlighted.pdf"),
                filters: [{ name: "PDF", extensions: ["pdf"] }],
              });
              if (savePath) {
                await writeFile(savePath, outBytes);
              }
            } catch (e) {
              const { message } = await import("@tauri-apps/plugin-dialog");
              await message(String(e), { title: "Save failed", kind: "error" });
            }
          }}
        />
      )}

      {hasPdf ? (
        <PdfCanvas
          ref={pdfCanvasRef}
          filePath={activePaper.pdf_path}
          scale={scale}
          onDocLoaded={onDocLoaded}
          onPageChange={onPageChange}
          searchQuery={searchQuery}
          searchIndex={searchIndex}
          onSearchResults={onSearchResults}
          goToPage={goToPage}
          scrollToAnnotation={scrollToAnnotation}
          onContextMenu={handleContextMenu}
          onPageWidth={handlePageWidth}
          annotations={annotations}
          onMemoOpen={(id, sx, sy) => setEditingMemo({ id, x: sx, y: sy })}
          onAnnotationDelete={(id) => { if (activePaperId) deleteAnnotation(id, activePaperId); }}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-[48px] mb-4 opacity-20">📄</div>
            <div className="text-body text-text-secondary">
              No PDF attached to this paper
            </div>
            <button
              onClick={() => setImportOpen(true)}
              className="mt-3 px-4 py-1.5 rounded bg-accent text-bg-primary text-body font-medium hover:bg-accent/90 transition-colors"
            >
              Import PDF
            </button>
          </div>
        </div>
      )}

      <SmartPaste open={smartPasteOpen} onClose={() => setSmartPasteOpen(false)} />
      <ImportDialog
        open={importOpen}
        onClose={() => { setImportOpen(false); setDroppedFile(null); }}
        droppedFilePath={droppedFile}
      />
      {extractModal && (
        <ExtractMetaModal
          initialTitle={extractModal.title}
          onApply={async (title) => {
            await usePapersStore.getState().updatePaper(extractModal.paperId, { title });
            setExtractModal(null);
          }}
          onClose={() => setExtractModal(null)}
        />
      )}
      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onHighlight={handleHighlight}
          onAddMemo={handleAddMemo}
          onSendTo={handleSendTo}
          onCopy={() => {
            navigator.clipboard.writeText(contextMenu.selectedText);
            setContextMenu(null);
          }}
        />
      )}
      <ShortcutsModal open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      {editingMemo && (() => {
        const memoAnn = annotations.find((a) => a.id === editingMemo.id);
        if (!memoAnn) return null;
        return (
          <MemoEditor
            annotation={memoAnn}
            initialX={Math.min(editingMemo.x, window.innerWidth - 260)}
            initialY={Math.min(editingMemo.y, window.innerHeight - 200)}
            onSave={(text) => {
              if (activePaperId) updateAnnotation(memoAnn.id, activePaperId, { memo_text: text });
            }}
            onDelete={() => {
              if (activePaperId) deleteAnnotation(memoAnn.id, activePaperId);
              setEditingMemo(null);
            }}
            onClose={() => setEditingMemo(null)}
          />
        );
      })()}
    </div>
  );
}

function ExtractMetaModal({
  initialTitle,
  onApply,
  onClose,
}: {
  initialTitle: string;
  onApply: (title: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (title.trim()) onApply(title.trim()); }
    if (e.key === "Escape") onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-bg-secondary border border-border rounded-[12px] p-5 w-[500px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-body font-semibold text-text-primary mb-1">Extract PDF Metadata</h3>
        <p className="text-small text-text-tertiary mb-3">
          Edit the extracted title if needed, then click Apply.
        </p>
        <textarea
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          className="w-full bg-bg-tertiary border border-border rounded-[6px] px-3 py-2 text-body text-text-primary outline-none focus:border-accent/40 resize-none selectable"
        />
        <p className="text-[10px] text-text-tertiary mt-1 mb-4">Ctrl+Enter to apply</p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-small text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { if (title.trim()) onApply(title.trim()); }}
            disabled={!title.trim()}
            className="px-4 py-1.5 rounded bg-accent text-bg-primary text-small font-semibold hover:bg-accent/90 disabled:opacity-40 transition-colors"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
