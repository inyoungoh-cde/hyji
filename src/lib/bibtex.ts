import type { Paper, RefType } from "../types";
import { formatVenue, type VenueFormat } from "./venueMap";

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
// Used only when ref_type is missing.
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

function inferRefType(paper: Paper): RefType {
  if (paper.ref_type) return paper.ref_type;
  return isJournal(paper.venue || "") ? "article" : "inproceedings";
}

export interface BibTeXOptions {
  venueFormat?: VenueFormat;
}

export function generateBibTeX(paper: Paper, options: BibTeXOptions = {}): string {
  if (paper.raw_bibtex?.trim()) return paper.raw_bibtex.trim();

  const key = generateCiteKey(paper);
  const refType = inferRefType(paper);
  const venueFormat = options.venueFormat ?? "full";
  const venue = paper.venue ? formatVenue(paper.venue, venueFormat) : "";

  const fields: [string, string][] = [];

  if (paper.title) fields.push(["title", escapeLatex(paper.title)]);
  if (paper.authors || paper.first_author) {
    fields.push(["author", escapeLatex(paper.authors || paper.first_author)]);
  }
  if (paper.year) fields.push(["year", String(paper.year)]);

  // Venue field varies by type
  switch (refType) {
    case "article":
      if (venue) fields.push(["journal", escapeLatex(venue)]);
      break;
    case "inproceedings":
      if (venue) fields.push(["booktitle", escapeLatex(venue)]);
      break;
    case "inbook":
      if (venue) fields.push(["booktitle", escapeLatex(venue)]);
      if (paper.chapter) fields.push(["chapter", escapeLatex(paper.chapter)]);
      if (paper.publisher) fields.push(["publisher", escapeLatex(paper.publisher)]);
      if (paper.edition) fields.push(["edition", escapeLatex(paper.edition)]);
      break;
    case "book":
      if (paper.publisher) fields.push(["publisher", escapeLatex(paper.publisher)]);
      if (paper.edition) fields.push(["edition", escapeLatex(paper.edition)]);
      break;
    case "phdthesis":
    case "mastersthesis":
      if (venue) fields.push(["school", escapeLatex(venue)]);
      break;
    case "misc":
      if (venue) fields.push(["howpublished", escapeLatex(venue)]);
      break;
  }

  if (paper.pages) fields.push(["pages", paper.pages.replace(/-/g, "--")]);
  if (paper.doi) fields.push(["doi", paper.doi]);
  if (paper.link) fields.push(["url", paper.link]);

  const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n");
  return `@${refType}{${key},\n${body}\n}`;
}

export function papersToJson(papers: Paper[]): string {
  return JSON.stringify(papers, null, 2);
}

// Word-friendly numbered reference list (legacy fallback — superseded by Export dialog)
export function papersToWordRefs(papers: Paper[]): string {
  return papers
    .map((p, i) => {
      const authors = p.authors || p.first_author || "Unknown Author";
      const title = p.title || "Untitled";
      const venue = p.venue || "";
      const year = p.year ? String(p.year) : "";
      const parts = [venue, year].filter(Boolean).join(", ");
      return `[${i + 1}] ${authors}, "${title},"${parts ? " " + parts : ""}.`;
    })
    .join("\n");
}

const CSV_FIELDS: (keyof Paper)[] = [
  "id", "title", "first_author", "authors", "year", "venue",
  "ref_type", "publisher", "edition", "chapter", "pages", "doi",
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
