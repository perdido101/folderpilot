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
import spaces from "./spaces.json";
import search from "./search.json";
import connect from "./connect.json";

/** English is the source of truth: every key must exist here first. */
export const en = { common, shell, auth, admin, files, intake, cleanup, review, categories, rules, plans, audit, trash, settings, agent, palette, mini, actions, pages, spaces, search, connect };

export type Namespace = keyof typeof en;
