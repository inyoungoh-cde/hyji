import type { Level } from "../types";
import { LEVELS } from "../types";

// One vocabulary for the triage scale everywhere it is drawn.
//
// Shape carries the meaning (★ count = level, ⚑ = revisit) so a row reads
// without a legend and without relying on colour; the colour ramp is a
// secondary cue that keeps the pre-2.8 importance hues (gray → orange → red)
// so existing users' eyes don't have to relearn.

export const LEVEL_RANK: Record<Level, number> = { Noted: 1, Relevant: 2, Core: 3 };

export const LEVEL_COLOR: Record<Level, string> = {
  Noted: "#8b949e",
  Relevant: "#f77f00",
  Core: "#d62828",
};

export const REVISIT_COLOR = "#ffd166";

export const LEVEL_HINT: Record<Level, string> = {
  Noted: "Noted — skimmed or background reference",
  Relevant: "Relevant — directly related to your work, may cite",
  Core: "Core — must cite or compare against",
};

export const REVISIT_HINT = "Revisit — come back to this paper (to-do flag)";

export function levelStars(level: Level): string {
  return "★".repeat(LEVEL_RANK[level] ?? 1);
}

/** Tolerates rows from before the migration or unexpected values. */
export function normalizeLevel(v: unknown): Level {
  return (LEVELS as string[]).includes(String(v)) ? (v as Level) : "Noted";
}

// Tailwind classes for the pill badges (22% fill, 27% border). Written out
// literally — the JIT scanner only emits classes it can read from source,
// so template-built arbitrary values would silently produce no CSS.
const LEVEL_BADGE_CLASS: Record<Level, string> = {
  Noted: "bg-[#8b949e36] text-[#8b949e] border-[#8b949e44]",
  Relevant: "bg-[#f77f0036] text-[#f77f00] border-[#f77f0044]",
  Core: "bg-[#d6282836] text-[#d62828] border-[#d6282844]",
};

export function levelBadgeClass(level: Level): string {
  return LEVEL_BADGE_CLASS[level];
}

export const REVISIT_BADGE_CLASS = "bg-[#ffd16636] text-[#ffd166] border-[#ffd16644]";
