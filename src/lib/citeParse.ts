// Parse one reference-list entry ("[47] L. Tang, … Contrastive boundary
// learning … In Proceedings of the IEEE/CVF conference …, 2022. 1, 2") into
// the fields a citation hover card shows. Pure string work — no I/O.
//
// Strategy: clean extraction artifacts, peel the label and trailing
// back-reference page numbers, then scan the author list with a small
// name grammar (given-first "Liyao Tang" / "B. Ke", inverted "Ke, B." /
// "ADAMS, A.", Vancouver "Dey TK"). Where the list stops decides the style:
// a quote → IEEE title, a year → author-year (ACM/APA/Harvard), a colon →
// LNCS, a comma → Elsevier-numbered comma style, a period → CVPR/NeurIPS.
// The venue is the text after the title up to the volume/pages/year tail and
// is matched against venues.json by venueMap.matchVenue.

import { abbreviateVenue, matchVenue, venueTokens } from "./venueMap";

export interface ParsedCitation {
  label: string | null;
  authors: string[];
  firstAuthorSurname: string;
  etAl: boolean;
  authorShort: string;
  title: string;
  venueRaw: string;
  venueShort: string;
  venueKnown: boolean;
  year: string;
  confidence: number;
}

// ── name grammar ────────────────────────────────────────────────────────────
const UP = "\\p{Lu}";
const WCH = "[\\p{L}\\p{M}'’\\-]";
const NAMEWORD = `(?!(?:AND|And|and|et)\\b)${UP}${WCH}*`;
const PARTICLE =
  "(?:van|von|der|den|de|del|della|des|di|da|du|dos|das|do|le|la|ter|ten|bin|ibn|al|el|zu|y|dal|degli|st\\.|v\\.)";
const INITIAL = `(?:${UP}\\.?-${UP}\\.|${UP}\\.(?:\\s?-\\s?${UP}\\.)?)`;
// trailing lowercase particle initial: MDPI "Santos, R.C.d.;"
const INITIALS = `${INITIAL}(?:\\s?${INITIAL}){0,4}(?:\\p{Ll}\\.(?=\\s*[;,]))?`;
const CAPSINIT = `${UP}{1,3}(?!\\p{L})`;
const SUFFIX = "(?:\\s*,?\\s+(?:Jr\\.?|Sr\\.?|II|III|IV)(?![\\p{L}]))?";
const SURNAME = `(?:${PARTICLE}\\s+){0,3}${NAMEWORD}(?:\\s+(?:${PARTICLE}|${NAMEWORD})){0,3}`;

// Shape B: "Ke, B." / "van der Maaten, L." / "DAVIS, M. A." / "Kim, J.-W."
const SHAPE_B = new RegExp(`${SURNAME},\\s?${INITIALS}${SUFFIX}`, "uy");
// Shape C: Vancouver "Dey TK" / "Liang H" / "Roddick T."
const SHAPE_C = new RegExp(`${SURNAME}\\s+(?:${INITIALS}|${CAPSINIT})`, "uy");
// Shape A: given-first "Liyao Tang" / "B. Ke" / "Robert A Jacobs" / "Luc Van Gool"
const LASTNAME = `(?!(?:AND|And|and|et)\\b)${UP}${WCH}+`;
const SHAPE_A = new RegExp(
  `(?:${INITIAL}\\s*|(?:${NAMEWORD}|${CAPSINIT})\\s+)(?:${INITIAL}\\s*|(?:${NAMEWORD}|${CAPSINIT}|${PARTICLE})\\s+){0,4}${LASTNAME}${SUFFIX}(?=\\s*(?:[,.;:(“"”\\[]|and\\b|AND\\b|&|et\\b|$)|\\s+(?:18|19|20)\\d\\d)`,
  "uy",
);
const SEP = /\s*(?:,\s*(?:and\s+|AND\s+|&\s*)?|;\s*(?:and\s+|&\s*)?|\s+(?:and|AND|&)\s+)/y;
const ETAL = /,?\s*(?:et\.?\s*al\.?|and others|others\.?)(?![\p{L}])/uy;
const ELLIPSIS = /\s*(?:…|\.\.\.)\s*/y;
const LONE_LAST = /\p{Lu}[\p{L}\p{M}'’-]{2,}(?=\.\s)/uy;

type Shape = "A" | "B" | "C";

function matchAt(re: RegExp, s: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(s);
}

interface AuthorScan {
  authors: string[];
  shape: Shape;
  end: number;
  etAl: boolean;
  elided: boolean;
}

// Every shape that can start the entry, scanned as far as it goes; the caller
// keeps the one that reaches a clean terminator with the most authors
// ("Raúl Mur-Artal, J. M. M. Montiel, …" is given-first, not "Mur-Artal, J.").
function scanAuthors(s: string): AuthorScan[] {
  const order: Shape[] = ["B", "C", "A"];
  const re: Record<Shape, RegExp> = { A: SHAPE_A, B: SHAPE_B, C: SHAPE_C };
  const out: AuthorScan[] = [];
  for (const shape of order) {
    const m0 = matchAt(re[shape], s, 0);
    if (!m0) continue;
    if (shape === "C" && !/^[\s]*[,.;]|^\s+et\s+al|^\s+(?:and|&)\s/.test(s.slice(m0[0].length))) continue;
    const authors = [m0[0].trim()];
    let pos = m0[0].length;
    let etAl = false;
    let elided = false;
    for (;;) {
      const e = matchAt(ETAL, s, pos);
      if (e) {
        etAl = true;
        pos += e[0].length;
        break;
      }
      const sep = matchAt(SEP, s, pos);
      if (!sep) break;
      let p2 = pos + sep[0].length;
      const el = matchAt(ELLIPSIS, s, p2);
      if (el) {
        elided = true;
        p2 += el[0].length;
        const sep2 = matchAt(SEP, s, p2);
        if (sep2) p2 += sep2[0].length;
      }
      const e2 = matchAt(ETAL, s, p2);
      if (e2 && /^\s*(?:et|others)/.test(s.slice(p2))) {
        etAl = true;
        pos = p2 + e2[0].length;
        break;
      }
      let m = matchAt(re[shape], s, p2);
      // a one-word last author ("…, and Hervégou. Title") — mangled or mononymous names
      if (!m && shape === "A" && /and|&/.test(sep[0])) m = matchAt(LONE_LAST, s, p2);
      if (!m) break;
      if (
        shape === "C" &&
        !m[0].endsWith(".") &&
        !/^\s*[,.;:]|^\s+et\s+al|^\s+(?:and|&)\s|^\s*\(/.test(s.slice(p2 + m[0].length))
      ) {
        break;
      }
      authors.push(m[0].trim());
      pos = p2 + m[0].length;
    }
    out.push({ authors, shape, end: pos, etAl, elided });
  }
  // single-name / organization author: "OpenAI. …", "Anon, 2024a. …", "Blender Online Community. …"
  const one = s.match(/^\p{Lu}[\p{L}\p{M}\-'’]+(?:\s+\p{Lu}[\p{L}\p{M}\-'’]+){0,3}(?=\.\s|,\s*\(?(?:18|19|20)\d\d)/u);
  if (one && !out.some((o) => o.shape === "A")) {
    out.push({ authors: [one[0]], shape: "A", end: one[0].length, etAl: false, elided: false });
  }
  return out;
}

interface Split {
  rest: string;
  yearEarly: string;
  commaMode: boolean;
}

// What follows the author list decides the style; null = no recognizable end.
function terminate(s: string, scan: AuthorScan): Split | null {
  const after = s.slice(scan.end);
  const yr = after.match(/^[.,]?\s*\(?((?:18|19|20)\d\d)[a-z]?\)?(?:[.,:;]\s*|\s+)(?=\S)/);
  if (yr) return { rest: after.slice(yr[0].length), yearEarly: yr[1], commaMode: false };
  if (/^\s*[,:]?\s*(?:[“"«„]|``)/.test(after)) return { rest: after.replace(/^\s*[,:]?\s*/, ""), yearEarly: "", commaMode: false };
  if (/^\s*\.(?:\s+\S|\s*$)/.test(after)) return { rest: after.replace(/^\s*\.\s*/, ""), yearEarly: "", commaMode: false };
  if (/^\s*:\s+\S/.test(after)) return { rest: after.replace(/^\s*:\s*/, ""), yearEarly: "", commaMode: false };
  const initialEnded = /\.$/.test(s.slice(0, scan.end)) && (scan.shape !== "A" || scan.etAl);
  if (initialEnded && /^\s+\S/.test(after)) return { rest: after.trim(), yearEarly: "", commaMode: false };
  if (/^\s*,\s+\S/.test(after) && (scan.shape !== "A" || /^\p{Lu}\./u.test(scan.authors[0]) || scan.authors.length > 1)) {
    return { rest: after.replace(/^\s*,\s*/, ""), yearEarly: "", commaMode: true };
  }
  return null;
}

// IEEE: everything before the opening quote is the author list, even when a
// name defeats the grammar ("C-S. Kim", "L. v. Stumberg", "C.-C. Jay Kuo").
function quoteSplit(s: string): { head: string; rest: string } | null {
  const m = s.match(/^(.{2,500}?)(?:,|:)?\s*(?=[“"]|``)/);
  if (!m) return null;
  const head = m[1].trim().replace(/,$/, "");
  if (/\p{Ll}{2}\.\s+\p{Lu}|\d/u.test(head.replace(/et\.?\s*al\./, ""))) return null;
  const parts = splitAuthorString(head);
  if (!parts.length || parts.some((p) => p.split(/\s+/).length > 6)) return null;
  return { head, rest: s.slice(m[0].length) };
}

// First ". " that is not after an initial / "et al" / Jr. — the classic
// author/title split, used when the grammar does not reach a clean end.
function naivePeriodSplit(s: string): number {
  const re = /[.:](?=\s+\S)|[“"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[0] === "“" || m[0] === '"') return m.index;
    const before = s.slice(0, m.index);
    const tok = before.match(/(\S+)$/)?.[1] ?? "";
    if (m[0] === ":" && !/,/.test(before)) continue;
    if (/^(?:\p{Lu}|\p{Lu}\.-?\p{Lu}|Jr|Sr|St|Dr)$/u.test(tok.replace(/^.*[.-]/, "")) && m[0] === ".") continue;
    return m.index;
  }
  return -1;
}

function splitAuthorString(a: string): string[] {
  return a
    .split(/\s*(?:,\s*(?:and|&)\s+|,\s*|;\s*|\s+(?:and|AND|&)\s+)\s*/)
    .map((x) => x.trim())
    .filter((x) => /\p{L}/u.test(x) && !/^(?:et\.?\s*al\.?|others|…|\.\.\.)$/i.test(x));
}

// ── cleanup ────────────────────────────────────────────────────────────────
const COMBINING: Record<string, string> = {
  "´": "\u0301", "`": "\u0300", "¨": "\u0308", "˜": "\u0303", "ˆ": "\u0302", "ˇ": "\u030C", "˚": "\u030A",
  "˘": "\u0306", "˙": "\u0307", "¯": "\u0304", "˝": "\u030B",
};

function preclean(input: string): string {
  let s = input
    .replace(/[\u00AD\u200B\uFEFF]/g, "")
    .replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/ﬀ/g, "ff").replace(/ﬃ/g, "ffi").replace(/ﬄ/g, "ffl")
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // LaTeX accents extracted as separate glyphs: "Doll´ ar" → "Dollár", "Fran¸ cois" → "François"
  s = s.replace(/([cCsStT])\s?¸\s?/g, (_m, c: string) => (c + "\u0327").normalize("NFC"));
  s = s.replace(/ı/g, "i");
  // only when glued to the previous letter; a free-standing " ¨ " was displaced
  // from another line ("Shahram ¨ Izadi", "SCHRODER ¨ , P.") and is dropped
  // ("Ren´ Ranftl" — accent then a capitalised next word: the letter it sat on
  // moved elsewhere, so only the accent is dropped)
  s = s.replace(/(\p{L})[´`¨˜ˆˇ˚˘˙¯˝]\s(?=\p{Lu})/gu, "$1 ");
  s = s.replace(/(\p{L})([´`¨˜ˆˇ˚˘˙¯˝])\s?(\p{L})/gu, (_m, pre: string, acc: string, ch: string) =>
    pre + (ch + COMBINING[acc]).normalize("NFC"),
  );
  // the displaced vowel itself: "Ren Ranftl, e Zhuwen Li" → "Ren Ranftl, Zhuwen Li"
  s = s.replace(/(,\s)[eéou]\s(?=\p{Lu}\p{Ll})/gu, "$1");
  // a name split around its accent: "Ara ´ ujo" → "Araújo", "Gron ´ ´ at" → "Gronát"
  s = s.replace(
    /(?<!\p{L})((?:\p{Lu}|\p{L}+-\p{Lu})\p{Ll}*)\s([´`¨˜ˆˇ])(?:\s[´`¨˜ˆˇ])?\s(\p{Ll})(\p{Ll}{0,4})(?![\p{L}])/gu,
    (_m, pre: string, acc: string, ch: string, tail: string) => pre + (ch + COMBINING[acc]).normalize("NFC") + tail,
  );
  s = s.replace(/(^|\s)[´¨˜ˆˇ˚˘˙¯¸˝](?=\s|,|$)/g, "$1");
  s = s.replace(/\s+,/g, ",").replace(/,(?:\s*,)+/g, ",");
  // "https : / / github . com / x" → "https://github.com/x"
  s = s.replace(/\b(https?)\s*:\s*\/\s*\/\s*/gi, "$1://");
  for (let i = 0; i < 4; i++) s = s.replace(/(https?:\/\/\S*?)\s+([./])\s*(?=\S)/gi, "$1$2");
  // line-break hyphen before a capital ("Yu- Wing Tai", "Geo- Information")
  s = s.replace(/(\p{L})- (\p{Lu})/gu, "$1-$2");
  // "8489– 8499" / "16 695–16 705"
  s = s.replace(/(\d)\s*([–—-])\s+(\d)/g, "$1$2$3");
  s = s.replace(/\[(?:CrossRef|Google Scholar|PubMed|Green Version|CrossRef\s*\]\s*\[PubMed)\]/gi, " ");
  // page furniture that extraction glued onto the last entry of a column
  s = s.replace(/\s*Authorized licensed use limited to:.*$/i, "").replace(/\s*Preprint not peer reviewed.*$/i, "");
  return s.replace(/\s+/g, " ").trim();
}

const YEAR_MAX = new Date().getFullYear() + 1;

function stripBackrefs(s: string): string {
  let t = s
    .replace(/\s*(?:↑|\^)\s*[\d,\s]+$/, "")
    .replace(/\s*[([]?(?:cited on|cit\. on|see) (?:pages?|pp?\.)\s*[\d,\sand]+[)\]]?\.?\s*$/i, "")
    .replace(/\s*[([]?(?:cited|referenced) (?:on|in) (?:pages?|pp?\.)[^)\]]*[)\]]?\.?\s*$/i, "");
  // after a closing year: "…, 2022. 1, 2, 5" / "… (2023) 4" / "2020. 3 14604"
  t = t.replace(/(\b(?:18|19|20)\d\d[a-z]?\)?\.?)(?:\s+\d{1,5}(?:\s*,\s*\d{1,3})*\s*,?)+\s*$/, "$1");
  // generic tail of small numbers after a sentence end (backrefs, stray page numbers)
  t = t.replace(/([.)])\s+\d{1,3}(?:\s*,\s*\d{1,3})*\s*,?\s*$/, "$1");
  return t.trim();
}

// ── field helpers ──────────────────────────────────────────────────────────
const ORG_RE =
  /\b(?:Community|Foundation|Team|Inc\.?|Corporation|Corp\.?|Consortium|Group|Project|Committee|Association|Society|Institute|University|Laboratory|Lab|Labs|Organization|Organisation|Contributors|Developers|Council|Agency|Ltd\.?|GmbH|Collaboration)\b|^(?:OpenAI|Google|Microsoft|NVIDIA|Nvidia|Meta|Meta AI|DeepMind|Google DeepMind|Anthropic|Apple|Amazon|Intel|Adobe|Qualcomm|Baidu|Alibaba|Tencent|ByteDance|Epic Games|Unity Technologies|Blender|Anon|Anonymous)\b/;

function titleCaseCaps(w: string): string {
  if (!/\p{Lu}{2}/u.test(w) || w !== w.toUpperCase()) return w;
  return w.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
}

function surnameOf(author: string, shape: Shape, single: boolean): string {
  let a = author.replace(/\s*,?\s+(?:Jr\.?|Sr\.?|II|III|IV)$/, "").trim();
  if (/[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/.test(a) && !/\s/.test(a)) return a;
  if (single && ORG_RE.test(a) && !/^\p{Lu}\.\s/u.test(a)) return a;
  if (shape === "B" || (/,/.test(a) && /,\s*\p{Lu}\./u.test(a))) {
    a = a.split(",")[0].trim();
    return titleCaseCaps(a);
  }
  if (shape === "C") {
    a = a.replace(new RegExp(`\\s+(?:${CAPSINIT}|${INITIALS})$`, "u"), "").trim();
    return titleCaseCaps(a);
  }
  const toks = a.split(/\s+/);
  if (toks.length === 1) return titleCaseCaps(toks[0]);
  let i = toks.length - 1;
  const parts = [toks[i]];
  while (i - 1 >= 1 && new RegExp(`^${PARTICLE}$`, "iu").test(toks[i - 1])) {
    parts.unshift(toks[i - 1]);
    i--;
  }
  return parts.map(titleCaseCaps).join(" ");
}

interface YearHit {
  year: string;
  index: number;
  paren: boolean;
}

function findYears(s: string): YearHit[] {
  const clean = s
    .replace(/https?:\/\/\S+|www\.\S+|doi:\s*\S+|\b10\.\d{4,}\/\S+/gi, (m) => " ".repeat(m.length))
    .replace(/(?:arXiv|abs)[:/]\s*\S+/gi, (m) => " ".repeat(m.length));
  const out: YearHit[] = [];
  const re = /(?<![\d./:–—\-])((?:18|19|20)\d\d)[a-z]?(?![\d–—\-]|\.\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const y = parseInt(m[1], 10);
    if (y < 1850 || y > YEAR_MAX) continue;
    const before = clean.slice(Math.max(0, m.index - 7), m.index);
    if (/(?:pp?\.|pages?|vol\.|no\.|Part [IVX]+)\s*$/i.test(before)) continue;
    const paren = clean[m.index - 1] === "(" && /^[a-z]?\)/.test(clean.slice(m.index + 4));
    out.push({ year: m[1], index: m.index, paren });
  }
  return out;
}

const DETAIL_PATTERNS: RegExp[] = [
  /,\s*(?:pages?|pp?\.|vol(?:ume)?\.?|no\.|nr\.|number|art(?:icle)?\.?|issue|chapter|ch\.|series)\s*\S/i,
  /\.\s+(?:pages?|pp?\.|vol\.?|volume|no\.)\s*\d/i,
  /\s(?:pp?\.|pages)\s*\d/i,
  /,\s*\d/,
  /\s\d+\s*\(\s*\d+[^)]*\)/,
  /\s\d+\s*:\s*\d/,
  /\s\d+\s*,\s*\d/,
  /\s*\(\s*(?:18|19|20)\d\d[a-z]?\s*\)/,
  /[,.]?\s(?:18|19|20)\d\d[a-z]?(?![\d])/,
  /\s\d+\s*;\s*\d/,
  /[.,]\s*(?:Springer|Elsevier|PMLR|OpenReview\.net|Curran Associates|IEEE Computer Society|IEEE Press|ACM Press|MIT Press|The MIT Press|AAAI Press|Morgan Kaufmann|Wiley|Cambridge University Press|Citeseer|Academic Press)\b/,
  /[.,]\s*(?:IEEE|ACM)(?=\s*(?:[,.(]|$))/,
  /[,.]?\s*(?:https?:\/\/|doi:|www\.|URL\s)/i,
  /\.\s*$/,
];

const YEAR_CUT = DETAIL_PATTERNS[8];

function cutVenue(input: string): string {
  // "In I. Guyon, …, editors, Advances in …" / "In: Smith, J. (eds.) Proc. …"
  const v = input.replace(/^.{0,300}?\b(?:editors?|eds?\.)\s*[,:)]?\s*/i, (m) => (/,|\(/.test(m) ? "" : m));
  if (
    /^\(?(?:18|19|20)\d\d[a-z]?\)?(?:[.,;]|\s*$)|^(?:pages?|pp?\.|vol\.|volume|no\.|URL|https?:|doi)\b/i.test(v) ||
    /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(?:\d{1,2},?\s+)?(?:18|19|20)\d\d\b/.test(v)
  ) {
    return "";
  }
  let cut = v.length;
  for (const re of DETAIL_PATTERNS) {
    const m = re.exec(v);
    if (!m || m.index <= 0 || m.index >= cut) continue;
    // "Proceedings of the 2019 IEEE International Conference …" — the year is part of the name
    if (re === YEAR_CUT && /(?:\bthe|\bof|\bProc\.?|\bIn:?)\s*$/i.test(v.slice(0, m.index + 1)) && /^\s*\S+\s+\p{L}/u.test(v.slice(m.index + m[0].length))) {
      const again = new RegExp(re.source, "g");
      again.lastIndex = m.index + m[0].length;
      const m2 = again.exec(v);
      if (m2 && m2.index < cut) cut = m2.index;
      continue;
    }
    cut = m.index;
  }
  return v
    .slice(0, cut)
    .replace(/[\s.,;:]+$/, "")
    .trim();
}

function tidyTitle(t: string): string {
  return t
    .replace(/\[(?:J|C|M|D|A|P|R|S|Z|EB\/OL|OL|DB|N|CP)\]/g, "")
    .replace(/,\s*(?:volume|vol\.)\s*\d+\s*$/i, "")
    .replace(/^[\s“”"'‘’«»,.]+|[\s“”"'‘’«»,.;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Position after the title in `rest`: first sentence end not inside an obvious abbreviation.
function titleEnd(rest: string): number {
  const re = /[.?!](?=\s+\S|\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) {
    const before = rest.slice(0, m.index);
    const tok = before.match(/(\S+)$/)?.[1] ?? "";
    if (m[0] === "." && /^(?:vs|v|e\.g|i\.e|etc|al|Dr|Mr|Mrs|St|Fig|No|Vol|approx|resp|cf)$/i.test(tok)) continue;
    if (m[0] === "." && before.length < 2) continue;
    // "Are we ready for autonomous driving? the kitti vision benchmark suite."
    if (m[0] !== "." && /^\s+\p{Ll}/u.test(rest.slice(m.index + 1)) && !/^\s+(?:in|arXiv|proc)\b/i.test(rest.slice(m.index + 1))) continue;
    // "…driving? The KITTI vision benchmark suite. In CVPR" — a subtitle sentence
    // after "?" that is itself followed by the venue belongs to the title
    if (m[0] !== ".") {
      const after = rest.slice(m.index + 1);
      const sub = after.match(/^\s+(\p{Lu}[^.?!]{2,120})\.\s+(?:In:?\s|arXiv|Proc)/u);
      if (sub && !/^(?:In|Proc|Proceedings|Advances|IEEE|ACM|Journal|Int|International|arXiv)\b/.test(sub[1]) && !matchVenue(sub[1])) {
        return m.index + 1 + sub[0].indexOf(sub[1]) + sub[1].length;
      }
    }
    return m[0] === "." ? m.index : m.index + 1;
  }
  return -1;
}

function hostOf(url: string): string {
  const m = url.match(/https?:\/\/(?:www\.)?([^/\s]+)/i);
  return m ? m[1].replace(/[.,;]+$/, "") : "";
}

function shortForVenue(venueRaw: string): { short: string; known: boolean } {
  if (!venueRaw) return { short: "", known: false };
  const tryMatch = (v: string) => matchVenue(v);
  let m = tryMatch(venueRaw);
  if (!m && venueRaw.includes(",")) {
    const segs = venueRaw.split(/,\s*/);
    // drop trailing ", Glasgow, UK" / ", Springer" — but a 2-word head like
    // "Proceedings of Computer Graphics" is too weak to trust on its own
    for (let n = segs.length - 1; n >= 1 && !m; n--) {
      const head = segs.slice(0, n).join(", ");
      const hm = tryMatch(head);
      if (hm && (venueTokens(head).length >= 3 || /code|acronym|arxiv|exact/.test(hm.via))) m = hm;
    }
  }
  if (m) return { short: m.code, known: true };
  const paren = venueRaw.match(/\(([A-Z][A-Za-z0-9&\-\s]{1,14})\)/);
  if (paren && /[A-Z]{2}/.test(paren[1])) return { short: paren[1].trim(), known: false };
  const url = venueRaw.match(/https?:\/\/\S+/);
  if (url) {
    const h = hostOf(url[0]);
    if (h) return { short: h, known: false };
  }
  let short = abbreviateVenue(venueRaw.replace(/,\s*(?:Springer|Elsevier|IEEE|ACM|PMLR).*$/, "")) || venueRaw.trim();
  if (short.length > 40) short = short.slice(0, 39).replace(/\s+\S*$/, "") + "…";
  return { short, known: false };
}

function emptyResult(label: string | null, raw: string): ParsedCitation {
  return {
    label, authors: [], firstAuthorSurname: "", etAl: false, authorShort: "", title: raw,
    venueRaw: "", venueShort: "", venueKnown: false, year: "", confidence: 0,
  };
}

// ── main ───────────────────────────────────────────────────────────────────
export function parseCitation(entry: string): ParsedCitation {
  // real entries stay well under 2k chars; the cap bounds regex work on garbage input
  let s = preclean((entry ?? "").slice(0, 3000)).slice(0, 2000);
  let label: string | null = null;
  const lm =
    s.match(/^\[([A-Za-z]{0,4}\s?\d{1,4}[a-z]?)\]\s*/) ??
    s.match(/^(?!(?:18|19|20)\d\d\b)(\d{1,4})\.\s+(?=\S)/) ??
    s.match(/^\((\d{1,4})\)\s+/) ??
    s.match(/^(\d{1,3})\s+(?=\p{Lu})/u);
  if (lm) {
    label = lm[1].replace(/\s+/g, "");
    s = s.slice(lm[0].length);
  }
  s = stripBackrefs(s);
  if (!s) return emptyResult(label, "");

  // ── authors
  let authors: string[] = [];
  let shape: Shape = "A";
  let etAl = false;
  let elided = false;
  let rest = "";
  let commaMode = false;
  let clean = false;
  let yearEarly = "";

  let best: { scan: AuthorScan; split: Split; score: number } | null = null;
  for (const scan of scanAuthors(s)) {
    const split = terminate(s, scan);
    if (!split) continue;
    const score = scan.authors.length + (scan.etAl || scan.elided ? 1 : 0) - (split.commaMode ? 0.5 : 0);
    if (!best || score > best.score) best = { scan, split, score };
  }
  if (best && best.split.commaMode) {
    // a quote later on means IEEE, whose names the grammar may have stopped short of
    const qs = quoteSplit(s);
    if (qs && qs.head.length > s.slice(0, best.scan.end).length + 2) best = null;
  }
  if (best) {
    ({ authors, shape, etAl, elided } = best.scan);
    ({ rest, yearEarly, commaMode } = best.split);
    clean = true;
  } else {
    const qs = quoteSplit(s);
    if (qs) {
      authors = splitAuthorString(qs.head);
      etAl = /et\.?\s*al/i.test(qs.head);
      shape = "A";
      rest = qs.rest;
      clean = true;
    }
  }
  if (!clean) {
    const cut = naivePeriodSplit(s);
    if (cut > 0 && cut < 600) {
      const head = s.slice(0, cut);
      authors = splitAuthorString(head);
      etAl = /et\.?\s*al/i.test(head);
      shape = /^[^,]+,\s*\p{Lu}\./u.test(head) ? "B" : /^\S+\s+\p{Lu}{1,3}\.?(?:,|$)/u.test(head) ? "C" : "A";
      rest = s.slice(cut).replace(/^[.:]\s*/, "");
    } else {
      rest = s;
    }
    const yr = rest.match(/^\(?((?:18|19|20)\d\d)[a-z]?\)?[.,:;]\s*/);
    if (yr) {
      yearEarly = yr[1];
      rest = rest.slice(yr[0].length);
    }
  }

  // ── title
  let title = "";
  let venuePart = "";
  const q = rest.match(/^(?:[“"«„]|``)([\s\S]+?)(?:[”"»“]|'')/);
  if (q) {
    title = q[1];
    venuePart = rest.slice(q[0].length);
  } else if (commaMode) {
    const inIdx = rest.search(/,\s+in:?\s+/i);
    if (inIdx > 0) {
      title = rest.slice(0, inIdx);
      venuePart = rest.slice(inIdx + 1);
    } else {
      let tail = rest.length;
      for (const re of DETAIL_PATTERNS) {
        const m = re.exec(rest);
        if (m && m.index > 0 && m.index < tail) tail = m.index;
      }
      const head = rest.slice(0, tail);
      const lc = head.lastIndexOf(", ");
      if (lc > 0 && head.length - lc < 120) {
        title = head.slice(0, lc);
        venuePart = rest.slice(lc + 1);
      } else {
        title = head;
        venuePart = rest.slice(tail);
      }
    }
  } else {
    const te = titleEnd(rest);
    if (te >= 0) {
      title = rest.slice(0, te);
      venuePart = rest.slice(te);
    } else {
      title = rest;
    }
    // "Title, 2023." / "Title, https://…" with no sentence break before the tail
    const ty = title.match(
      /^(.*?\S)(?:,\s*(?:(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+)?(?:18|19|20)\d\d[a-z]?|https?:\/\/\S+).*)$/,
    );
    if (ty && ty[1].length > 8) {
      venuePart = title.slice(ty[1].length) + venuePart;
      title = ty[1];
    }
  }
  title = tidyTitle(title);

  // ── venue
  let v = venuePart.replace(/^[\s.,;:?!]+/, "").replace(/^(?:in:?|In:?)\s+(?=\S)/, "");
  const url = v.match(/https?:\/\/\S+/)?.[0] ?? "";
  let venueRaw = cutVenue(v);
  if (/^(?:https?:|www\.|doi:|URL$|\[Online\]|Available)/i.test(venueRaw)) venueRaw = "";
  venueRaw = venueRaw.replace(/\[Online\].*$/i, "").replace(/^(?:\[Online\]\.?\s*)/i, "").trim();
  let { short: venueShort, known: venueKnown } = shortForVenue(venueRaw);
  if (!venueRaw) {
    const ax = rest.match(/arXiv/i);
    if (ax) {
      venueRaw = "arXiv";
      venueShort = "arXiv";
      venueKnown = true;
    } else if (url) {
      venueShort = hostOf(url);
    }
  }

  // ── year
  let year = yearEarly;
  if (!year) {
    const after = findYears(venuePart);
    const pool = after.length ? after : findYears(s);
    // first year after the title: later ones are usually page furniture or reprint notes
    year = pool[0]?.year ?? "";
  }

  // ── authors → display
  const single = authors.length === 1;
  const surnames = authors.map((a) => surnameOf(a, shape, single));
  const firstAuthorSurname = surnames[0] ?? "";
  const many = authors.length > 2 || etAl || elided;
  const authorShort = !firstAuthorSurname
    ? ""
    : many
      ? `${firstAuthorSurname} et al.`
      : authors.length === 2
        ? `${firstAuthorSurname} and ${surnames[1]}`
        : firstAuthorSurname;

  // ── confidence
  let c = 0;
  if (firstAuthorSurname && /\p{L}/u.test(firstAuthorSurname) && firstAuthorSurname.length <= 40) c += clean ? 0.3 : 0.18;
  if (authors.some((a) => /\d/.test(a) || a.split(/\s+/).length > 7)) c -= 0.15;
  if (title.length >= 3 && title.length <= 300) c += 0.3;
  if (title.length > 250 || /^(?:In |Proceedings|arXiv)/.test(title)) c -= 0.2;
  if (year) c += 0.2;
  if (venueRaw || url) c += venueKnown ? 0.2 : 0.14;
  else if (title) c += 0.06;
  // without an author the split is a guess (often a line fragment) — let the UI show raw text
  if (!firstAuthorSurname) c = Math.min(c, 0.45);
  const confidence = Math.max(0, Math.min(1, Math.round(c * 100) / 100));

  return {
    label,
    authors,
    firstAuthorSurname,
    etAl: many,
    authorShort,
    title,
    venueRaw,
    venueShort,
    venueKnown,
    year,
    confidence,
  };
}
