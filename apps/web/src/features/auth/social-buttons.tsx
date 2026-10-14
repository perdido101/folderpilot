import { useTranslation } from "react-i18next";
import { Button } from "@folderpilot/ui";
import { useFeatures } from "@/hooks/use-me";
import { authClient } from "@/lib/auth-client";

/** Google / Microsoft sign-in — only shown when the server has them configured. */
export function SocialButtons({ callbackPath = "/" }: { callbackPath?: string }) {
  const { t } = useTranslation("auth");
  const features = useFeatures().data;
  const providers = (["google", "microsoft"] as const).filter((p) => features?.auth[p]);
  if (!providers.length) return null;
  const callbackURL = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}${callbackPath}`;
  return (
    <div className="space-y-2">
      {providers.map((provider) => (
        <Button key={provider} type="button" variant="outline" className="w-full" onClick={() => void authClient.signIn.social({ provider, callbackURL })}>
          {t(`social.${provider}`)}
        </Button>
      ))}
      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-border" />
        {t("social.or")}
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
