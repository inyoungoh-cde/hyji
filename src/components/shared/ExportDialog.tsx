import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Modal } from "./Modal";
import { generateBibTeX, papersToCsv } from "../../lib/bibtex";
import {
  papersToCitations,
  formatPaperAsCitation,
  type CitationStyle,
} from "../../lib/citations";
import type { VenueFormat } from "../../lib/venueMap";
import type { Paper } from "../../types";

type Format = "bib" | "word" | "csv" | "clipboard";

interface ExportDialogProps {
  papers: Paper[];
  onClose: () => void;
}

const STYLE_HINTS: Record<CitationStyle, string> = {
  ieee: "[1], [2], [3]…",
  acs: "(1), (2), (3)…",
  nature: "1. 2. 3.",
  apa: "no numbers, (Author, Year)",
  mla: "no numbers, Author.",
};

export function ExportDialog({ papers, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<Format>("bib");
  const [style, setStyle] = useState<CitationStyle>("ieee");
  const [startFrom, setStartFrom] = useState(1);
  const [noNumbers, setNoNumbers] = useState(false);
  const [venueFormat, setVenueFormat] = useState<VenueFormat>("full");
  const [busy, setBusy] = useState(false);

  const stylingDisabled = format === "bib" || format === "csv";

  const preview = useMemo(() => {
    if (papers.length === 0) return "";
    if (format === "bib") return generateBibTeX(papers[0], { venueFormat });
    if (format === "csv") {
      const head = papersToCsv([papers[0]]).split("\n");
      return head.slice(0, 2).join("\n");
    }
    return formatPaperAsCitation(papers[0], 0, {
      style,
      startFrom,
      noNumbers,
      venueFormat,
    });
  }, [papers, format, style, startFrom, noNumbers, venueFormat]);

  const buildContent = (): string => {
    if (format === "bib") {
      return papers.map((p) => generateBibTeX(p, { venueFormat })).join("\n\n");
    }
    if (format === "csv") {
      return papersToCsv(papers);
    }
    return papersToCitations(papers, { style, startFrom, noNumbers, venueFormat });
  };

  const handleExport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const content = buildContent();

      if (format === "clipboard") {
        await navigator.clipboard.writeText(content);
        onClose();
        return;
      }

      const ext = format === "bib" ? "bib" : format === "csv" ? "csv" : "txt";
      const filterName =
        format === "bib" ? "BibTeX" : format === "csv" ? "CSV" : "Text";
      const defaultName =
        format === "bib"
          ? "references.bib"
          : format === "csv"
            ? "papers.csv"
            : "references.txt";

      const target = await save({
        defaultPath: defaultName,
        filters: [{ name: filterName, extensions: [ext] }],
      });
      if (target) {
        await writeTextFile(target, content);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Export ${papers.length} paper${papers.length === 1 ? "" : "s"}`}>
      <div className="flex flex-col gap-4">
        {/* Output format */}
        <Section label="Output format">
          <div className="grid grid-cols-2 gap-1.5">
            {(["bib", "word", "csv", "clipboard"] as Format[]).map((f) => (
              <Radio
                key={f}
                checked={format === f}
                onChange={() => setFormat(f)}
                label={
                  f === "bib"
                    ? "LaTeX (.bib)"
                    : f === "word"
                      ? "Word references (.txt)"
                      : f === "csv"
                        ? "CSV (.csv)"
                        : "Copy to clipboard"
                }
              />
            ))}
          </div>
        </Section>

        {/* Citation style */}
        <Section label="Citation style" disabled={stylingDisabled}>
          <select
            disabled={stylingDisabled}
            value={style}
            onChange={(e) => setStyle(e.target.value as CitationStyle)}
            className="w-full bg-bg-tertiary text-body text-text-primary rounded px-2 py-1.5 outline-none border border-transparent focus:border-accent/40 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <option value="ieee">IEEE</option>
            <option value="acs">ACS</option>
            <option value="nature">Nature</option>
            <option value="apa">APA</option>
            <option value="mla">MLA</option>
          </select>
          <p className="text-caption text-text-tertiary mt-1">{STYLE_HINTS[style]}</p>

          <div className="flex items-center gap-3 mt-2">
            <label className="text-caption text-text-secondary flex items-center gap-1.5">
              Start from:
              <input
                type="number"
                min={1}
                disabled={stylingDisabled || noNumbers}
                value={startFrom}
                onChange={(e) => setStartFrom(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="w-14 bg-bg-tertiary text-body text-text-primary rounded px-2 py-0.5 outline-none border border-transparent focus:border-accent/40 disabled:opacity-40"
              />
            </label>
            <label className="text-caption text-text-secondary flex items-center gap-1.5">
              <input
                type="checkbox"
                disabled={stylingDisabled}
                checked={noNumbers}
                onChange={(e) => setNoNumbers(e.target.checked)}
              />
              No numbers
            </label>
          </div>
        </Section>

        {/* Journal name format */}
        <Section label="Journal names" disabled={stylingDisabled}>
          <div className="flex flex-col gap-1.5">
            <Radio
              disabled={stylingDisabled}
              checked={venueFormat === "full"}
              onChange={() => setVenueFormat("full")}
              label="Full name (Journal of the American …)"
            />
            <Radio
              disabled={stylingDisabled}
              checked={venueFormat === "abbr"}
              onChange={() => setVenueFormat("abbr")}
              label="Abbreviation with dots (J. Am. Chem. Soc.)"
            />
            <Radio
              disabled={stylingDisabled}
              checked={venueFormat === "abbr_nodots"}
              onChange={() => setVenueFormat("abbr_nodots")}
              label="Abbreviation no dots (J Am Chem Soc)"
            />
          </div>
        </Section>

        {/* Preview */}
        <Section label="Preview">
          <pre className="text-caption text-text-secondary bg-bg-tertiary rounded-[6px] px-3 py-2 max-h-[140px] overflow-y-auto whitespace-pre-wrap break-words font-mono selectable">
            {preview || "—"}
          </pre>
        </Section>

        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded text-body text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={busy || papers.length === 0}
            className="px-4 py-1.5 rounded bg-accent text-bg-primary text-body font-medium hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {format === "clipboard" ? "Copy" : "Export"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Section({
  label,
  children,
  disabled = false,
}: {
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={disabled ? "opacity-50" : ""}>
      <div className="text-caption font-bold uppercase tracking-wider text-text-tertiary mb-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function Radio({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 text-body ${disabled ? "cursor-not-allowed text-text-tertiary" : "cursor-pointer text-text-primary"}`}>
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="accent-[#58a6ff]"
      />
      <span>{label}</span>
    </label>
  );
}
