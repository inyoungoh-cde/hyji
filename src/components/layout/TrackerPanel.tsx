import { useEffect, useCallback, useState, useRef } from "react";
import { useUiStore } from "../../stores/ui";
import { usePapersStore } from "../../stores/papers";
import { useAnnotationsStore } from "../../stores/annotations";
import { useKeywordsStore } from "../../stores/keywords";
import { BulletEditor } from "../tracker/BulletEditor";
import { generateBibTeX } from "../../lib/bibtex";
import { onMenuEvent } from "../../lib/menuEvents";
import type { Paper, NoteLink } from "../../types";

export function TrackerPanel() {
  const activePaperId = useUiStore((s) => s.activePaperId);
  const setScrollToAnnotation = useUiStore((s) => s.setScrollToAnnotation);
  const papers = usePapersStore((s) => s.papers);
  const updatePaper = usePapersStore((s) => s.updatePaper);
  const activePaper = papers.find((p) => p.id === activePaperId);
  const { annotations, noteLinks, fetchAnnotations, deleteNoteLink } = useAnnotationsStore();

  const [metaOpen, setMetaOpen] = useState(false);
  const [bibtexCopied, setBibtexCopied] = useState(false);

  useEffect(() => {
    if (activePaperId) fetchAnnotations(activePaperId);
  }, [activePaperId, fetchAnnotations]);

  // Ctrl+M toggles metadata panel
  useEffect(() => {
    return onMenuEvent("expand-metadata", () => setMetaOpen((o) => !o));
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "m") {
        e.preventDefault();
        setMetaOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const handleLinkClick = useCallback(
    (annotationId: string, noteField?: string) => {
      const ann = annotations.find((a) => a.id === annotationId);
      if (ann) setScrollToAnnotation({ page: Number(ann.page), selectedText: ann.selected_text, noteField, rects_json: ann.rects_json });
    },
    [annotations, setScrollToAnnotation]
  );

  const handleDeleteDiffLink = useCallback(
    async (link: NoteLink) => {
      if (!activePaperId || !activePaper) return;
      await deleteNoteLink(link);
      const bullets = (activePaper.differentiation || "").split("\n");
      bullets.splice(Number(link.bullet_index), 1);
      await updatePaper(activePaperId, { differentiation: bullets.join("\n") });
    },
    [activePaperId, activePaper, deleteNoteLink, updatePaper]
  );

  const handleDeleteQuestLink = useCallback(
    async (link: NoteLink) => {
      if (!activePaperId || !activePaper) return;
      await deleteNoteLink(link);
      const bullets = (activePaper.questions || "").split("\n");
      bullets.splice(Number(link.bullet_index), 1);
      await updatePaper(activePaperId, { questions: bullets.join("\n") });
    },
    [activePaperId, activePaper, deleteNoteLink, updatePaper]
  );

  const handleCopyBibtex = () => {
    if (!activePaper) return;
    navigator.clipboard.writeText(generateBibTeX(activePaper));
    setBibtexCopied(true);
    setTimeout(() => setBibtexCopied(false), 1500);
  };

  if (!activePaper) {
    return (
      <div className="h-full flex items-center justify-center bg-bg-secondary">
        <span className="text-small text-text-tertiary">Select a paper to view details</span>
      </div>
    );
  }

  const handleChange = (field: keyof Paper, value: string | number | null) => {
    updatePaper(activePaper.id, { [field]: value });
  };

  return (
    <div className="h-full flex flex-col bg-bg-secondary">

      {/* ── NOTES SECTION — top, independently scrollable, generous min-height ── */}
      <div className="flex-1 min-h-[360px] overflow-y-auto">

        {/* SUMMARY */}
        <div className="px-4 pt-5 pb-5 border-b border-border min-h-[160px]">
          <h3 className="text-section font-bold uppercase tracking-wider mb-3 text-text-primary">
            Summary
          </h3>
          <BulletEditor
            value={activePaper.summary}
            onChange={(v) => handleChange("summary", v)}
            placeholder="Brief overview of the paper's objective, approach, and key findings."
            noteLinks={[]}
            onLinkClick={() => {}}
          />
        </div>

        {/* DIFFERENTIATION */}
        <div className="px-4 pt-5 pb-5 border-b border-border min-h-[160px]">
          <h3 className="text-section font-bold uppercase tracking-wider mb-3 text-[#ff6b35]">
            ✦ Differentiation
          </h3>
          <BulletEditor
            value={activePaper.differentiation}
            onChange={(v) => handleChange("differentiation", v)}
            placeholder="What distinguishes this work from prior approaches? Note the core novelty."
            noteLinks={noteLinks.filter((nl) => nl.note_field === "differentiation")}
            noteField="differentiation"
            onLinkClick={handleLinkClick}
            onDeleteLink={handleDeleteDiffLink}
          />
        </div>

        {/* QUESTIONS */}
        <div className="px-4 pt-5 pb-6 min-h-[160px]">
          <h3 className="text-section font-bold uppercase tracking-wider mb-3 text-[#7209b7]">
            ? Questions
          </h3>
          <BulletEditor
            value={activePaper.questions}
            onChange={(v) => handleChange("questions", v)}
            placeholder="Open questions, potential follow-ups, or connections to your own research."
            noteLinks={noteLinks.filter((nl) => nl.note_field === "questions")}
            noteField="questions"
            onLinkClick={handleLinkClick}
            onDeleteLink={handleDeleteQuestLink}
          />
        </div>
      </div>

      {/* ── METADATA SECTION — bottom, collapsible ── */}
      <div className="shrink-0 border-t border-border">
        <button
          onClick={() => setMetaOpen((o) => !o)}
          className="w-full flex items-center justify-between px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-text-tertiary hover:text-text-secondary transition-colors"
          title="Toggle metadata (Ctrl+M)"
        >
          <span className="flex items-center gap-1.5">
            <span className="text-[9px]">{metaOpen ? "▾" : "▸"}</span>
            Metadata
          </span>
          {!metaOpen && (
            <span className="text-[10px] font-normal normal-case tracking-normal text-text-tertiary truncate max-w-[140px]">
              {activePaper.title.slice(0, 24)}{activePaper.title.length > 24 ? "…" : ""}
            </span>
          )}
        </button>

        {metaOpen && (
          <div className="px-4 pb-3 max-h-96 overflow-y-auto">
            {/* Title */}
            <input
              value={activePaper.title}
              onChange={(e) => handleChange("title", e.target.value)}
              className="w-full bg-transparent text-[15px] font-semibold text-text-primary outline-none border-none mb-2 selectable"
              placeholder="Paper title"
            />
            {/* Authors */}
            <input
              value={activePaper.authors}
              onChange={(e) => handleChange("authors", e.target.value)}
              className="w-full bg-transparent text-body text-text-secondary outline-none border-none mb-3 selectable"
              placeholder="Authors"
            />
            {/* Year + Venue */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <FieldInput
                label="Year"
                value={activePaper.year?.toString() ?? ""}
                onChange={(v) => handleChange("year", v ? parseInt(v, 10) : null)}
              />
              <FieldInput
                label="Journal / Conf."
                value={activePaper.venue}
                onChange={(v) => handleChange("venue", v)}
              />
            </div>
            {/* Status + Importance */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <FieldSelect
                label="Status"
                value={activePaper.status}
                options={["Surveyed", "Fully Reviewed", "Revisit Needed"]}
                onChange={(v) => handleChange("status", v)}
              />
              <FieldSelect
                label="Importance"
                value={activePaper.importance}
                options={["Noted", "Potentially Relevant", "Must-Cite"]}
                onChange={(v) => handleChange("importance", v)}
              />
            </div>
            {/* Date Read — full width */}
            <div className="mb-3">
              <FieldInput
                label="Date Read"
                value={activePaper.date_read}
                onChange={(v) => handleChange("date_read", v)}
                type="date"
              />
            </div>
            {/* Link */}
            <div className="mb-3">
              <FieldInput
                label="Link"
                value={activePaper.link}
                onChange={(v) => handleChange("link", v)}
              />
            </div>
            {/* Keywords */}
            <KeywordsSection paperId={activePaper.id} />
          </div>
        )}
      </div>

      {/* ── COPY BIBTEX — always visible at bottom ── */}
      <div className="shrink-0 px-4 py-2 border-t border-border">
        <button
          onClick={handleCopyBibtex}
          className="w-full px-3 py-2 rounded-[6px] border border-border bg-bg-tertiary hover:border-accent/40 hover:text-text-primary text-body text-text-secondary transition-colors font-medium"
        >
          {bibtexCopied ? "✓ Copied!" : "Copy BibTeX"}
        </button>
      </div>
    </div>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-text-tertiary mb-1">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-bg-tertiary text-body text-text-primary rounded px-2 py-1 outline-none border border-transparent focus:border-accent/40 transition-colors selectable"
      />
    </div>
  );
}

function FieldSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-text-tertiary mb-1">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-bg-tertiary text-body text-text-primary rounded px-2 py-1 outline-none border border-transparent focus:border-accent/40 transition-colors cursor-pointer"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}

function KeywordsSection({ paperId }: { paperId: string }) {
  const { keywords: allKeywords, addKeyword, removeKeyword } = useKeywordsStore();
  const paperKeywords = allKeywords.filter((k) => k.paper_id === paperId);
  const [inputValue, setInputValue] = useState("");
  const [inputVisible, setInputVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAdd = async () => {
    const trimmed = inputValue.trim().toLowerCase();
    if (trimmed) await addKeyword(paperId, trimmed);
    setInputValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); handleAdd(); }
    if (e.key === ",") { e.preventDefault(); handleAdd(); }
    if (e.key === "Escape") { setInputVisible(false); setInputValue(""); }
  };

  const handleShowInput = () => {
    setInputVisible(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleBlur = async () => {
    await handleAdd();
    setInputVisible(false);
  };

  return (
    <div className="mt-1">
      <label className="block text-[10px] font-bold uppercase tracking-wider text-text-tertiary mb-1.5">
        Keywords
      </label>
      <div className="flex flex-wrap gap-1.5 items-center">
        {paperKeywords.map((kw) => (
          <span
            key={kw.id}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border ${
              kw.source === "manual"
                ? "bg-accent/10 text-accent border-accent/30"
                : "bg-bg-tertiary text-text-secondary border-border"
            }`}
          >
            {kw.keyword}
            <button
              onClick={() => removeKeyword(kw.id)}
              className="opacity-50 hover:opacity-100 transition-opacity leading-none ml-0.5"
              title="Remove keyword"
            >
              ✕
            </button>
          </span>
        ))}
        {inputVisible ? (
          <input
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder="keyword…"
            className="bg-bg-tertiary text-[11px] text-text-primary rounded-full px-2.5 py-0.5 outline-none border border-accent/40 w-28 selectable"
          />
        ) : (
          <button
            onClick={handleShowInput}
            className="px-2 py-0.5 rounded-full text-[11px] border border-dashed border-border text-text-tertiary hover:border-accent/40 hover:text-accent transition-colors"
          >
            + add
          </button>
        )}
      </div>
    </div>
  );
}
