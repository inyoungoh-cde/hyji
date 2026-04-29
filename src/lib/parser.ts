import { normalizeVenue } from "./venueMap";
import type { RefType } from "../types";

export interface ParsedPaper {
  title: string;
  authors: string;
  firstAuthor: string;
  year: number | null;
  venue: string;
  rawBibtex: string;
  refType: RefType;
  publisher: string;
  edition: string;
  chapter: string;
  pages: string;
  doi: string;
  abstract: string;
  link: string;
}

function emptyParsed(): ParsedPaper {
  return {
    title: "",
    authors: "",
    firstAuthor: "",
    year: null,
    venue: "",
    rawBibtex: "",
    refType: "article",
    publisher: "",
    edition: "",
    chapter: "",
    pages: "",
    doi: "",
    abstract: "",
    link: "",
  };
}

export function parseInput(input: string): ParsedPaper {
  const trimmed = input.trim();

  // RIS — first non-blank line begins with "TY  -"
  if (/^\s*TY\s*-\s/m.test(trimmed) && trimmed.split(/\r?\n/, 5).some((l) => /^\s*TY\s*-\s/.test(l))) {
    return parseRis(trimmed);
  }

  // BibTeX
  if (trimmed.startsWith("@")) {
    return parseBibtex(trimmed);
  }

  // arXiv ID
  const arxivMatch = trimmed.match(/(?:arxiv[:\s]*)?(\d{4}\.\d{4,5})/i);
  if (arxivMatch && trimmed.length < 30) {
    const yy = parseInt(arxivMatch[1].substring(0, 2), 10);
    return {
      ...emptyParsed(),
      title: `arXiv:${arxivMatch[1]}`,
      year: yy > 50 ? 1900 + yy : 2000 + yy,
      venue: "arXiv",
    };
  }

  // Citation string
  const citationResult = parseCitation(trimmed);
  if (citationResult.title) return citationResult;

  // Plain title
  return { ...emptyParsed(), title: trimmed };
}

const BIBTEX_TYPE_MAP: Record<string, RefType> = {
  article: "article",
  inproceedings: "inproceedings",
  conference: "inproceedings",
  book: "book",
  inbook: "inbook",
  incollection: "inbook",
  phdthesis: "phdthesis",
  mastersthesis: "mastersthesis",
  misc: "misc",
  techreport: "misc",
  unpublished: "misc",
};

function parseBibtex(raw: string): ParsedPaper {
  const getField = (name: string): string => {
    const re = new RegExp(`${name}\\s*=\\s*[{"]([^}"]*)[}"]`, "i");
    const match = raw.match(re);
    return match ? match[1].replace(/\s+/g, " ").trim() : "";
  };

  const typeMatch = raw.match(/^@(\w+)\s*\{/);
  const refType: RefType =
    BIBTEX_TYPE_MAP[(typeMatch?.[1] ?? "").toLowerCase()] ?? "article";

  const title = getField("title");
  const authors = getField("author").replace(/ and /g, ", ");
  const year = getField("year");
  const booktitle = getField("booktitle");
  const journal = getField("journal");
  const venueRaw = booktitle || journal;

  const authorList = authors.split(",").map((a) => a.trim()).filter(Boolean);
  const firstAuthor = authorList[0] ?? "";

  return {
    ...emptyParsed(),
    title,
    authors,
    firstAuthor,
    year: year ? parseInt(year, 10) : null,
    venue: normalizeVenue(venueRaw),
    rawBibtex: raw,
    refType,
    publisher: getField("publisher"),
    edition: getField("edition"),
    chapter: getField("chapter"),
    pages: getField("pages"),
    doi: getField("doi"),
    link: getField("url"),
  };
}

function parseCitation(raw: string): ParsedPaper {
  // Author(s). "Title." Venue, Year.
  const quotedMatch = raw.match(/^(.+?)\.\s*"(.+?)"\s*[.,]?\s*(.+?)[.,]?\s*(\d{4})/);
  if (quotedMatch) {
    const authors = quotedMatch[1].trim();
    return {
      ...emptyParsed(),
      title: quotedMatch[2].trim(),
      authors,
      firstAuthor: authors.split(",")[0].trim(),
      year: parseInt(quotedMatch[4], 10),
      venue: normalizeVenue(quotedMatch[3].trim()),
    };
  }

  // Author(s). Title. Venue, Year.
  const plainMatch = raw.match(/^(.+?)\.\s+(.+?)\.\s+(.+?)[.,]\s*(\d{4})/);
  if (plainMatch) {
    const authors = plainMatch[1].trim();
    return {
      ...emptyParsed(),
      title: plainMatch[2].trim(),
      authors,
      firstAuthor: authors.split(",")[0].trim(),
      year: parseInt(plainMatch[4], 10),
      venue: normalizeVenue(plainMatch[3].trim()),
    };
  }

  const yearMatch = raw.match(/(\d{4})/);
  return {
    ...emptyParsed(),
    title: raw.replace(/\d{4}/, "").replace(/[.,]+$/, "").trim(),
    year: yearMatch ? parseInt(yearMatch[1], 10) : null,
  };
}

const RIS_TYPE_MAP: Record<string, RefType> = {
  JOUR: "article",
  EJOUR: "article",
  MGZN: "article",
  NEWS: "article",
  BOOK: "book",
  EBOOK: "book",
  CHAP: "inbook",
  ECHAP: "inbook",
  THES: "phdthesis",
  CONF: "inproceedings",
  CPAPER: "inproceedings",
  GEN: "misc",
  RPRT: "misc",
  UNPB: "misc",
};

export function parseRis(raw: string): ParsedPaper {
  const lines = raw.split(/\r?\n/);
  const fields = new Map<string, string[]>();

  for (const rawLine of lines) {
    const line = rawLine.replace(/﻿/g, "");
    const m = line.match(/^([A-Z0-9]{2})\s*-\s*(.*)$/);
    if (!m) continue;
    const tag = m[1];
    const value = m[2].trim();
    if (!fields.has(tag)) fields.set(tag, []);
    if (value) fields.get(tag)!.push(value);
  }

  const first = (tag: string): string => fields.get(tag)?.[0] ?? "";
  const all = (tag: string): string[] => fields.get(tag) ?? [];

  // Reference type
  const ty = first("TY").toUpperCase();
  let refType: RefType = RIS_TYPE_MAP[ty] ?? "article";

  // Distinguish phdthesis vs mastersthesis if M3 hints
  if (refType === "phdthesis") {
    const m3 = first("M3").toLowerCase();
    if (m3.includes("master")) refType = "mastersthesis";
  }

  // Authors: AU lines (also A1/A2 fallback)
  const auList = all("AU").length > 0 ? all("AU") : all("A1");
  const authors = auList.join(", ");
  const firstAuthor = auList[0] ?? "";

  // Title: TI > T1 > BT
  const title = first("TI") || first("T1") || first("BT");

  // Venue: JO > JF > T2 > BT (for book chapter, BT is the book title)
  const venueRaw = first("JO") || first("JF") || first("T2") || (refType === "inbook" ? first("BT") : "");

  // Year
  const py = first("PY") || first("Y1") || first("DA");
  const yearMatch = py.match(/\d{4}/);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : null;

  // Pages: SP - EP, or single SP
  const sp = first("SP");
  const ep = first("EP");
  const pages = sp && ep ? `${sp}-${ep}` : sp || "";

  return {
    title,
    authors,
    firstAuthor,
    year,
    venue: normalizeVenue(venueRaw),
    rawBibtex: "",
    refType,
    publisher: first("PB"),
    edition: first("ET"),
    chapter: first("CN"),
    pages,
    doi: first("DO") || first("DOI"),
    abstract: first("AB") || first("N2"),
    link: first("UR") || first("L1"),
  };
}
