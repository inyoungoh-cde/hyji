import venuesData from "./venues.json";

export type VenueFormat = "full" | "abbr" | "abbr_nodots" | "code";

interface VenueEntry {
  full: string;
  abbr: string;
  abbr_nodots: string;
  code: string;
}

const venues = (venuesData as { venues: VenueEntry[] }).venues;

const byFull = new Map<string, VenueEntry>();
const byAbbr = new Map<string, VenueEntry>();
const byAbbrNoDots = new Map<string, VenueEntry>();
const byCode = new Map<string, VenueEntry>();

for (const v of venues) {
  byFull.set(v.full.toLowerCase(), v);
  byAbbr.set(v.abbr.toLowerCase(), v);
  byAbbrNoDots.set(v.abbr_nodots.toLowerCase(), v);
  byCode.set(v.code.toLowerCase(), v);
}

function lookup(input: string): VenueEntry | null {
  const key = input.toLowerCase().trim();
  if (!key) return null;
  return (
    byFull.get(key) ||
    byAbbr.get(key) ||
    byAbbrNoDots.get(key) ||
    byCode.get(key) ||
    null
  );
}

export function formatVenue(input: string, format: VenueFormat): string {
  const entry = lookup(input);
  if (!entry) return input.trim();
  return entry[format];
}

export function normalizeVenue(input: string): string {
  return formatVenue(input, "full");
}

// Backward-compatible: old callers want the short code when known,
// otherwise pass the input through. Used by parser.ts.
export function mapVenue(raw: string): string {
  const entry = lookup(raw);
  if (entry) return entry.code;

  // Partial substring match on the full name (legacy behavior)
  const lower = raw.toLowerCase();
  for (const [key, v] of byFull) {
    if (lower.includes(key)) return v.code;
  }
  return raw.trim();
}
