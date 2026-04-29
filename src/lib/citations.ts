import type { Paper } from "../types";
import { formatVenue, type VenueFormat } from "./venueMap";

export type CitationStyle = "ieee" | "acs" | "nature" | "apa" | "mla";

export interface CitationOptions {
  style: CitationStyle;
  startFrom: number;
  noNumbers: boolean;
  venueFormat: VenueFormat;
}

interface ParsedAuthor {
  firstName: string;   // "Tianjun" or "T."
  lastName: string;    // "Zhang"
  initials: string;    // "T." (each given name -> initial+dot, joined by space)
}

function parseAuthor(raw: string): ParsedAuthor {
  const s = raw.trim();
  if (!s) return { firstName: "", lastName: "", initials: "" };

  // "Last, First Middle"
  if (s.includes(",")) {
    const [lastRaw, firstRaw = ""] = s.split(",", 2).map((p) => p.trim());
    return build(firstRaw, lastRaw);
  }
  // "First Middle Last" — assume last token is the surname
  const parts = s.split(/\s+/);
  if (parts.length === 1) return build("", parts[0]);
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(" ");
  return build(first, last);
}

function build(first: string, last: string): ParsedAuthor {
  const initials = first
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => `${p[0].toUpperCase()}.`)
    .join(" ");
  return { firstName: first, lastName: last, initials };
}

function splitAuthors(authors: string): ParsedAuthor[] {
  if (!authors.trim()) return [];
  // Heuristic: if string contains " and ", treat as BibTeX-style separator first
  let parts: string[];
  if (/ and /i.test(authors)) {
    parts = authors.split(/\s+and\s+/i);
  } else {
    parts = authors.split(",");
    // If we got pairs like "Last, First, Last, First", merge back
    // by checking if even-indexed parts look like surnames (no spaces -> no first name)
    if (parts.length >= 2 && parts.length % 2 === 0) {
      const looksLikeLastFirst = parts.every((p, i) =>
        i % 2 === 0 ? !/\s/.test(p.trim()) : true
      );
      if (looksLikeLastFirst) {
        const merged: string[] = [];
        for (let i = 0; i < parts.length; i += 2) {
          merged.push(`${parts[i].trim()}, ${parts[i + 1].trim()}`);
        }
        parts = merged;
      }
    }
  }
  return parts.map((p) => parseAuthor(p)).filter((a) => a.lastName);
}

// Sentence case: lowercase the title but preserve all-caps tokens (acronyms)
// and capitalize the first letter. Also preserve proper-noun-looking words
// (those with internal capital letters like "iPhone", "NeRF").
function toSentenceCase(title: string): string {
  if (!title) return "";
  const tokens = title.split(/(\s+|[-:;,])/);
  let firstWordSeen = false;
  return tokens
    .map((tok) => {
      if (!/[A-Za-z]/.test(tok)) return tok;
      const isAllCaps = tok.length > 1 && tok === tok.toUpperCase();
      const hasInternalCaps = /[A-Z]/.test(tok.slice(1));
      if (isAllCaps || hasInternalCaps) {
        // Preserve acronyms / proper nouns / mixed-case names
        if (!firstWordSeen) firstWordSeen = true;
        return tok;
      }
      const lower = tok.toLowerCase();
      if (!firstWordSeen) {
        firstWordSeen = true;
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      }
      return lower;
    })
    .join("");
}

// IEEE: [1] T. Zhang, F. Zhang, T. Deng, L. Zhang, and H. Wang, "Title," Venue, 2026.
function formatIEEE(p: Paper, prefix: string, venueFmt: VenueFormat): string {
  const authors = splitAuthors(p.authors || p.first_author);
  const authorStr =
    authors.length === 0
      ? "Unknown"
      : authors.length === 1
        ? `${authors[0].initials} ${authors[0].lastName}`.trim()
        : authors.length === 2
          ? `${authors[0].initials} ${authors[0].lastName}, and ${authors[1].initials} ${authors[1].lastName}`.replace(/\s+/g, " ")
          : (() => {
              const head = authors.slice(0, -1).map((a) => `${a.initials} ${a.lastName}`.trim()).join(", ");
              const tail = authors[authors.length - 1];
              return `${head}, and ${tail.initials} ${tail.lastName}`.replace(/\s+/g, " ");
            })();

  const venue = p.venue ? formatVenue(p.venue, venueFmt) : "";
  const title = p.title || "";
  const year = p.year ?? "";
  const parts = [`${prefix}${authorStr}`];
  if (title) parts.push(`"${title},"`);
  const tail: string[] = [];
  if (venue) tail.push(venue);
  if (year) tail.push(String(year));
  return `${parts.join(" ")}${tail.length ? " " + tail.join(", ") : ""}.`;
}

// ACS: (1) Zhang, T.; Zhang, F.; ... Wang, H. Title. Venue Year.
function formatACS(p: Paper, prefix: string, venueFmt: VenueFormat): string {
  const authors = splitAuthors(p.authors || p.first_author);
  const authorStr = authors
    .map((a) => `${a.lastName}, ${a.initials}`.trim())
    .join("; ");
  const venue = p.venue ? formatVenue(p.venue, venueFmt) : "";
  const title = p.title || "";
  const year = p.year ?? "";
  let s = `${prefix}${authorStr}`;
  if (title) s += `. ${title}`;
  if (venue) s += `. ${venue}`;
  if (year) s += ` ${year}`;
  return `${s}.`;
}

// Nature: 1. Zhang, T. et al. Title. Venue (Year).
function formatNature(p: Paper, prefix: string, venueFmt: VenueFormat): string {
  const authors = splitAuthors(p.authors || p.first_author);
  let authorStr = "";
  if (authors.length === 0) authorStr = "Unknown";
  else if (authors.length === 1) authorStr = `${authors[0].lastName}, ${authors[0].initials}`.trim();
  else authorStr = `${authors[0].lastName}, ${authors[0].initials} et al.`.trim();

  const title = p.title ? toSentenceCase(p.title) : "";
  const venue = p.venue ? formatVenue(p.venue, venueFmt) : "";
  const year = p.year ?? "";
  let s = `${prefix}${authorStr}`;
  if (title) s += `. ${title}`;
  if (venue) s += `. ${venue}`;
  if (year) s += ` (${year})`;
  return `${s}.`;
}

// APA: Zhang, T., Zhang, F., ..., & Wang, H. (Year). Title. Venue.
function formatAPA(p: Paper, prefix: string, venueFmt: VenueFormat): string {
  const authors = splitAuthors(p.authors || p.first_author);
  let authorStr = "";
  if (authors.length === 0) authorStr = "Unknown";
  else if (authors.length === 1) authorStr = `${authors[0].lastName}, ${authors[0].initials}`.trim();
  else if (authors.length === 2)
    authorStr = `${authors[0].lastName}, ${authors[0].initials}, & ${authors[1].lastName}, ${authors[1].initials}`;
  else {
    const head = authors.slice(0, -1).map((a) => `${a.lastName}, ${a.initials}`.trim()).join(", ");
    const tail = authors[authors.length - 1];
    authorStr = `${head}, & ${tail.lastName}, ${tail.initials}`.trim();
  }

  const title = p.title ? toSentenceCase(p.title) : "";
  const venue = p.venue ? formatVenue(p.venue, venueFmt) : "";
  const year = p.year ?? "";
  let s = `${prefix}${authorStr}`;
  if (year) s += ` (${year})`;
  if (title) s += `. ${title}`;
  if (venue) s += `. ${venue}`;
  return `${s}.`;
}

// MLA: Zhang, Tianjun, et al. "Title." Venue (Year).
function formatMLA(p: Paper, prefix: string, venueFmt: VenueFormat): string {
  const authors = splitAuthors(p.authors || p.first_author);
  let authorStr = "";
  if (authors.length === 0) authorStr = "Unknown";
  else if (authors.length === 1) authorStr = `${authors[0].lastName}, ${authors[0].firstName}`.trim();
  else if (authors.length === 2)
    authorStr = `${authors[0].lastName}, ${authors[0].firstName}, and ${authors[1].firstName} ${authors[1].lastName}`.replace(/\s+/g, " ");
  else
    authorStr = `${authors[0].lastName}, ${authors[0].firstName}, et al.`.replace(/\s+/g, " ");

  const venue = p.venue ? formatVenue(p.venue, venueFmt) : "";
  const title = p.title || "";
  const year = p.year ?? "";
  let s = `${prefix}${authorStr}`;
  if (title) s += `. "${title}."`;
  if (venue) s += ` ${venue}`;
  if (year) s += ` (${year})`;
  return `${s}.`;
}

// Determine if the style is alphabetical (no numbering by default)
export const ALPHABETICAL_STYLES = new Set<CitationStyle>(["apa", "mla"]);

function makePrefix(
  index: number,
  startFrom: number,
  style: CitationStyle,
  noNumbers: boolean
): string {
  if (noNumbers) return "";
  if (ALPHABETICAL_STYLES.has(style)) return "";
  const n = startFrom + index;
  switch (style) {
    case "ieee":   return `[${n}] `;
    case "acs":    return `(${n}) `;
    case "nature": return `${n}. `;
    default:       return "";
  }
}

function sortForStyle(papers: Paper[], style: CitationStyle): Paper[] {
  if (!ALPHABETICAL_STYLES.has(style)) return papers;
  return [...papers].sort((a, b) => {
    const al = (splitAuthors(a.authors || a.first_author)[0]?.lastName ?? "").toLowerCase();
    const bl = (splitAuthors(b.authors || b.first_author)[0]?.lastName ?? "").toLowerCase();
    return al.localeCompare(bl);
  });
}

export function formatPaperAsCitation(p: Paper, idx: number, opts: CitationOptions): string {
  const prefix = makePrefix(idx, opts.startFrom, opts.style, opts.noNumbers);
  switch (opts.style) {
    case "ieee":   return formatIEEE(p, prefix, opts.venueFormat);
    case "acs":    return formatACS(p, prefix, opts.venueFormat);
    case "nature": return formatNature(p, prefix, opts.venueFormat);
    case "apa":    return formatAPA(p, prefix, opts.venueFormat);
    case "mla":    return formatMLA(p, prefix, opts.venueFormat);
  }
}

export function papersToCitations(papers: Paper[], opts: CitationOptions): string {
  const sorted = sortForStyle(papers, opts.style);
  return sorted.map((p, i) => formatPaperAsCitation(p, i, opts)).join("\n");
}
