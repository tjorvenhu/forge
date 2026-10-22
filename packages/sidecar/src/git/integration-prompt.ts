import { ForgeError, type GitIntegrationConflict, type Session } from "@forge/protocol";
import { tr } from "../i18n/index.js";

/** `details.integration` of a GIT_CONFLICT from push or pull; null for every other error. */
export function integrationConflict(e: unknown): GitIntegrationConflict | null {
  if (!(e instanceof ForgeError) || e.code !== "GIT_CONFLICT") return null;
  return (e.details as { integration?: GitIntegrationConflict } | undefined)?.integration ?? null;
}

/**
 * Origin's commits did not go in automatically: Claude takes over in a new session of the project.
 * Null when `e` is no such conflict; the caller then reports `e` as it is.
 */
export async function startIntegrationSession(
  sessions: { start(p: { projectId: string; prompt: string }): Promise<Session> },
  projectId: string,
  e: unknown,
  push: boolean,
): Promise<Session | null> {
  const integration = integrationConflict(e);
  if (!integration) return null;
  return sessions.start({ projectId, prompt: integrationPrompt(integration, push) });
}

/** Task for the Claude session that takes over origin's commits after FORGE could not do it automatically. */
export function integrationPrompt(c: GitIntegrationConflict, push: boolean): string {
  const remote = `origin/${c.branch}`;
  const m = tr().system.integrationPrompt;
  const files = c.files.length ? c.files.map((f) => `- ${f}`).join("\n") : m.noFiles;
  const intro = push ? m.introPush(c.branch) : m.introPull(c.branch);
  const situation = c.stash
    ? [m.stashSituation(intro, remote), files]
    : c.merge
      ? [m.mergeSituation(intro, remote, c.remoteCommits, c.localCommits), files, "", m.mergeAborted]
      : [m.rebaseSituation(intro, remote, c.remoteCommits, c.localCommits), files, "", m.rebaseAborted];
  const steps = c.stash ? [m.stashStep] : [c.merge ? m.mergeStep(remote) : m.rebaseStep(remote), m.bothSides];
  steps.push(m.ask, m.verify, push ? m.push(c.branch) : m.noPush);
  return [...situation, "", m.please, ...steps.map((s, i) => `${i + 1}. ${s}`), "", m.summary].join("\n");
}
