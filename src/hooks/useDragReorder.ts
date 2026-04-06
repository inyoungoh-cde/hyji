import { useRef, useState, useCallback } from "react";

interface DragReorderResult {
  dragOverId: string | null;
  draggingId: string | null;
  handleMouseDown: (e: React.MouseEvent, id: string) => void;
  handleMouseEnter: (id: string) => void;
}

export function useDragReorder(
  getIds: () => string[],
  onReorder: (ids: string[]) => Promise<void>
): DragReorderResult {
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dragOverRef = useRef<string | null>(null);
  const startY = useRef(0);
  const didMove = useRef(false);
  const getIdsRef = useRef(getIds);
  getIdsRef.current = getIds;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, id: string) => {
      if (e.button !== 0) return;
      dragIdRef.current = id;
      startY.current = e.clientY;
      didMove.current = false;

      const onMouseMove = (ev: MouseEvent) => {
        if (!didMove.current && Math.abs(ev.clientY - startY.current) > 4) {
          didMove.current = true;
          setDraggingId(dragIdRef.current);
          document.body.style.cursor = "grabbing";
          document.body.style.userSelect = "none";
        }
      };

      const onMouseUp = async () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";

        const fromId = dragIdRef.current;
        const toId = dragOverRef.current;

        dragIdRef.current = null;
        dragOverRef.current = null;
        setDraggingId(null);
        setDragOverId(null);

        if (didMove.current && fromId && toId && fromId !== toId) {
          const ids = getIdsRef.current();
          const fromIdx = ids.indexOf(fromId);
          const toIdx = ids.indexOf(toId);
          if (fromIdx !== -1 && toIdx !== -1) {
            ids.splice(fromIdx, 1);
            ids.splice(toIdx, 0, fromId);
            await onReorderRef.current(ids);
          }
        }
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    []
  );

  const handleMouseEnter = useCallback(
    (id: string) => {
      if (dragIdRef.current && dragIdRef.current !== id && didMove.current) {
        dragOverRef.current = id;
        setDragOverId(id);
      }
    },
    []
  );

  return { dragOverId, draggingId, handleMouseDown, handleMouseEnter };
}
