import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

// Clean Ledger tokens are defined as CSS variables in src/index.css.
// shadcn/ui names (background, primary, ...) are mapped onto them so stock components fit the theme.
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        surface: v("surface"),
        "surface-2": v("surface-2"),
        border: v("border"),
        text: v("text"),
        muted: v("muted"),
        accent: { DEFAULT: v("accent"), soft: v("accent-soft"), foreground: v("accent-foreground") },
        success: v("success"),
        warning: v("warning"),
        danger: v("danger"),
        // shadcn aliases
        background: v("bg"),
        foreground: v("text"),
        input: v("border"),
        ring: v("accent"),
        primary: { DEFAULT: v("accent"), foreground: v("accent-foreground") },
        secondary: { DEFAULT: v("surface-2"), foreground: v("text") },
        destructive: { DEFAULT: v("danger"), foreground: v("accent-foreground") },
        popover: { DEFAULT: v("surface"), foreground: v("text") },
        card: { DEFAULT: v("surface"), foreground: v("text") },
        "muted-foreground": v("muted"),
      },
      borderRadius: {
        lg: "8px",
        md: "6px",
        sm: "4px",
      },
      fontFamily: {
        sans: ['"Inter Variable"', "Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      transitionTimingFunction: { DEFAULT: "cubic-bezier(0, 0, 0.2, 1)" },
      transitionDuration: { DEFAULT: "150ms" },
    },
  },
  plugins: [animate],
} satisfies Config;
