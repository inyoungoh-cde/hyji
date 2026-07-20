import { invoke } from "@tauri-apps/api/core";
import * as pdfjsLib from "pdfjs-dist";
import { readFile } from "@tauri-apps/plugin-fs";
import { PDFJS_ASSET_OPTIONS } from "./pdfjsAssets";
import { normalizeVenue } from "./venueMap";
import { useNetworkStore } from "../stores/network";
import type { Paper, RefType } from "../types";

/** Hard stop below the UI layer so no code path can fetch while offline mode is on. */
function assertOnlineAllowed(): void {
  if (useNetworkStore.getState().offlineMode) {
    throw new Error("Offline mode is on — online lookups are disabled (Tools → Preferences… → Network & privacy).");
  }
}

/**
 * Online metadata lookup (v1.0.5). Zotero-style "retrieve metadata":
 * extract a DOI / arXiv id from the PDF's first pages, then query
 * Crossref (best for journals/conferences) falling back to the arXiv API.
 * HTTP goes through the Rust `http_get_text` command — the WebView blocks
 * arXiv via CORS and Crossref's polite pool wants a proper User-Agent.
 */
export interface FetchedMetadata {
  source: "crossref" | "arxiv";
  title: string;
  authors: string;
  firstAuthor: string;
  year: number | null;
  venue: string;
  refType: RefType;
  publisher: string;
  pages: string;
  doi: string;
  abstract: string;
  link: string;
}

export interface Identifiers {
  doi: string | null;
  arxivId: string | null;
}

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;
const ARXIV_RE = /arxiv[:\s]*([0-9]{4}\.[0-9]{4,5})(v\d+)?/i;

function cleanDoi(raw: string): string {
  return raw
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/[.,;)\]]+$/, "")
    .trim();
}

/** Pull a DOI / arXiv id from the first two pages of the paper's PDF. */
export async function extractIdentifiersFromPdf(pdfPath: string): Promise<Identifiers> {
  const bytes = await readFile(pdfPath);
  const doc = await pdfjsLib.getDocument({ data: bytes, ...PDFJS_ASSET_OPTIONS }).promise;
  let text = "";
  try {
    const pages = Math.min(2, doc.numPages);
    for (let p = 1; p <= pages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      for (const item of content.items) {
        if ("str" in item) text += (item as { str: string }).str + " ";
      }
    }
  } finally {
    await doc.destroy().catch(() => undefined);
  }
  const doiMatch = text.match(DOI_RE);
  const arxivMatch = text.match(ARXIV_RE);
  return {
    doi: doiMatch ? cleanDoi(doiMatch[1]) : null,
    arxivId: arxivMatch ? arxivMatch[1] : null,
  };
}

const CROSSREF_TYPE: Record<string, RefType> = {
  "journal-article": "article",
  "proceedings-article": "inproceedings",
  "book": "book",
  "monograph": "book",
  "edited-book": "book",
  "book-chapter": "inbook",
  "book-section": "inbook",
  "dissertation": "phdthesis",
  "report": "misc",
  "posted-content": "misc", // preprints
};

function stripJats(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function fetchFromCrossref(doi: string): Promise<FetchedMetadata> {
  assertOnlineAllowed();
  const body = await invoke<string>("http_get_text", {
    url: `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
  });
  const m = JSON.parse(body).message;

  const authorsArr: string[] = (m.author ?? []).map((a: { given?: string; family?: string; name?: string }) =>
    a.name ?? [a.given, a.family].filter(Boolean).join(" ")
  ).filter(Boolean);
  const year =
    m.issued?.["date-parts"]?.[0]?.[0] ??
    m["published-print"]?.["date-parts"]?.[0]?.[0] ??
    m["published-online"]?.["date-parts"]?.[0]?.[0] ??
    null;

  return {
    source: "crossref",
    title: (m.title?.[0] ?? "").replace(/\s+/g, " ").trim(),
    authors: authorsArr.join(", "),
    firstAuthor: authorsArr[0] ?? "",
    year: typeof year === "number" ? year : null,
    venue: normalizeVenue(m["container-title"]?.[0] ?? ""),
    refType: CROSSREF_TYPE[m.type as string] ?? "article",
    publisher: m.publisher ?? "",
    pages: m.page ?? "",
    doi: m.DOI ?? doi,
    abstract: m.abstract ? stripJats(m.abstract) : "",
    link: m.URL ?? `https://doi.org/${doi}`,
  };
}

export async function fetchFromArxiv(arxivId: string): Promise<FetchedMetadata> {
  assertOnlineAllowed();
  const body = await invoke<string>("http_get_text", {
    url: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`,
  });
  const xml = new DOMParser().parseFromString(body, "text/xml");
  const entry = xml.querySelector("entry");
  if (!entry || !entry.querySelector("title")) {
    throw new Error(`arXiv returned no entry for ${arxivId}`);
  }
  const text = (sel: string) => entry.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const authors = Array.from(entry.querySelectorAll("author > name"))
    .map((n) => n.textContent?.trim() ?? "")
    .filter(Boolean);
  const published = text("published");
  const doiEl = entry.getElementsByTagName("arxiv:doi")[0]?.textContent?.trim() ?? "";

  return {
    source: "arxiv",
    title: text("title"),
    authors: authors.join(", "),
    firstAuthor: authors[0] ?? "",
    year: published ? parseInt(published.slice(0, 4), 10) : null,
    venue: "arXiv",
    refType: "misc",
    publisher: "",
    pages: "",
    doi: doiEl,
    abstract: text("summary"),
    link: `https://arxiv.org/abs/${arxivId}`,
  };
}

/**
 * Full lookup for a paper: use its DOI field if present, otherwise scan the
 * PDF for identifiers; query Crossref first, arXiv as fallback.
 */
export async function fetchMetadataForPaper(paper: Paper): Promise<FetchedMetadata> {
  let doi = paper.doi?.trim() ? cleanDoi(paper.doi.trim()) : null;
  let arxivId: string | null = null;

  if (!doi && paper.pdf_path) {
    const ids = await extractIdentifiersFromPdf(paper.pdf_path);
    doi = ids.doi;
    arxivId = ids.arxivId;
  }
  if (!doi && !arxivId) {
    // Last resort: an arXiv id hiding in the title (Smart Paste arXiv entries)
    const m = paper.title.match(ARXIV_RE);
    if (m) arxivId = m[1];
  }
  if (!doi && !arxivId) {
    throw new Error(
      "No DOI or arXiv ID found in this paper's metadata or the first pages of its PDF."
    );
  }

  if (doi) {
    try {
      return await fetchFromCrossref(doi);
    } catch (e) {
      if (!arxivId) throw new Error(`Crossref lookup failed for ${doi}: ${String(e)}`);
    }
  }
  return fetchFromArxiv(arxivId!);
}
