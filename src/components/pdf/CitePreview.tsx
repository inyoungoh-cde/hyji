import type { CiteFields } from "../../stores/ui";
import type { ParsedCitation } from "../../lib/citeParse";

/** What the hover card shows for one in-text link (3.4). */
export type CitePreviewData =
  | { kind: "reference"; parsed: ParsedCitation; raw: string }
  | { kind: "other"; raw: string };

export interface CitePreviewProps {
  data: CitePreviewData;
  fields: CiteFields;
  /** Anchor rect of the hovered link, in viewport (client) px. */
  anchor: { left: number; top: number; right: number; bottom: number };
  /** PDF dark mode: the page is dark, so the card flips to a light palette
   *  to keep contrast against it (dark card on white page otherwise). */
  inverted?: boolean;
}

// Two palettes with the same roles; literal class names (Tailwind JIT can't
// see template-built ones).
const PALETTE = {
  normal: {
    card: "border-border bg-bg-secondary shadow-[0_8px_24px_rgba(0,0,0,0.45)]",
    chip: "bg-bg-tertiary text-text-tertiary",
    authors: "text-text-secondary",
    title: "text-text-primary",
    venueKnown: "bg-accent/15 text-accent border border-accent/30",
    venueOther: "bg-bg-tertiary text-text-secondary border border-border",
    year: "text-text-tertiary",
    raw: "text-text-secondary",
  },
  inverted: {
    card: "border-[#d0d7de] bg-[#f6f8fa] shadow-[0_8px_24px_rgba(0,0,0,0.55)]",
    chip: "bg-[#e6eaef] text-[#57606a]",
    authors: "text-[#424a53]",
    title: "text-[#1f2328]",
    venueKnown: "bg-[#0969da] text-white border border-[#0969da]",
    venueOther: "bg-[#eaeef2] text-[#424a53] border border-[#d0d7de]",
    year: "text-[#6e7781]",
    raw: "text-[#424a53]",
  },
} as const;
type Palette = (typeof PALETTE)[keyof typeof PALETTE];

const CARD_W = 380;
const GAP = 6;

/**
 * Floating card over a citation link. Each field has its own visual role so a
 * reader can tell them apart at a glance even when some are turned off in
 * View → Citation Preview on Hover:
 *   [47] Tang et al.                        ← label chip + authors
 *   Contrastive boundary learning for …      ← title, bold, ≤ 2 lines
 *   (CVPR) 2022                              ← venue pill (accent) + year
 * Low-confidence parses and non-reference targets (figures, sections,
 * footnotes) show the extracted text verbatim instead.
 */
export function CitePreview({ data, fields, anchor, inverted = false }: CitePreviewProps) {
  const pal = inverted ? PALETTE.inverted : PALETTE.normal;
  const below = anchor.bottom + GAP + 140 < window.innerHeight;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - CARD_W - 8));
  const style: React.CSSProperties = below
    ? { left, top: anchor.bottom + GAP }
    : { left, bottom: window.innerHeight - anchor.top + GAP };

  return (
    <div
      className={`fixed z-[60] pointer-events-none rounded-[10px] border ${pal.card} px-3.5 py-2.5 animate-[hyji-fade-in_120ms_ease-out]`}
      style={{ ...style, width: "max-content", minWidth: 180, maxWidth: `min(${CARD_W}px, calc(100vw - 16px))` }}
      role="tooltip"
    >
      {data.kind === "reference" && data.parsed.confidence >= 0.5 ? (
        <ParsedCard parsed={data.parsed} fields={fields} pal={pal} />
      ) : (
        <RawCard
          label={data.kind === "reference" ? data.parsed.label : null}
          text={data.raw}
          lines={data.kind === "reference" ? 3 : 2}
          pal={pal}
        />
      )}
    </div>
  );
}

function LabelChip({ label, pal }: { label: string; pal: Palette }) {
  return (
    <span className={`shrink-0 rounded-[4px] px-1.5 py-px text-caption font-mono ${pal.chip}`}>
      [{label}]
    </span>
  );
}

function ParsedCard({ parsed, fields, pal }: { parsed: ParsedCitation; fields: CiteFields; pal: Palette }) {
  const showAuthors = fields.authors && !!parsed.authorShort;
  const showTitle = fields.title && !!parsed.title;
  const showVenue = fields.venue && !!parsed.venueShort;
  const showYear = fields.year && !!parsed.year;
  const hasHead = showAuthors || !!parsed.label;

  return (
    <div className="flex flex-col gap-1">
      {hasHead && (
        <div className="flex items-center gap-2 min-w-0">
          {parsed.label && <LabelChip label={parsed.label} pal={pal} />}
          {showAuthors && (
            <span className={`truncate text-small font-medium ${pal.authors}`} title={parsed.authors.join(", ")}>
              {parsed.authorShort}
            </span>
          )}
        </div>
      )}
      {showTitle && (
        <div className={`text-body font-semibold leading-snug line-clamp-2 ${pal.title}`}>
          {parsed.title}
        </div>
      )}
      {(showVenue || showYear) && (
        <div className="flex items-center gap-2 min-w-0">
          {showVenue && (
            <span
              className={`truncate rounded-full px-2 py-px text-caption font-semibold ${
                parsed.venueKnown ? pal.venueKnown : pal.venueOther
              }`}
              title={parsed.venueRaw}
            >
              {parsed.venueShort}
            </span>
          )}
          {showYear && <span className={`shrink-0 text-small tabular-nums ${pal.year}`}>{parsed.year}</span>}
        </div>
      )}
    </div>
  );
}

function RawCard({ label, text, lines, pal }: { label: string | null; text: string; lines: number; pal: Palette }) {
  const body = label ? text.replace(/^\s*\[[^\]]+\]\s*/, "") : text;
  return (
    <div className="flex items-start gap-2 min-w-0">
      {label && <LabelChip label={label} pal={pal} />}
      <div
        className={`text-small leading-snug overflow-hidden ${pal.raw}`}
        style={{ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical" }}
      >
        {body}
      </div>
    </div>
  );
}
