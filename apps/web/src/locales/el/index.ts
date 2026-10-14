import type { en } from "../en";
import type { LocaleShape } from "../shape";
import common from "./common.json";
import shell from "./shell.json";
import auth from "./auth.json";
import admin from "./admin.json";
import files from "./files.json";
import intake from "./intake.json";
import cleanup from "./cleanup.json";
import review from "./review.json";
import categories from "./categories.json";
import rules from "./rules.json";
import plans from "./plans.json";
import audit from "./audit.json";
import trash from "./trash.json";
import settings from "./settings.json";
import agent from "./agent.json";
import palette from "./palette.json";
import mini from "./mini.json";
import actions from "./actions.json";
import pages from "./pages.json";

/** Greek. Typed against English, so a missing namespace or key fails the type-check. */
export const el: LocaleShape<typeof en> = { common, shell, auth, admin, files, intake, cleanup, review, categories, rules, plans, audit, trash, settings, agent, palette, mini, actions, pages };
