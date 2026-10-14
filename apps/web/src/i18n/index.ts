import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "@/locales/en";

// English only for now. Strings stay in locale files so more languages can be added later.
void i18n.use(initReactI18next).init({
  resources: { en },
  lng: "en",
  fallbackLng: "en",
  defaultNS: "common",
  ns: Object.keys(en),
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

if (typeof document !== "undefined") document.documentElement.lang = "en";

export default i18n;
