import venuesData from "./venues.json";

export type VenueFormat = "full" | "abbr" | "abbr_nodots" | "code";

interface VenueEntry {
  full: string;
  abbr: string;
  abbr_nodots: string;
  code: string;
  aliases?: string[];
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

// ── Citation venue matching (used by citeParse.ts) ─────────────────────────
// Separate from `lookup` above so formatVenue/normalizeVenue/mapVenue keep
// their exact-match behavior. Reference lists spell venues every which way
// ("Proc. IEEE/CVF Conf. Comput. Vis. Pattern Recog.", "In Proceedings of the
// 19th European Conference on …", "ACM Trans. on Graphics (SIGGRAPH)"), so
// both sides are reduced to content-word tokens and compared with ISO-4-style
// prefix equivalence (comput ≈ computer, j ≈ journal).

export interface VenueMatch {
  code: string;
  full: string;
  abbr: string;
  via: "arxiv" | "exact" | "tokens" | "prefix" | "acronym" | "code" | "subsequence" | "relaxed";
  workshop: boolean;
}

const STOPWORDS = new Set(["of", "the", "on", "and", "in", "for", "a", "an", "to", "at", "with", "its", "de"]);
const NOISE_TOKENS = new Set([
  "proceedings", "proc", "ieee", "cvf", "acm", "rsj", "iapr", "papers", "paper", "annual", "part", "pp", "vol", "abstracts", "abstr",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);
const WORKSHOP_RE = /\b(?:workshops?|worksh|wkshp|wksp|workshp)\b\.?/gi;
const ORDINAL_WORD =
  "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth)";
const ORDINAL_RE = new RegExp(
  `\\b(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\\s-]?)?${ORDINAL_WORD}\\b|\\b\\d+(?:st|nd|rd|th)\\b`,
  "gi",
);
const VENUE_WORDS = new Set([
  "international", "journal", "conference", "transactions", "symposium", "letters", "review", "reviews",
  "magazine", "national", "joint", "european", "asian", "american", "workshop", "trans", "j", "int", "symp",
]);
const TOKEN_ALIASES: Record<string, string> = {
  intl: "international", natl: "national", jt: "joint", nips: "neurips", conf: "conference",
};

function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036F]/g, "");
}

/** Content-word tokens of a venue string (lowercase, no stopwords/org names/years/ordinals). */
export function venueTokens(raw: string): string[] {
  const s = stripDiacritics(raw)
    .replace(/[®™©]/g, " ")
    .replace(/\bint['’]l\b/gi, "international")
    .replace(/&/g, " and ")
    .replace(/\bconference papers\b|\btechnical papers\b/gi, " ")
    .replace(ORDINAL_RE, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  const out: string[] = [];
  for (const raw of s.split(" ")) {
    if (!raw || /^\d+$/.test(raw)) continue;
    const t = TOKEN_ALIASES[raw] ?? raw;
    if (STOPWORDS.has(t) || NOISE_TOKENS.has(t)) continue;
    out.push(t);
  }
  return out;
}

function tokMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 3 || s === "j" || s === "br" || s === "am") return l.startsWith(s);
  return false;
}

interface IndexedKey {
  tokens: string[];
  entry: VenueEntry;
}
const tokenKeys: IndexedKey[] = [];
const exactTokenMap = new Map<string, VenueEntry>();
const codeCaseMap = new Map<string, VenueEntry>(); // exact-case code / short alias → entry
const byCodeExact = new Map<string, VenueEntry>();

for (const v of venues) {
  const seen = new Set<string>();
  for (const k of [v.full, v.abbr, v.abbr_nodots, ...(v.aliases ?? [])]) {
    const toks = venueTokens(k);
    const j = toks.join(" ");
    if (!j || seen.has(j)) continue;
    seen.add(j);
    tokenKeys.push({ tokens: toks, entry: v });
    if (!exactTokenMap.has(j)) exactTokenMap.set(j, v);
  }
  if (!byCodeExact.has(v.code)) byCodeExact.set(v.code, v);
  for (const c of [v.code, ...(v.aliases ?? [])]) {
    // acronym-like only: "Nature", "Science", "Sensors" are ordinary words inside other names
    const acronymish = (c.match(/[A-Z0-9]/g) ?? []).length >= 2;
    if (acronymish && c.length <= 14 && c.split(/\s+/).length <= 2 && !codeCaseMap.has(c)) {
      codeCaseMap.set(c, v);
    }
  }
}
const arxivEntry = byCodeExact.get("arXiv") ?? null;

function asMatch(v: VenueEntry, via: VenueMatch["via"], workshop: boolean): VenueMatch {
  if (workshop && !/W$|Workshops?$/.test(v.code)) {
    const w = byCodeExact.get(`${v.code}W`);
    if (w) return { code: w.code, full: w.full, abbr: w.abbr, via, workshop };
    return { code: `${v.code} Workshop`, full: `${v.full} Workshops`, abbr: `${v.abbr} Workshops`, via, workshop };
  }
  return { code: v.code, full: v.full, abbr: v.abbr, via, workshop };
}

function codeTokenScan(text: string): VenueEntry | null {
  const toks = text.match(/[A-Za-z][A-Za-z0-9&-]*[A-Za-z0-9]/g) ?? [];
  for (let i = 0; i + 1 < toks.length; i++) {
    const v = codeCaseMap.get(`${toks[i]} ${toks[i + 1]}`);
    if (v) return v;
  }
  for (const t of toks) {
    if (t.length < 3) continue;
    const v = codeCaseMap.get(t);
    if (v) return v;
  }
  return null;
}

/** Match free-form venue text from a reference entry against venues.json. */
export function matchVenue(raw: string): VenueMatch | null {
  let text = raw.replace(/\s+/g, " ").trim().replace(/^in:?\s+/i, "").replace(/[\s.,;:]+$/, "");
  if (!text) return null;
  if (arxivEntry && /arxiv|\bcorr\b/i.test(text)) return asMatch(arxivEntry, "arxiv", false);

  const legacy = lookup(text);
  if (legacy) return asMatch(legacy, "exact", false);

  WORKSHOP_RE.lastIndex = 0;
  const workshop = WORKSHOP_RE.test(text);
  WORKSHOP_RE.lastIndex = 0;
  if (workshop) text = text.replace(WORKSHOP_RE, " ");
  const hints = [...text.matchAll(/\(([^()]{1,40})\)/g)].map((m) => m[1].trim());
  const base = text.replace(/\([^()]*\)/g, " ");
  const toks = venueTokens(base);
  const joined = toks.join(" ");

  const exact = joined ? exactTokenMap.get(joined) : undefined;
  // a lone short token must appear in the code's own casing ("AI", "PR", "IV" are words too)
  if (exact && (toks.length > 1 || toks[0].length > 3 || base.includes(exact.code))) {
    return asMatch(exact, "tokens", workshop);
  }

  if (toks.length >= 2) {
    let best: { v: VenueEntry; score: number } | null = null;
    for (const k of tokenKeys) {
      if (k.tokens.length !== toks.length) continue;
      let ok = true;
      let score = 0;
      for (let i = 0; i < toks.length; i++) {
        if (!tokMatch(toks[i], k.tokens[i])) {
          ok = false;
          break;
        }
        if (toks[i] === k.tokens[i]) score++;
      }
      if (ok && (!best || score > best.score)) best = { v: k.entry, score };
    }
    if (best) return asMatch(best.v, "prefix", workshop);
  }

  for (const h of hints) {
    const v = codeCaseMap.get(h) ?? codeTokenScan(h);
    if (v) return asMatch(v, "acronym", workshop);
  }

  if (toks.length >= 3) {
    // a known name at the END of the text, after junk that is not itself venue
    // vocabulary ("Proceed- … ings of the IEEE Conference on …", "Eurographics/ACM
    // SIGGRAPH Symposium on Geometry Processing"); trailing extras are never
    // allowed — "… Computer Aided Design and Computer Graphics" is not ICCAD.
    let best: { v: VenueEntry; len: number } | null = null;
    for (const k of tokenKeys) {
      const n = k.tokens.length;
      if (n < 3 || n >= toks.length || toks.length - n > 3) continue;
      const s = toks.length - n;
      if (toks.slice(0, s).some((t) => VENUE_WORDS.has(t))) continue;
      if (k.tokens.every((t, i) => tokMatch(toks[s + i], t)) && (!best || n > best.len)) best = { v: k.entry, len: n };
    }
    if (best) return asMatch(best.v, "subsequence", workshop);
  }

  const coded = codeTokenScan(base);
  if (coded) return asMatch(coded, "code", workshop);

  if (toks.length >= 3) {
    // order-insensitive, "international" optional; accepted only when unambiguous
    const rel = toks.filter((t) => t !== "international");
    const found = new Set<VenueEntry>();
    for (const k of tokenKeys) {
      const kt = k.tokens.filter((t) => t !== "international");
      if (kt.length !== rel.length || kt.length < 3) continue;
      const used = new Array<boolean>(kt.length).fill(false);
      let ok = true;
      for (const t of rel) {
        const j = kt.findIndex((x, i) => !used[i] && tokMatch(t, x));
        if (j < 0) {
          ok = false;
          break;
        }
        used[j] = true;
      }
      if (ok) found.add(k.entry);
    }
    if (found.size === 1) return asMatch([...found][0], "relaxed", workshop);
  }
  return null;
}

// ISO-4-style word abbreviations for venues that are not in venues.json.
const ISO4: Record<string, string> = {
  academy: "Acad.", advanced: "Adv.", advances: "Adv.", agricultural: "Agric.", american: "Am.", analysis: "Anal.",
  annals: "Ann.", annual: "Annu.", applications: "Appl.", applied: "Appl.", architecture: "Archit.", archives: "Arch.",
  artificial: "Artif.", association: "Assoc.", augmented: "Augment.", automation: "Autom.", autonomous: "Auton.",
  biology: "Biol.", biomedical: "Biomed.", british: "Br.", bulletin: "Bull.", chemistry: "Chem.", civil: "Civ.",
  cognitive: "Cogn.", communications: "Commun.", computation: "Comput.", computational: "Comput.",
  computer: "Comput.", computers: "Comput.", computing: "Comput.", conference: "Conf.", construction: "Constr.",
  cybernetics: "Cybern.", design: "Des.", development: "Dev.", digital: "Digit.", distributed: "Distrib.",
  education: "Educ.", electrical: "Electr.", electronics: "Electron.", embedded: "Embed.", engineering: "Eng.",
  environmental: "Environ.", european: "Eur.", experimental: "Exp.", foundations: "Found.", frontiers: "Front.",
  geographic: "Geogr.", geographical: "Geogr.", geometric: "Geom.", geometry: "Geom.", geoscience: "Geosci.",
  graphics: "Graph.", hardware: "Hardw.", human: "Hum.", industrial: "Ind.", information: "Inf.",
  instrumentation: "Instrum.", intelligence: "Intell.", intelligent: "Intell.", interaction: "Interact.",
  interactive: "Interact.", international: "Int.", journal: "J.", knowledge: "Knowl.", language: "Lang.",
  languages: "Lang.", learning: "Learn.", letters: "Lett.", linguistics: "Linguist.", machine: "Mach.",
  magazine: "Mag.", management: "Manag.", material: "Mater.", materials: "Mater.", mathematical: "Math.",
  mathematics: "Math.", measurement: "Meas.", mechanical: "Mech.", mechanics: "Mech.", medical: "Med.",
  medicine: "Med.", microscopy: "Microsc.", mobile: "Mob.", modeling: "Model.", modelling: "Model.",
  multimedia: "Multimed.", national: "Natl.", navigation: "Navig.", networks: "Netw.", networking: "Netw.",
  neuroscience: "Neurosci.", numerical: "Numer.", optical: "Opt.", optics: "Opt.", perception: "Percept.",
  performance: "Perform.", photogrammetry: "Photogramm.", photography: "Photogr.", physical: "Phys.",
  physics: "Phys.", proceedings: "Proc.", processing: "Process.", programming: "Program.", psychology: "Psychol.",
  quantitative: "Quant.", quarterly: "Q.", reality: "Real.", recognition: "Recognit.", rendering: "Render.",
  representations: "Represent.", research: "Res.", review: "Rev.", reviews: "Rev.", robotics: "Robot.",
  science: "Sci.", sciences: "Sci.", security: "Secur.", sensing: "Sens.", simulation: "Simul.", society: "Soc.",
  software: "Softw.", spatial: "Spat.", statistical: "Stat.", statistics: "Stat.", survey: "Surv.",
  surveys: "Surv.", symposium: "Symp.", systems: "Syst.", techniques: "Tech.", technology: "Technol.",
  theoretical: "Theor.", transactions: "Trans.", transportation: "Transp.", understanding: "Underst.",
  vehicles: "Veh.", vehicular: "Veh.", vision: "Vis.", visualization: "Vis.", wireless: "Wirel.",
};
for (const v of venues) {
  // learn further word pairs from the table itself when word counts line up
  const fw = v.full.split(/\s+/).filter((w) => !STOPWORDS.has(w.toLowerCase()) && w !== "&");
  const aw = v.abbr.split(/\s+/);
  if (fw.length !== aw.length || v.full === v.abbr) continue;
  fw.forEach((w, i) => {
    const key = w.toLowerCase();
    const a = aw[i];
    if (!(key in ISO4) && /^[a-z]+$/.test(key) && a.endsWith(".") && key.startsWith(a.slice(0, 2).toLowerCase())) {
      ISO4[key] = a;
    }
  });
}

/** Compact ISO-4-ish abbreviation for a venue that is not in venues.json. */
export function abbreviateVenue(raw: string): string {
  const s = raw
    .replace(/\s+/g, " ")
    .replace(/^in:?\s+/i, "")
    .replace(/\([^()]*\)/g, " ")
    .replace(/^(?:the\s+)?(?:proceedings|proc\.?)(?:\s+of)?(?:\s+the)?\s+/i, "")
    .replace(ORDINAL_RE, " ")
    .replace(/\b(?:18|19|20)\d\d\b/g, " ")
    .replace(/[,;:]/g, " ")
    .trim();
  const words: string[] = [];
  for (const w of s.split(/\s+/)) {
    const key = stripDiacritics(w).toLowerCase().replace(/[.]+$/, "");
    if (!key || STOPWORDS.has(key) || key === "&") continue;
    words.push(ISO4[key] ?? w);
  }
  return words.join(" ");
}
