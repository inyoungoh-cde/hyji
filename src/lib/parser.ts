import { mapVenue } from "./venueMap";

export interface ParsedPaper {
  title: string;
  authors: string;
  firstAuthor: string;
  year: number | null;
  venue: string;
  rawBibtex: string;
}

export function parseInput(input: string): ParsedPaper {
  const trimmed = input.trim();

  // BibTeX
  if (trimmed.startsWith("@")) {
    return parseBibtex(trimmed);
  }

  // arXiv ID (e.g., 2403.18913 or arXiv:2403.18913)
  const arxivMatch = trimmed.match(/(?:arxiv[:\s]*)?(\d{4}\.\d{4,5})/i);
  if (arxivMatch && trimmed.length < 30) {
    return {
      title: `arXiv:${arxivMatch[1]}`,
      authors: "",
      firstAuthor: "",
      year: parseInt(arxivMatch[1].substring(0, 2), 10) > 50
        ? 1900 + parseInt(arxivMatch[1].substring(0, 2), 10)
        : 2000 + parseInt(arxivMatch[1].substring(0, 2), 10),
      venue: "arXiv",
      rawBibtex: "",
    };
  }

  // Citation string: Author, "Title." Venue. Year.
  // or: Author et al. Title. Venue, Year.
  const citationResult = parseCitation(trimmed);
  if (citationResult.title) {
    return citationResult;
  }

  // Plain title
  return {
    title: trimmed,
    authors: "",
    firstAuthor: "",
    year: null,
    venue: "",
    rawBibtex: "",
  };
}

function parseBibtex(raw: string): ParsedPaper {
  const getField = (name: string): string => {
    const re = new RegExp(`${name}\\s*=\\s*[{"]([^}"]*)[}"]`, "i");
    const match = raw.match(re);
    return match ? match[1].replace(/\s+/g, " ").trim() : "";
  };

  const title = getField("title");
  const authors = getField("author").replace(/ and /g, ", ");
  const year = getField("year");
  const booktitle = getField("booktitle");
  const journal = getField("journal");
  const venueRaw = booktitle || journal;

  const authorList = authors.split(",").map((a) => a.trim()).filter(Boolean);
  const firstAuthor = authorList[0] ?? "";

  return {
    title,
    authors,
    firstAuthor,
    year: year ? parseInt(year, 10) : null,
    venue: mapVenue(venueRaw),
    rawBibtex: raw,
  };
}

function parseCitation(raw: string): ParsedPaper {
  // Try: Author(s). "Title." Venue, Year.
  const quotedMatch = raw.match(
    /^(.+?)\.\s*"(.+?)"\s*[.,]?\s*(.+?)[.,]?\s*(\d{4})/
  );
  if (quotedMatch) {
    const authors = quotedMatch[1].trim();
    const firstAuthor = authors.split(",")[0].trim();
    return {
      title: quotedMatch[2].trim(),
      authors,
      firstAuthor,
      year: parseInt(quotedMatch[4], 10),
      venue: mapVenue(quotedMatch[3].trim()),
      rawBibtex: "",
    };
  }

  // Try: Author(s). Title. Venue, Year.
  const plainMatch = raw.match(
    /^(.+?)\.\s+(.+?)\.\s+(.+?)[.,]\s*(\d{4})/
  );
  if (plainMatch) {
    const authors = plainMatch[1].trim();
    const firstAuthor = authors.split(",")[0].trim();
    return {
      title: plainMatch[2].trim(),
      authors,
      firstAuthor,
      year: parseInt(plainMatch[4], 10),
      venue: mapVenue(plainMatch[3].trim()),
      rawBibtex: "",
    };
  }

  // Fallback: just extract year if present
  const yearMatch = raw.match(/(\d{4})/);
  return {
    title: raw.replace(/\d{4}/, "").replace(/[.,]+$/, "").trim(),
    authors: "",
    firstAuthor: "",
    year: yearMatch ? parseInt(yearMatch[1], 10) : null,
    venue: "",
    rawBibtex: "",
  };
}
