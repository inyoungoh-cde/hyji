import { formatVenue, type VenueFormat } from "./venueMap";
import type { Paper, RefType } from "../types";

// Mirror of parser.ts RIS_TYPE_MAP, reversed for export.
const RIS_TY: Record<RefType, string> = {
  article: "JOUR",
  inproceedings: "CONF",
  book: "BOOK",
  inbook: "CHAP",
  phdthesis: "THES",
  mastersthesis: "THES",
  misc: "GEN",
};

export interface RisOptions {
  venueFormat?: VenueFormat;
}

// The papers table stores authors as one display string; BibTeX imports were
// stored with " and " already replaced by ", ", which makes "Last, First"
// pairs ambiguous. The original BibTeX is preserved verbatim, so recover the
// unambiguous author list from raw_bibtex when available.
function splitAuthors(p: Paper): string[] {
  if (p.raw_bibtex) {
    const m = p.raw_bibtex.match(/author\s*=\s*[{"]([^}"]*)[}"]/i);
    if (m) {
      return m[1]
        .split(/\s+and\s+/i)
        .map((a) => a.replace(/\s+/g, " ").trim())
        .filter(Boolean);
    }
  }
  const a = p.authors || "";
  if (/\sand\s/i.test(a)) {
    return a.split(/\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  }
  return a.split(",").map((s) => s.trim()).filter(Boolean);
}

export function paperToRis(p: Paper, opts: RisOptions = {}): string {
  const lines: string[] = [];
  const add = (tag: string, value?: string | number | null) => {
    // RIS is line-oriented: internal newlines would break the record,
    // so collapse all whitespace runs (abstracts often contain \n).
    const s = String(value ?? "").replace(/\s+/g, " ").trim();
    if (s) lines.push(`${tag}  - ${s}`);
  };

  lines.push(`TY  - ${RIS_TY[p.ref_type] ?? "GEN"}`);
  if (p.ref_type === "mastersthesis") add("M3", "Master's Thesis");

  for (const au of splitAuthors(p)) add("AU", au);

  add("TI", p.title);

  const venue = p.venue ? formatVenue(p.venue, opts.venueFormat ?? "full") : "";
  if (venue) {
    // JO for journals (parser reads JO first), BT for book chapters, T2 otherwise
    if (p.ref_type === "article") add("JO", venue);
    else if (p.ref_type === "inbook") add("BT", venue);
    else add("T2", venue);
  }

  add("PY", p.year);

  if (p.pages) {
    const [sp, ep] = p.pages.split(/[-–—]+/).map((s) => s.trim());
    add("SP", sp);
    add("EP", ep);
  }

  add("PB", p.publisher);
  add("ET", p.edition);
  add("CN", p.chapter);
  add("DO", p.doi);
  add("AB", p.abstract_text);
  add("UR", p.link);

  lines.push("ER  - ");
  return lines.join("\n");
}

export function papersToRis(papers: Paper[], opts: RisOptions = {}): string {
  return papers.map((p) => paperToRis(p, opts)).join("\n\n") + "\n";
}
