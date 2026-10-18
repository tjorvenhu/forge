import type { automation as De } from "../../de/core/automation.js";

export const automation: typeof De = {
  // worktrees.ts
  slugFallback: "task",
  needsGitRepo: "Worktrees need a Git repository.",
  needsCommit: "The repository needs at least one commit.",
  invalidBranch: (branch) => `Invalid branch name: ${branch}`,
  originNoCommit: "The starting point has no commit yet.",
  createFailed: "Could not create the worktree",
  snapshotFailed: (detail) => `Uncommitted changes not carried over: ${detail}`,
  gitStepFailed: (command) => `git ${command} failed`,
  snapshotCommit: (branch) => `FORGE: uncommitted changes${branch ? ` of ${branch}` : ""} for the agent`,
  removeFailed: "Could not remove the worktree",
  notWorktreeProject: "This is not a worktree project.",
  uncommittedChanges: (n) => `The worktree has ${n} uncommitted ${n === 1 ? "change" : "changes"}.`,
  branchUnknown: "Could not determine the worktree's branch anymore.",
  repoNotFound: (dir) => `Could not find the repository of this worktree: ${dir}`,
  folderInUse: (detail) =>
    `The worktree folder is still in use by another program, such as a terminal, editor or Explorer window. Close it and try again. (${detail})`,
  foreignBranch: (branch) => `FORGE did not create the branch ${branch} for this agent, so it is kept.`,

  // agent-finish.ts
  notAgentWorktree: "This is not an agent worktree.",
  blockerFolderMissing: "The agent's folder is missing.",
  blockerTargetGone: "The project the work should go back to no longer exists.",
  blockerNoBranch: "No branch is checked out in the agent's worktree.",
  blockerNoTargetBranch: "No branch is checked out in the project.",
  blockerBusy: "The agent is still working.",
  blockerOtherBranch: (origin, target) =>
    `The agent branched off ${origin}, but the project now has ${target} checked out. Switch back to ${origin} there.`,
  blockerNoWork: "The agent did not change anything.",
  discardedBranchKept: (error) => `Agent discarded, but the branch was kept: ${error}`,
  discardedForeign: (foreign) => `Agent discarded. ${foreign}`,
  discarded: (branch) => `Agent discarded${branch ? `, branch ${branch} deleted` : ""}.`,
  remainingCommit: (branch) => `Remaining changes from ${branch}`,
  conflictMessage: (target, files) =>
    `${target} has changed since the agent started and the changes conflict${files.length ? ` in ${files.join(", ")}` : ""}. The agent is resolving the conflicts now; afterwards you can merge again.`,
  commitsTaken: (commits, branch, target) => `Took ${commits === 1 ? "1 commit" : `${commits} commits`} from ${branch} into ${target}`,
  folderNotDeleted: (done, why) => `${done}. But the worktree folder could not be deleted: ${why}`,
  mergedAllDeleted: (done) => `${done}, worktree and branch deleted.`,
  mergedWorktreeDeleted: (done, rest) => `${done}, worktree deleted. ${rest}`,
  branchKept: (error) => `But the branch was kept: ${error}`,
  notTaken: (branch, target) => `Could not take ${branch} into ${target}.`,
  notMergedYet: (why) => `Not merged yet: ${why}`,
  waitSessionBusy: (target, files) =>
    `A session is working in ${target} right now, and there are uncommitted changes to files the agent also changed (${files.join(", ") || "see git status"}).`,
  waitUntracked: (files) => `The project has new, uncommitted files the agent created as well: ${files.join(", ")}.`,
  dryRunFailed: "The merge dry run failed.",
  waitClash: (files) =>
    `The uncommitted changes in the project and the agent's work touch the same lines${files.length ? ` in ${files.join(", ")}` : ""}.`,
  stashMessage: (branch) => `FORGE: set aside while merging ${branch}`,
  stashFailed: "Could not set aside the open changes.",
  stashPopFailed: (detail) =>
    `Could not fully restore the open changes in the project; they are still in the stash (git stash list). ${detail}`,
  conflictPrompt: (branch, target, behind, files) =>
    [
      `I wanted to take your branch ${branch} into ${target}. Since you started, ${target} has ${behind} new ${behind === 1 ? "commit that conflicts" : "commits that conflict"} with your changes in:`,
      files.length ? files.map((f) => `- ${f}`).join("\n") : "- (git did not name any files)",
      "",
      "Your branch is unchanged.",
      "",
      "Please:",
      `1. Commit everything open first, then run \`git merge ${target}\` (no rebase: that way you resolve each conflict only once).`,
      "2. Resolve the conflicts so that both your changes and the new commits are kept. If it is unclear which side should win, ask me with AskUserQuestion instead of guessing.",
      "3. Then check that the project still builds and the tests pass, if there is a command for that.",
      "4. Do not push. At the end, briefly summarize how you resolved each conflict. FORGE then takes over your branch.",
    ].join("\n"),

  // agent-auto-merge.ts
  waitingBackground: "Waiting to merge: the agent still has background tasks running. FORGE merges it as soon as they finish.",
  notAutoMerged: (reason) => `Not merged automatically: ${reason}`,
  testsFailed: "The tests failed.",
  conflictsRemain: (target, rounds) => `The conflicts with ${target} are still there after ${rounds} attempts.`,
  waitingMerge: (why) =>
    `Waiting to merge: ${why} FORGE merges the agent on its own as soon as it can: after the next turn in the project (including its auto-commit), otherwise on the next attempt in half a minute.`,
  autoMerged: (message) => `Merged automatically: ${message}`,

  // worktree-setup.ts
  stepFiles: "Local configuration",
  stepDeps: "Dependencies",
  stepBuild: "Build output",
  stepDatabase: "Test database",
  stepDevserver: "Dev server",
  ownPortFlag: (port) => `This agent's own port: ${port}`,
  ownPortEnv: (port) => `This agent's own port: ${port} (passed as PORT; a server that does not read it uses its own)`,
  setupRunningFor: (time) => `running for ${time}`,
  setupFinished: (failed, time) => `${failed ? "finished with errors" : "done"} after ${time}`,
  statusPending: "waiting",
  statusRunning: "running",
  statusDone: "done",
  statusSkipped: "skipped",
  statusFailed: "failed",
  setupHeader: (head) => `Worktree preparation (FORGE, ${head}):`,
  setupFailedHint: "  You can redo what failed yourself, for example the install with the same command.",
  contextPort: (port) => ` Your dev server has its own port (${port}), separate from the main project; dev_control starts it.`,
  contextReady: (port) =>
    `Your worktree is prepared like the main folder (dependencies, local configuration, build output, its own test database).${port} dev_environment shows the status and any errors.`,
  contextRunning: (steps) =>
    `FORGE is preparing your worktree like the main folder right now (${steps.join(", ")}). Do not install dependencies yourself, that is already running; until then you can read and plan.`,
  contextWait: "Before the first build, test or dev server start: mcp__forge__dev_environment with wait=true waits until the preparation is done and shows what failed.",
  cancelled: "cancelled",
  mainFolderMissing: "Main folder not found.",
  noLocalConfig: "No local configuration files in the main folder.",
  nothingToCopy: "Nothing to copy.",
  copiedFiles: (names) => {
    const list = names.length > 6 ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more` : names.join(", ");
    return `${names.length} ${names.length === 1 ? "file" : "files"} copied: ${list}`;
  },
  noLockfile: "No lockfile found.",
  installFailed: (command, code, output) => `${command} failed (exit code ${code ?? "?"}): ${output}`,
  rustDeps: (dir) => `Rust dependencies (${dir})`,
  rustDepsFailed: (dir, detail) => `Rust dependencies not copied (${dir}: ${detail})`,
  copied: (dir) => `${dir} copied`,
  notCopied: (dir, error) => `${dir} not copied: ${error}`,
  nothingToTake: "Nothing to take over.",
  robocopyCode: (code) => `robocopy code ${code ?? "?"}`,
  noTestDb: "The project has no test database.",
  ownTestDb: "Own test database already exists.",
  testDbRunning: "The project's database is running right now and cannot be copied that way. The first start creates a new, empty one (run the migrations afterwards).",
  testDbCopied: "Own copy of the project's database, own port on start.",
  noDevCommand: "No dev server command known.",
  port: (port) => `port ${port}`,
  ownPort: "own port",
  devRunning: (port) => `running (${port})`,
  devOnDemand: (port) => `starts when needed (${port})`,
  devExited: (code) => `exited${code !== null ? ` with exit code ${code}` : ""}`,
  devStarted: (port) => `started because the project's is running (${port})`,
};
