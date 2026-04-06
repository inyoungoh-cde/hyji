const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "for", "to", "and", "or", "but",
  "with", "via", "from", "by", "is", "are", "was", "be", "as", "its", "it",
  "this", "that", "we", "our", "their", "using", "based", "towards", "through",
  "across", "into", "over", "under", "new", "novel", "efficient", "effective",
  "fast", "deep", "large", "scale", "end", "real", "high", "low", "multi",
  "single", "joint", "unified", "learning", "approach", "method", "framework",
  "model", "network", "system", "task", "paper", "work", "study", "analysis",
  "evaluation", "performance", "show", "propose", "present", "achieve",
  "demonstrate", "improve", "state", "art",
]);

// Remove parenthetical content: "3D Gaussian Splatting (3DGS)" → "3D Gaussian Splatting"
function removeParentheticals(text: string): string {
  return text.replace(/\s*\([^)]*\)/g, "").trim();
}

// Reject math notation: "I : Set of all...", "S_CR", isolated short tokens
function looksLikeNotation(s: string): boolean {
  return (
    /[=:]/.test(s) ||              // contains = or :
    /^[A-Za-z_]{1,4}$/.test(s) || // single short token (abbreviation)
    /^\d/.test(s)                  // starts with digit
  );
}

// Parse keywords from BibTeX keywords field (split by ; or ,)
export function extractFromBibTeX(bibtex: string): string[] {
  if (!bibtex) return [];
  const match = bibtex.match(/keywords\s*=\s*\{([^}]+)\}/i);
  if (!match) return [];

  return match[1]
    .split(/[;,]/)
    .map((k) => removeParentheticals(k.trim()))
    .filter((k) => k.length >= 2 && k.length <= 50)
    .filter((k) => !looksLikeNotation(k))
    .slice(0, 10);
}

// Parse keywords from a raw string (PDF metadata or PDF keywords section)
// Truncates early to prevent capturing the next section's text
export function parseKeywordString(raw: string): string[] {
  if (!raw) return [];
  const truncated = raw.slice(0, 350);
  const sep = truncated.includes(";") ? ";" : ",";
  return truncated
    .split(sep)
    .map((k) => removeParentheticals(k.trim()))
    .filter((k) => k.length >= 2 && k.length <= 50)
    .filter((k) => !looksLikeNotation(k))
    .slice(0, 10);
}

// Title-based extraction fallback
export function extractFromTitle(title: string): string[] {
  if (!title) return [];

  const cleaned = removeParentheticals(title);
  const words = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  const seen = new Set<string>();
  const result: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      result.push(w);
    }
  }
  return result.slice(0, 8);
}

// Main entry: bibtex first, then title fallback
export function extractKeywords(title: string, rawBibTeX?: string): string[] {
  if (rawBibTeX) {
    const fromBib = extractFromBibTeX(rawBibTeX);
    if (fromBib.length > 0) return fromBib;
  }
  return extractFromTitle(title);
}
