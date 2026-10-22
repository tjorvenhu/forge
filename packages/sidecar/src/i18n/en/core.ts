import type { core as De } from "../de/core.js";
import { app } from "./core/app.js";
import { automation } from "./core/automation.js";
import { claude } from "./core/claude.js";
import { crew } from "./core/crew.js";
import { forgeTools } from "./core/forge-tools.js";
import { knowledge } from "./core/knowledge.js";
import { preview } from "./core/preview.js";
import { reports } from "./core/reports.js";
import { sessions } from "./core/sessions.js";
import { teams } from "./core/teams.js";
import { templates } from "./core/templates.js";

export const core: typeof De = { app, automation, claude, crew, forgeTools, knowledge, preview, reports, sessions, teams, templates };
