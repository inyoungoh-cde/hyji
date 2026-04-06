import { useState } from "react";
import { Modal } from "./Modal";
import { parseInput, type ParsedPaper } from "../../lib/parser";
import { usePapersStore } from "../../stores/papers";
import { useUiStore } from "../../stores/ui";

interface SmartPasteProps {
  open: boolean;
  onClose: () => void;
  initialText?: string;
}

export function SmartPaste({ open, onClose, initialText = "" }: SmartPasteProps) {
  const [input, setInput] = useState(initialText);
  const [parsed, setParsed] = useState<ParsedPaper | null>(null);
  const [step, setStep] = useState<"input" | "preview">("input");
  const createPaper = usePapersStore((s) => s.createPaper);
  const updatePaper = usePapersStore((s) => s.updatePaper);
  const activePaperId = useUiStore((s) => s.activePaperId);
  const setActivePaper = useUiStore((s) => s.setActivePaper);
  const selectedProjectId = useUiStore((s) => s.selectedProjectId);
  const papers = usePapersStore((s) => s.papers);
  const activePaper = papers.find((p) => p.id === activePaperId);

  const handleParse = () => {
    if (!input.trim()) return;
    const result = parseInput(input);
    setParsed(result);
    setStep("preview");
  };

  const applyToPaper = async (paperId: string) => {
    if (!parsed) return;
    await updatePaper(paperId, {
      title: parsed.title,
      authors: parsed.authors,
      first_author: parsed.firstAuthor,
      year: parsed.year,
      venue: parsed.venue,
      raw_bibtex: parsed.rawBibtex,
    });
    setActivePaper(paperId);
    handleClose();
  };

  const handleApplyToCurrent = async () => {
    if (activePaperId) await applyToPaper(activePaperId);
  };

  const handleCreateNew = async () => {
    if (!parsed) return;
    const paper = await createPaper(parsed.title, selectedProjectId);
    await applyToPaper(paper.id);
  };

  const handleClose = () => {
    setInput("");
    setParsed(null);
    setStep("input");
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Smart Paste">
      {step === "input" ? (
        <div className="flex flex-col gap-3">
          <p className="text-small text-text-secondary">
            Paste a BibTeX entry, citation string, arXiv ID, or paper title.
          </p>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`@inproceedings{name,\n  title={...},\n  author={...},\n  ...\n}\n\nor: Author. "Title." Venue, 2024.\nor: 2403.18913`}
            rows={8}
            autoFocus
            className="w-full bg-bg-tertiary text-body text-text-primary rounded-[8px] px-3 py-2 outline-none border border-transparent focus:border-accent/40 transition-colors resize-none font-mono selectable"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={handleClose}
              className="px-4 py-1.5 rounded text-body text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleParse}
              disabled={!input.trim()}
              className="px-4 py-1.5 rounded bg-accent text-bg-primary text-body font-medium hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Parse
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-small text-text-secondary">
            Detected fields — edit if needed, then choose where to apply.
          </p>
          <PreviewField
            label="Title"
            value={parsed?.title ?? ""}
            onChange={(v) => setParsed((p) => p && { ...p, title: v })}
          />
          <PreviewField
            label="Authors"
            value={parsed?.authors ?? ""}
            onChange={(v) => setParsed((p) => p && { ...p, authors: v })}
          />
          <div className="grid grid-cols-2 gap-2">
            <PreviewField
              label="Year"
              value={parsed?.year?.toString() ?? ""}
              onChange={(v) =>
                setParsed((p) => p && { ...p, year: v ? parseInt(v, 10) : null })
              }
            />
            <PreviewField
              label="Journal / Conf."
              value={parsed?.venue ?? ""}
              onChange={(v) => setParsed((p) => p && { ...p, venue: v })}
            />
          </div>
          {parsed?.rawBibtex && (
            <div className="text-[10px] text-text-tertiary bg-bg-tertiary rounded px-2 py-1 font-mono max-h-[80px] overflow-y-auto selectable">
              {parsed.rawBibtex.slice(0, 200)}
              {parsed.rawBibtex.length > 200 && "..."}
            </div>
          )}
          <div className="flex justify-end gap-2 mt-1">
            <button
              onClick={() => setStep("input")}
              className="px-4 py-1.5 rounded text-body text-text-secondary hover:text-text-primary transition-colors"
            >
              Back
            </button>
            {activePaper && (
              <button
                onClick={handleApplyToCurrent}
                className="px-4 py-1.5 rounded border border-accent text-accent text-body font-medium hover:bg-accent/10 transition-colors"
              >
                Apply to "{activePaper.title.length > 20
                  ? activePaper.title.slice(0, 20) + "…"
                  : activePaper.title}"
              </button>
            )}
            <button
              onClick={handleCreateNew}
              className="px-4 py-1.5 rounded bg-accent text-bg-primary text-body font-medium hover:bg-accent/90 transition-colors"
            >
              Create New Paper
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function PreviewField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-text-tertiary mb-1">
        {label}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-bg-tertiary text-body text-text-primary rounded px-2 py-1.5 outline-none border border-transparent focus:border-accent/40 transition-colors selectable"
      />
    </div>
  );
}
