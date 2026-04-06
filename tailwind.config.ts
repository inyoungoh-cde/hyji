import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "var(--bg-primary)",
          secondary: "var(--bg-secondary)",
          tertiary: "var(--bg-tertiary)",
        },
        border: "var(--border)",
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          tertiary: "var(--text-tertiary)",
        },
        accent: "var(--accent)",
        status: {
          surveyed: "var(--status-surveyed)",
          reviewed: "var(--status-reviewed)",
          revisit: "var(--status-revisit)",
        },
        importance: {
          noted: "var(--importance-noted)",
          relevant: "var(--importance-relevant)",
          mustcite: "var(--importance-mustcite)",
        },
      },
      borderRadius: {
        DEFAULT: "8px",
        card: "12px",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "'Segoe UI'",
          "sans-serif",
        ],
        mono: ["'SF Mono'", "'Cascadia Code'", "'Fira Code'", "monospace"],
      },
      fontSize: {
        title: "18px",
        section: "12px",
        body: "13px",
        small: "11px",
      },
    },
  },
  plugins: [],
} satisfies Config;
