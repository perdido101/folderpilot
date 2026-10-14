import { useTranslation } from "react-i18next";
import { Link2 } from "lucide-react";
import { PlaceholderPage } from "@/pages/placeholder-page";

/** Share links are a FolderPilot Cloud feature (Phase 7). */
export function SharedPage() {
  const { t } = useTranslation("pages");
  return <PlaceholderPage icon={Link2} title={t("shared.title")} description={t("shared.description")} phase={7} />;
}
