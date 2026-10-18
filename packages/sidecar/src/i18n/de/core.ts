import { app } from "./core/app.js";
import { automation } from "./core/automation.js";
import { claude } from "./core/claude.js";
import { forgeTools } from "./core/forge-tools.js";
import { knowledge } from "./core/knowledge.js";
import { preview } from "./core/preview.js";
import { reports } from "./core/reports.js";
import { sessions } from "./core/sessions.js";
import { templates } from "./core/templates.js";

/** German texts (core), one file per area under core/. Source of the keys: the English file is typed against this one. */
export const core = { app, automation, claude, forgeTools, knowledge, preview, reports, sessions, templates };
