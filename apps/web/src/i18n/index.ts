import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "@/locales/en";
import { el } from "@/locales/el";

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "el", label: "Ελληνικά" },
] as const;
export type Language = (typeof LANGUAGES)[number]["code"];

const KEY = "fp-lang";

function detect(): Language {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "el") return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("el") ? "el" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en, el },
  lng: detect(),
  fallbackLng: "en",
  defaultNS: "common",
  ns: Object.keys(en),
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

if (typeof document !== "undefined") document.documentElement.lang = i18n.language;

export function setLanguage(lng: Language) {
  try {
    localStorage.setItem(KEY, lng);
  } catch {
    /* storage unavailable */
  }
  document.documentElement.lang = lng;
  void i18n.changeLanguage(lng);
}

export default i18n;
