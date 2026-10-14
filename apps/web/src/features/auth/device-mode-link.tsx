import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useMode } from "@/stores/mode";

/** Private mode on this computer only — no account, nothing sent to a server. */
export function DeviceModeLink() {
  const { t } = useTranslation("auth");
  const setMode = useMode((s) => s.setMode);
  const navigate = useNavigate();
  return (
    <button
      className="text-accent hover:underline"
      onClick={() => {
        setMode("device");
        navigate("/");
      }}
    >
      {t("deviceMode.link")}
    </button>
  );
}
