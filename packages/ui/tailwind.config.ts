import type { Config } from "tailwindcss";

/**
 * Design tokens per Phase 15 spec. Palette is pinned exactly to the
 * documented Binance-inspired scheme; changing values here is a
 * design-system-level edit.
 *
 * Hex colors are duplicated in `app/globals.css` as CSS variables so
 * non-Tailwind consumers (and the CLS-minimising critical CSS) can
 * read them at runtime.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          0: "#0B0E11",
          1: "#14181F",
          2: "#1E2329",
          3: "#2B3139",
        },
        border: {
          subtle: "#2B3139",
          default: "#3C424B",
          strong: "#5E6673",
        },
        text: {
          primary: "#EAECEF",
          secondary: "#B7BDC6",
          tertiary: "#848E9C",
          disabled: "#5E6673",
        },
        accent: {
          DEFAULT: "#FCD535",
          hover: "#FFD84D",
          muted: "#FCD53522",
        },
        green: {
          DEFAULT: "#2EBD85",
          bg: "#2EBD8515",
        },
        red: {
          DEFAULT: "#F6465D",
          bg: "#F6465D15",
        },
        blue: { DEFAULT: "#4A78E0" },
        orange: { DEFAULT: "#F0B90B" },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      fontSize: {
        "table-dense": ["11px", "16px"],
        secondary: ["12px", "16px"],
        default: ["14px", "21px"],
        subhead: ["16px", "24px"],
        "page-title": ["20px", "25px"],
        kpi: ["28px", "35px"],
        "kpi-hero": ["36px", "45px"],
      },
      borderRadius: {
        md: "6px",
        lg: "8px",
      },
      transitionTimingFunction: {
        "ease-out-snappy": "cubic-bezier(0.4, 0, 0.2, 1)",
      },
      transitionDuration: {
        "150": "150ms",
        "200": "200ms",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "skeleton-pulse": {
          "0%,100%": { opacity: "0.4" },
          "50%": { opacity: "0.7" },
        },
      },
      animation: {
        "fade-up": "fade-up 200ms cubic-bezier(0.4, 0, 0.2, 1) both",
        "skeleton-pulse": "skeleton-pulse 1.5s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
