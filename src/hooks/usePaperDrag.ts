import { useRef, useState, useCallback } from "react";

export const PAPER_DRAG_UNASSIGNED = "__unassigned__";

interface PaperDragResult {
  draggingPaperId: string | null;
  paperDropTarget: string | null;
  ghostPos: { x: number; y: number } | null;
  onPaperMouseDown: (e: React.MouseEvent, paperId: string) => void;
  onDropZoneEnter: (targetId: string) => void;
}

export function usePaperDrag(
  onMove: (paperId: string, projectId: string | null) => void
): PaperDragResult {
  const [draggingPaperId, setDraggingPaperId] = useState<string | null>(null);
  const [paperDropTarget, setPaperDropTarget] = useState<string | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);

  const draggingRef = useRef<string | null>(null);
  const dropTargetRef = useRef<string | null>(null);
  const startY = useRef(0);
  const didMove = useRef(false);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const onPaperMouseDown = useCallback((e: React.MouseEvent, paperId: string) => {
    if (e.button !== 0) return;

    draggingRef.current = paperId;
    dropTargetRef.current = null;
    startY.current = e.clientY;
    didMove.current = false;

    const onMouseMove = (ev: MouseEvent) => {
      if (!didMove.current && Math.abs(ev.clientY - startY.current) > 4) {
        didMove.current = true;
        setDraggingPaperId(paperId);
        document.body.style.cursor = "grabbing";
      }
      if (didMove.current) {
        setGhostPos({ x: ev.clientX + 14, y: ev.clientY + 4 });
      }
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";

      const papId = draggingRef.current;
      const target = dropTargetRef.current;

      draggingRef.current = null;
      dropTargetRef.current = null;
      setDraggingPaperId(null);
      setPaperDropTarget(null);
      setGhostPos(null);

      if (didMove.current && papId && target) {
        const projectId = target === PAPER_DRAG_UNASSIGNED ? null : target;
        onMoveRef.current(papId, projectId);
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  const onDropZoneEnter = useCallback((targetId: string) => {
    if (draggingRef.current && didMove.current) {
      dropTargetRef.current = targetId;
      setPaperDropTarget(targetId);
    }
  }, []);

  return { draggingPaperId, paperDropTarget, ghostPos, onPaperMouseDown, onDropZoneEnter };
}
