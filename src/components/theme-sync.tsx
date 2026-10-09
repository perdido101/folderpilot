import { useEffect } from "react";
import { useUI } from "@/stores/ui";

/** Keeps the `dark` class on <html> in sync with the chosen theme (and the OS when "system"). */
export function ThemeSync() {
  const theme = useUI((s) => s.theme);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  return null;
}
