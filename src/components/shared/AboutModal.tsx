import { useEffect } from "react";
import { open } from "@tauri-apps/plugin-shell";
import iconUrl from "../../../src-tauri/icons/128x128.png";

const VERSION = "0.1.4";
const BUILD_INFO = "Apr 2026 — Windows 64-bit";
const GITHUB_URL = "https://github.com/inyoungoh-cde/hyji";

interface Props {
  onClose: () => void;
}

export function AboutModal({ onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onMouseDown={onClose}
    >
      <div
        className="flex flex-col items-center text-center"
        style={{
          background: "#161b22",
          border: "0.5px solid #30363d",
          borderRadius: 12,
          padding: "32px 36px",
          maxWidth: 420,
          width: "100%",
          gap: 0,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Icon */}
        <img
          src={iconUrl}
          alt="HYJI icon"
          style={{ width: 72, height: 72, borderRadius: 14, marginBottom: 14 }}
          draggable={false}
        />

        {/* App name */}
        <div style={{ fontSize: "1.846rem", fontWeight: 500, color: "var(--text-primary)", marginBottom: 6 }}>
          HYJI
        </div>

        {/* Tagline */}
        <div style={{ fontSize: "1rem", color: "var(--text-secondary)", marginBottom: 18 }}>
          Highlight Your Journey of Insights
        </div>

        {/* Divider */}
        <div style={{ width: "100%", height: 1, background: "#30363d", marginBottom: 16 }} />

        {/* Version */}
        <div style={{ fontSize: "1rem", color: "var(--text-secondary)", marginBottom: 14 }}>
          Version {VERSION} ({BUILD_INFO})
        </div>

        {/* Description */}
        <div style={{ fontSize: "0.923rem", color: "var(--text-tertiary)", lineHeight: 1.65, marginBottom: 20 }}>
          A free, open-source research hub for reading,<br />
          annotating, and tracking academic papers.<br />
          Built with Tauri + React + pdf.js
        </div>

        {/* GitHub button */}
        <button
          onClick={() => open(GITHUB_URL)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 16px",
            borderRadius: 20,
            background: "rgba(88,166,255,0.15)",
            border: "1px solid rgba(88,166,255,0.25)",
            color: "#58a6ff",
            fontSize: "1rem",
            fontWeight: 500,
            cursor: "pointer",
            marginBottom: 20,
            transition: "background 150ms ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(88,166,255,0.25)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(88,166,255,0.15)")}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
              0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
              -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
              .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
              -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0
              1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82
              1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01
              1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          GitHub
        </button>

        {/* License / author row */}
        <div style={{
          display: "flex",
          gap: 20,
          fontSize: "0.923rem",
          color: "var(--text-tertiary)",
          marginBottom: 20,
        }}>
          <span>License: MIT</span>
          <span>Made by HJ &amp; IY</span>
        </div>

        {/* Divider */}
        <div style={{ width: "100%", height: 1, background: "#30363d", marginBottom: 18 }} />

        {/* OK button */}
        <button
          onClick={onClose}
          className="px-6 py-1.5 rounded text-body font-medium bg-bg-tertiary hover:bg-border text-text-primary transition-colors"
        >
          OK
        </button>
      </div>
    </div>
  );
}
