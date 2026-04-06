import { useRef, useCallback, useEffect } from "react";
import type { NoteLink } from "../../types";

interface BulletEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  noteLinks: NoteLink[];
  noteField?: string;
  onLinkClick: (annotationId: string, noteField?: string) => void;
  onDeleteLink?: (link: NoteLink) => void;
}

export function BulletEditor({
  value,
  onChange,
  placeholder,
  noteLinks,
  noteField,
  onLinkClick,
  onDeleteLink,
}: BulletEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isComposing = useRef(false);

  const bullets = value ? value.split("\n") : [];

  // Sync div content with value (only when not focused)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || el === document.activeElement) return;
    renderBullets(el, bullets, noteLinks, noteField, onLinkClick, onDeleteLink);
  }, [value, noteLinks, noteField, onLinkClick, onDeleteLink]);

  const handleInput = useCallback(() => {
    if (isComposing.current) return;
    const el = containerRef.current;
    if (!el) return;

    // If the editor has raw text (no bullet divs), wrap it in a bullet structure.
    // This happens when the user types into an empty editor for the first time.
    const hasBulletDivs = el.querySelector("[data-bullet]");
    if (!hasBulletDivs && el.textContent) {
      const rawText = el.textContent;
      const sel = window.getSelection();
      // Convert to bullet structure
      el.innerHTML = "";
      const { div, textSpan } = makeBulletDiv(false);
      textSpan.textContent = "•\u00A0" + rawText;
      el.appendChild(div);
      // Restore cursor to end
      if (sel) {
        const range = document.createRange();
        const textNode = textSpan.firstChild as Text;
        range.setStart(textNode, textNode.length);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    const lines = extractLines(el);
    onChange(lines.join("\n"));
  }, [onChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const el = containerRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;

      if (e.key === "Enter") {
        e.preventDefault();
        const isSub = e.shiftKey;
        const { div: newBullet, textSpan } = makeBulletDiv(isSub);

        const anchorDiv =
          sel.anchorNode?.parentElement?.closest("[data-bullet]") ??
          sel.anchorNode;
        if (anchorDiv && anchorDiv.parentNode === el) {
          anchorDiv.parentNode.insertBefore(newBullet, anchorDiv.nextSibling);
        } else {
          el.appendChild(newBullet);
        }

        // Place cursor after the "• " / "◦ " prefix
        const textNode = textSpan.firstChild as Text;
        const range = document.createRange();
        range.setStart(textNode, 2);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        handleInput();

      } else if (e.key === "Backspace") {
        const range = sel.getRangeAt(0);
        if (!range.collapsed || range.startOffset !== 0) return;

        const currentDiv =
          (sel.anchorNode?.parentElement?.closest("[data-bullet]") as HTMLElement | null) ??
          (sel.anchorNode instanceof HTMLElement ? sel.anchorNode : null);

        if (!currentDiv || !currentDiv.previousSibling) return;
        e.preventDefault();

        const prev = currentDiv.previousSibling as HTMLElement;

        // Extract text after the bullet prefix from current div
        const currentSpan = currentDiv.querySelector("span:first-child") as HTMLElement | null;
        const rawText = currentSpan?.textContent ?? currentDiv.textContent ?? "";
        const textToAppend = rawText.replace(/^[•◦][\s\u00A0]?/, "");

        // Append to previous div's text span
        const prevSpan = prev.querySelector("span:first-child") as HTMLElement | null;
        if (prevSpan) {
          prevSpan.textContent = (prevSpan.textContent ?? "") + textToAppend;
        } else {
          prev.textContent = (prev.textContent ?? "") + textToAppend;
        }

        currentDiv.remove();

        // Move cursor to end of prev
        const newRange = document.createRange();
        const targetNode = prevSpan?.firstChild ?? prevSpan ?? prev;
        if (targetNode instanceof Text) {
          newRange.setStart(targetNode, targetNode.length);
        } else {
          newRange.selectNodeContents(targetNode);
          newRange.collapse(false);
        }
        sel.removeAllRanges();
        sel.addRange(newRange);
        handleInput();
      }
    },
    [handleInput]
  );

  return (
    <div className="relative">
      <div
        ref={containerRef}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { isComposing.current = true; }}
        onCompositionEnd={() => {
          isComposing.current = false;
          handleInput();
        }}
        data-placeholder={placeholder}
        className="min-h-[60px] rounded-[8px] px-3 py-2 outline-none border border-transparent focus:border-accent/20 transition-colors selectable text-body text-text-primary [&:empty]:before:content-[attr(data-placeholder)] [&:empty]:before:text-text-tertiary [&:empty]:before:pointer-events-none"
        style={{ backgroundColor: "var(--bg-tertiary)" }}
      />
    </div>
  );
}

// --- Helpers ---

function makeBulletDiv(isSub: boolean): { div: HTMLDivElement; textSpan: HTMLSpanElement } {
  const div = document.createElement("div");
  div.setAttribute("data-bullet", isSub ? "sub" : "main");
  div.style.cssText = `
    display: flex; align-items: baseline; gap: 4px;
    padding-left: ${isSub ? "32px" : "16px"};
    min-height: 20px;
  `;
  const textSpan = document.createElement("span");
  textSpan.style.cssText = "flex: 1;";
  textSpan.textContent = isSub ? "◦\u00A0" : "•\u00A0";
  div.appendChild(textSpan);
  return { div, textSpan };
}

function renderBullets(
  container: HTMLDivElement,
  bullets: string[],
  noteLinks: NoteLink[],
  noteField: string | undefined,
  onLinkClick: (annotationId: string, noteField?: string) => void,
  onDeleteLink?: (link: NoteLink) => void
) {
  container.innerHTML = "";
  if (bullets.length === 0 || (bullets.length === 1 && !bullets[0])) return;

  bullets.forEach((text, i) => {
    const isSub = text.startsWith("  ");
    const cleanText = isSub ? text.slice(2) : text;

    const { div, textSpan } = makeBulletDiv(isSub);
    textSpan.textContent = (isSub ? "◦\u00A0" : "•\u00A0") + cleanText;

    const link = noteLinks.find((nl) => nl.bullet_index === i);
    if (link) {
      const linkIcon = document.createElement("span");
      linkIcon.textContent = "🔗";
      linkIcon.style.cssText = "cursor:pointer; font-size:10px; opacity:0.6; flex-shrink:0;";
      linkIcon.title = "Go to annotation in PDF";
      linkIcon.addEventListener("click", (e) => {
        e.stopPropagation();
        onLinkClick(link.annotation_id, noteField);
      });
      div.appendChild(linkIcon);

      if (onDeleteLink) {
        const delBtn = document.createElement("span");
        delBtn.textContent = "×";
        delBtn.style.cssText =
          "cursor:pointer; font-size:14px; opacity:0.35; flex-shrink:0; line-height:1; color:var(--status-revisit);";
        delBtn.title = "Remove this linked bullet";
        delBtn.addEventListener("mouseenter", () => { delBtn.style.opacity = "0.9"; });
        delBtn.addEventListener("mouseleave", () => { delBtn.style.opacity = "0.35"; });
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          // Remove from DOM immediately for instant feedback
          div.remove();
          onDeleteLink(link);
        });
        div.appendChild(delBtn);
      }
    }

    container.appendChild(div);
  });
}

function extractLines(container: HTMLDivElement): string[] {
  const lines: string[] = [];
  const children = container.childNodes;

  if (children.length === 0) {
    const text = container.textContent || "";
    if (text) return text.split("\n").filter(Boolean);
    return [];
  }

  children.forEach((node) => {
    const el = node as HTMLElement;
    const isSub = el.getAttribute?.("data-bullet") === "sub";
    // Prefer the first <span> child (rendered structure); fall back to full textContent
    const textSpan = el.querySelector?.("span:first-child") as HTMLElement | null;
    const rawText = textSpan ? (textSpan.textContent ?? "") : (el.textContent ?? "");
    let text = rawText.replace(/^[•◦][\s\u00A0]?/, "").trim();
    if (isSub) text = "  " + text;
    lines.push(text);
  });

  return lines;
}
