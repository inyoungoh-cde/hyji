import type { Paper } from "../types";

function sanitizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20);
}

function generateCiteKey(paper: Paper): string {
  const author = sanitizeKey(paper.first_author || paper.authors.split(",")[0] || "unknown");
  const year = paper.year ? String(paper.year) : "0000";
  const titleWord = sanitizeKey((paper.title || "").split(" ")[0]);
  return `${author}${year}${titleWord}`;
}

function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/[&%$#_{}]/g, (c) => `\\${c}`)
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// Heuristic: is the venue a journal (has "journal", "transactions", "review", etc.)?
function isJournal(venue: string): boolean {
  const lower = venue.toLowerCase();
  return (
    lower.includes("journal") ||
    lower.includes("transaction") ||
    lower.includes("review") ||
    lower.includes("nature") ||
    lower.includes("science") ||
    ["TPAMI", "IJCV", "TIP", "TNNLS", "JMLR", "TOG", "TVCG", "CGF", "TVC"].includes(venue.trim())
  );
}

export function generateBibTeX(paper: Paper): string {
  // Use raw_bibtex verbatim if available
  if (paper.raw_bibtex?.trim()) return paper.raw_bibtex.trim();

  const key = generateCiteKey(paper);
  const venue = paper.venue?.trim() || "";
  const entryType = isJournal(venue) ? "article" : "inproceedings";

  const fields: [string, string][] = [];

  if (paper.title) fields.push(["title", `{${escapeLatex(paper.title)}}`]);
  if (paper.authors || paper.first_author) {
    fields.push(["author", escapeLatex(paper.authors || paper.first_author)]);
  }
  if (paper.year) fields.push(["year", String(paper.year)]);

  if (entryType === "article") {
    if (venue) fields.push(["journal", escapeLatex(venue)]);
  } else {
    if (venue) fields.push(["booktitle", escapeLatex(venue)]);
  }

  if (paper.link) fields.push(["url", paper.link]);

  const body = fields
    .map(([k, v]) => `  ${k} = {${v}}`)
    .join(",\n");

  return `@${entryType}{${key},\n${body}\n}`;
}

export function papersToJson(papers: Paper[]): string {
  return JSON.stringify(papers, null, 2);
}

// Word-friendly numbered reference list
// Format: [N] Authors, "Title," Venue, Year.
export function papersToWordRefs(papers: Paper[]): string {
  return papers
    .map((p) => {
      const authors = p.authors || p.first_author || "Unknown Author";
      const title = p.title || "Untitled";
      const venue = p.venue || "";
      const year = p.year ? String(p.year) : "";
      const parts = [venue, year].filter(Boolean).join(", ");
      return `[] ${authors}, "${title},"${parts ? " " + parts : ""}.`;
    })
    .join("\n");
}

const CSV_FIELDS: (keyof Paper)[] = [
  "id", "title", "first_author", "authors", "year", "venue",
  "status", "importance", "date_read", "link",
  "summary", "differentiation", "questions", "pdf_path",
  "created_at", "updated_at",
];

function csvEscape(val: unknown): string {
  const str = val == null ? "" : String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function papersToCsv(papers: Paper[]): string {
  const header = CSV_FIELDS.join(",");
  const rows = papers.map((p) =>
    CSV_FIELDS.map((f) => csvEscape(p[f])).join(",")
  );
  return [header, ...rows].join("\n");
}
