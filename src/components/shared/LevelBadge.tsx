import type { Level } from "../../types";
import { LEVEL_HINT, REVISIT_HINT, levelBadgeClass, levelStars, normalizeLevel, REVISIT_BADGE_CLASS } from "../../lib/level";

/** Pill badge: "★★ Relevant" (or stars only when compact). */
export function LevelBadge({ level, compact = false }: { level: Level | string; compact?: boolean }) {
  const lv = normalizeLevel(level);
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-caption font-bold border whitespace-nowrap ${levelBadgeClass(lv)}`}
      title={LEVEL_HINT[lv]}
    >
      <span className="tracking-tighter">{levelStars(lv)}</span>
      {!compact && <span>{lv}</span>}
    </span>
  );
}

export function RevisitBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-caption font-bold border whitespace-nowrap ${REVISIT_BADGE_CLASS}`}
      title={REVISIT_HINT}
    >
      <span>⚑</span>
      {!compact && <span>Revisit</span>}
    </span>
  );
}
