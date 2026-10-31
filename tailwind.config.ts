import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        mari: {
          950: "#070c18",
          900: "#0B132B",
          850: "#141d38",
          800: "#1C2541",
          700: "#2B3760",
          600: "#3A506B",
          500: "#4B6B94",
          gold: {
            DEFAULT: "#F59E0B",
            light: "#FDE68A",
            dark: "#D97706",
            glow: "rgba(245, 158, 11, 0.15)",
          },
          green: {
            DEFAULT: "#10B981",
            light: "#A7F3D0",
            dark: "#059669",
          },
          red: {
            DEFAULT: "#EF4444",
            light: "#FECACA",
            dark: "#DC2626",
          },
          blue: {
            DEFAULT: "#3B82F6",
            light: "#BFDBFE",
            dark: "#2563EB",
          }
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      boxShadow: {
        glow: "0 0 25px -5px rgba(245, 158, 11, 0.2)",
        subtle: "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)",
        card: "0 4px 6px -1px rgba(0, 0, 0, 0.2), 0 2px 4px -2px rgba(0, 0, 0, 0.2)",
        cardHover: "0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -4px rgba(0, 0, 0, 0.3)",
      },
    },
  },
  plugins: [],
  // The legacy design system's base.css is the reset; Tailwind's would fight it.
  corePlugins: { preflight: false },
};

export default config;
