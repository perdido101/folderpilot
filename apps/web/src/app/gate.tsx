import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation } from "react-router-dom";
import { CloudOff, Loader2 } from "lucide-react";
import { Button } from "@folderpilot/ui";
import { AuthLayout } from "@/features/auth/auth-layout";
import { useMe } from "@/hooks/use-me";
import { useMode } from "@/stores/mode";

export function Splash() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center text-muted" role="status">
      <Loader2 className="mr-2 size-4 animate-spin" /> {t("status.loading")}
    </div>
  );
}

function ServerUnavailable({ retry }: { retry: () => void }) {
  const { t } = useTranslation(["auth", "common"]);
  const setMode = useMode((s) => s.setMode);
  return (
    <AuthLayout title={t("offline.title")} subtitle={t("offline.subtitle")}>
      <div className="flex items-start gap-3 text-sm text-muted">
        <CloudOff className="mt-0.5 size-4 shrink-0" />
        <p>{t("offline.body")}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Button onClick={retry}>{t("common:actions.retry")}</Button>
        <Button variant="outline" onClick={() => setMode("device")}>
          {t("deviceMode.link")}
        </Button>
      </div>
    </AuthLayout>
  );
}

/**
 * Decides what the user sees:
 * device mode → the app on this computer only; signed out → sign in; no organization → create one.
 */
export function Gate({ children }: { children: ReactNode }) {
  const mode = useMode((s) => s.mode);
  const me = useMe();
  const location = useLocation();
  if (mode === "device") return <>{children}</>;
  if (me.isLoading) return <Splash />;
  // Server down or erroring: offer a retry, or the device-only mode that needs no server.
  if (me.error) return <ServerUnavailable retry={() => void me.refetch()} />;
  if (!me.data) {
    const next = location.pathname + location.search;
    return <Navigate to={`/sign-in${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`} replace />;
  }
  if (!me.data.organizations.length) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}
