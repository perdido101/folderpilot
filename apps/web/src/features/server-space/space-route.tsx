import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HardDrive } from "lucide-react";
import { PlaceholderPage } from "@/pages/placeholder-page";
import { useActiveServerSpace } from "./api";
import type { ActiveServerSpace } from "./space-header";

/** Show the server-space view when a server space is selected, else the page for folders on this device. */
export function SpaceRoute({ device, server, phase }: { device: ReactNode; server?: (space: ActiveServerSpace) => ReactNode; phase?: number }) {
  const { t } = useTranslation("spaces");
  const space = useActiveServerSpace();
  if (!space) return <>{device}</>;
  if (server) return <>{server(space)}</>;
  return <PlaceholderPage icon={HardDrive} title={t("notYet.title")} description={t("notYet.description", { phase })} phase={phase} />;
}
