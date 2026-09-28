import { useRef, useState, useCallback } from "react";

export const PAPER_DRAG_UNASSIGNED = "__unassigned__";

/** Farthest a row travels sideways while being swiped (px). */
export const SWIPE_MAX = 112;

/** A horizontal swipe in progress: dx < 0 = left (delete), dx > 0 = right. */
export interface PaperSwipe {
  paperId: string;
  dx: number;
}

interface PaperDragResult {
  draggingPaperId: string | null;
  paperDropTarget: string | null;
  ghostPos: { x: number; y: number } | null;
  swipe: PaperSwipe | null;
  onPaperMouseDown: (e: React.MouseEvent, paperId: string) => void;
  onDropZoneEnter: (targetId: string) => void;
  /** True once after a drag/swipe gesture — the click event the browser
   *  fires right after it must not be treated as "open this paper". */
  consumeGestureClick: () => boolean;
}

// One mousedown, two gestures, decided by the first decisive movement:
// mostly vertical → pick the row up and drop it on a folder (move);
// mostly horizontal → swipe the row sideways (delete / status shortcut).
export function usePaperDrag(
  onMove: (paperId: string, projectId: string | null) => void,
  onSwipeEnd: (paperId: string, dx: number) => void
): PaperDragResult {
  const [draggingPaperId, setDraggingPaperId] = useState<string | null>(null);
  const [paperDropTarget, setPaperDropTarget] = useState<string | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);
  const [swipe, setSwipe] = useState<PaperSwipe | null>(null);

  const modeRef = useRef<"none" | "drag" | "swipe">("none");
  const dropTargetRef = useRef<string | null>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const gestureRef = useRef(false);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onSwipeEndRef = useRef(onSwipeEnd);
  onSwipeEndRef.current = onSwipeEnd;

  const clampDx = (dx: number) => Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, dx));

  const onPaperMouseDown = useCallback((e: React.MouseEvent, paperId: string) => {
    if (e.button !== 0) return;

    modeRef.current = "none";
    dropTargetRef.current = null;
    startX.current = e.clientX;
    startY.current = e.clientY;
    gestureRef.current = false;

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX.current;
      const dy = ev.clientY - startY.current;
      if (modeRef.current === "none") {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        modeRef.current = Math.abs(dx) > Math.abs(dy) ? "swipe" : "drag";
        gestureRef.current = true;
        document.body.style.userSelect = "none";
        if (modeRef.current === "drag") {
          setDraggingPaperId(paperId);
          document.body.style.cursor = "grabbing";
        } else {
          document.body.style.cursor = "ew-resize";
        }
      }
      if (modeRef.current === "drag") {
        setGhostPos({ x: ev.clientX + 14, y: ev.clientY + 4 });
      } else {
        setSwipe({ paperId, dx: clampDx(dx) });
      }
    };

    const onMouseUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      const mode = modeRef.current;
      const target = dropTargetRef.current;
      modeRef.current = "none";
      dropTargetRef.current = null;
      setDraggingPaperId(null);
      setPaperDropTarget(null);
      setGhostPos(null);
      setSwipe(null);

      if (mode === "drag" && target) {
        const projectId = target === PAPER_DRAG_UNASSIGNED ? null : target;
        onMoveRef.current(paperId, projectId);
      } else if (mode === "swipe") {
        onSwipeEndRef.current(paperId, clampDx(ev.clientX - startX.current));
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  const onDropZoneEnter = useCallback((targetId: string) => {
    if (modeRef.current === "drag") {
      dropTargetRef.current = targetId;
      setPaperDropTarget(targetId);
    }
  }, []);

  const consumeGestureClick = useCallback(() => {
    const g = gestureRef.current;
    gestureRef.current = false;
    return g;
  }, []);

  return { draggingPaperId, paperDropTarget, ghostPos, swipe, onPaperMouseDown, onDropZoneEnter, consumeGestureClick };
}
