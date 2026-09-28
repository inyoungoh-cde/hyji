import { useCallback, useRef } from "react";

interface SplitterProps {
  onResize: (delta: number) => void;
  /** Double-click: restore this panel's default width. */
  onReset?: () => void;
  direction?: "left" | "right";
}

export function Splitter({ onResize, onReset, direction = "left" }: SplitterProps) {
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      let lastX = e.clientX;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - lastX;
        lastX = ev.clientX;
        onResizeRef.current(direction === "left" ? delta : -delta);
      };

      const onMouseUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [direction]
  );

  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onReset}
      title={onReset ? "Drag to resize · double-click to reset" : undefined}
      className="w-[6px] shrink-0 cursor-col-resize bg-bg-primary hover:bg-accent/30 transition-colors duration-150"
    />
  );
}
