import type { phoneTools as De } from "../de/phone-tools.js";

/** English descriptions of the phone tools for the model (Claude or Gemini Live). */
export const phoneTools: typeof De = {
  status: {
    description: "Overview: running and recently finished sessions with their short name, status, open approvals and questions, Remote Control.",
  },
  details: {
    description: "The last result of a session, an open question or plan word for word, running background tasks and subagents.",
    params: {
      summary: "true if the caller wants a summary of the whole history (takes a few seconds)",
    },
  },
  send_message: {
    description: "Sends an instruction to a session; Claude Code then keeps working. A closed session is reopened for it.",
    params: {
      text: "Instruction for Claude Code, fully written out",
    },
  },
  start_session: {
    description: "Starts a new Claude Code session in a project, optionally as a parallel agent in its own worktree.",
    params: {
      prompt: "The task, fully written out",
      model: "only if the caller names a model: opus, sonnet or haiku",
      effort: "Thinking effort, only if the caller names it",
      plan_only: "true if Claude should make a plan first",
      agent: "true if the task should run in parallel as its own agent (own worktree and branch from the last commit of the named project or worktree); not in projects where parallel agents are switched off",
      with_changes: "only with agent: true if the agent should also get the uncommitted state of the project",
    },
  },
  respond: {
    description:
      "Answers the open approval, question or plan of a session. allow = allow, accept the plan or answer the question (answers). deny = refuse, or send the plan back with feedback.",
    params: {
      answers: "only for questions: the chosen answer for each question",
      "answers.question": "Question text",
      "answers.answer": "Chosen answer",
      feedback: "with deny: the reason or the change wanted",
      for_session: "only with allow on a tool approval: true allows this tool for the rest of the session without asking again",
    },
  },
  stop_session: {
    description: "Stops the running turn of a session; the session stays open. Says so if nothing is running.",
  },
  close_session: {
    description: "Closes a session (ends its Claude process). It keeps its history and can be continued with send_message.",
  },
  session_settings: {
    description: "Changes the model, thinking effort or mode of a session. Only give what should change.",
    params: {
      model: "opus, sonnet, haiku or a model ID",
      effort: "Thinking effort",
      permission_mode: "default = asks first, acceptEdits = edits without asking, plan = only plans, bypassPermissions = everything without asking",
    },
  },
  cancel_auto_continue: {
    description: "Cancels the planned automatic continuation of a session after a usage limit.",
  },
  background_task: {
    description:
      "Background tasks and subagents of a session, as details lists them. output: what a background command printed last. stop: end one task or subagent, the rest keeps running. to_background: move running foreground work into the background so Claude can go on (without task: all of it). message: send a message (text) from the caller to the task; a subagent gets it through Claude, for a command Claude reads it and reacts itself.",
    params: {
      task: "Description of the task or part of it, as details names it",
      text: "only with message: the message in the caller's words",
    },
  },
  remote_control: {
    description: "Remote Control: connects all running sessions to the Claude app (on), disconnects them (off) or tells the state (status).",
  },
  always_on_top: {
    description:
      "Keeps the FORGE main window on the computer above all other programs (on), releases it (off) or tells the state (status). Detached chat windows are pinned one by one at the computer.",
  },
  chat_window: {
    description:
      "Chat windows on the computer: tells which sessions are open in their own window and which of them are pinned (status), opens a session in its own window (open), brings it back into the main window (close), keeps its window above all other programs (pin, opens it first if needed) or releases it (unpin).",
    params: {
      session: "Short name like S1 or part of the title; not needed for status",
    },
  },
  dev_server: {
    description:
      "Dev server of a project or session: start, stop, restart, tell whether it runs and at which address (status), or read its last output (output), for example to see why it crashed. For agents (each has its own dev server with its own port): setup tells how far FORGE has prepared its worktree (dependencies, configuration, build output, own test database), prepare starts that preparation again, for example after a failed install.",
  },
  test_database: {
    description:
      "Local PostgreSQL test database of a project or session: start, stop, restart, reset (deletes all data, only if the caller explicitly wants it), tell whether it runs (status), or read its log (log), for example when it does not start.",
  },
  dev_settings: {
    description:
      "Dev tool settings of a project: whether the test environment goes to the dev server and tests (use_env), its variables (env_set, env_remove, env_from_file), whether the test database starts with the dev server (with_dev_server), port and name of the test database and the variable with its connection URL (env_var, empty = none). Only give what should change; without anything it tells the current settings. Variable values are never read out, only their names.",
    params: {
      use_env: "Pass the test environment to the dev server and the test command",
      env_set: "Set one variable of the test environment, as NAME=value",
      env_remove: "Name of a variable to remove from the test environment",
      env_from_file: "Take over the variables of this .env file in the project folder, for example .env.local",
      with_dev_server: "The test database starts with the dev server",
      port: "Port of the test database",
      name: "Name of the database: lowercase letters, digits, underscores",
      env_var: "Variable for the connection URL, for example DATABASE_URL; empty passes none",
    },
  },
  project_automation: {
    description:
      "Automation of a project, as in the project settings: plan-first (new sessions plan first), auto-test (test command after a turn that changed code), auto-commit, auto-push, auto-merge (merge finished agents back into the branch they started from), review-required (no auto-commit), no-network (no web tools), sandbox-only (Autonomous blocked). Switch with tag and on; without tag it tells what is on. auto-merge always applies to the main project and its agents.",
    params: {
      tag: "Which automation; leave out for the current state",
      on: "true switches on, false off",
    },
  },
  knowledge: {
    description:
      "Project knowledge: collected decisions, procedures and pitfalls of a project. Search with query, read one entry in full with id, delete an outdated entry with id and delete = true. With cleanup = true tell which entries overlap or are very long; with merge let Claude merge entries on the same topic; with auto_merge = true Claude finds what belongs together itself and merges all of it. With stale = true tell which entries point to files or names that no longer exist (outdated knowledge); with id and mark_checked = true mark such a false alarm as checked; with id and fix = true Claude corrects the entry. For questions like “How do we deploy X?” or “What did we have to watch out for with the database?”.",
    params: {
      query: "Search words, for example deploy or migration; empty for cleanup and merge",
      id: "ID of a hit, to read it in full or delete it",
      delete: "true deletes the entry with id; only if the caller explicitly wants it",
      cleanup: "true names entries that overlap, and very long entries",
      merge: "IDs separated by commas, for example from cleanup; the first entry stays, the others are merged into it. Only if the caller wants it",
      auto_merge: "true: Claude finds entries on the same topic itself and merges them (takes one or two minutes). Only if the caller wants it",
      stale: "true names entries that point to files or names that no longer exist, for example for “Which knowledge is outdated?”",
      mark_checked: "true with id: the missing references of the entry were a false alarm and are no longer reported",
      fix: "true with id: Claude corrects the outdated references of the entry and saves it (takes up to a minute). Only if the caller wants it",
    },
  },
  remember: {
    description:
      "Keeps a note in the project knowledge when the caller says FORGE or Claude should remember something for a project. If there is already an entry on the topic, the note is added to it.",
    params: {
      title: "Short topic, for example Deploy or Customer request checkout",
      text: "The note, fully written out, the way the caller meant it",
    },
  },
  git: {
    description:
      "Git in a project or session (for agents their worktree). status: branch and changes. log: the latest commits. show: what a commit changed (commit), with path the diff of one file in it. diff: what changed in a file (path). commit: commit all changes (without message FORGE writes the message). push: push the current branch, new commits from the server are taken over first. pull: get new commits from the server, own commits go on top by rebase. fetch: only check what is new on the server. branches: local branches. checkout: switch to branch. delete_branch: delete a local branch. restore: set files back to the state of a commit, as uncommitted changes; open work is put aside first. init: create a Git repository. publish: publish the project as a new repository on GitHub, optionally in an organization (owner). account: which GitHub account FORGE is signed in with and in which organizations it can create repositories. identity: tell the name and email for commits or set them with name and email. unpushed: which projects (no project needed) have changes or commits that are not on GitHub yet. push_all: commit and push the open changes in all those projects, so the whole state is on GitHub and work can go on from another computer; main and master only with allow_protected. If the states cannot be merged automatically, FORGE starts a session in which Claude does it. remote: tell the address of the remote origin; with protocol switch it to HTTPS or SSH, with url set a new address, with remove remove it.",
    params: {
      message: "Commit message, only if the caller gives one",
      allow_protected: "Push to main or master; only if the caller explicitly wants it",
      branch: "with checkout and delete_branch: name of the branch",
      create: "only with checkout: true creates the branch",
      force: "only with delete_branch: true also deletes a branch with commits that are nowhere else; only if the caller explicitly wants it",
      commit: "with restore and show: hash, position in the log (1 = newest commit) or words from the commit message",
      path: "with diff and show: file name or part of it",
      private: "only with publish: false publishes publicly, otherwise private",
      owner: "only with publish: GitHub organization the repository is created in; without: personal account",
      name: "with publish: name of the repository; with identity: name for commits",
      email: "only with identity: email for commits",
      url: "only with remote: new address of the remote origin, e.g. git@github.com:name/repo.git",
      protocol: "only with remote: https or ssh, switches the existing address to that transport",
      remove: "only with remote: true removes the remote origin; only if the caller explicitly wants it",
    },
  },
  pull_request: {
    description:
      "Pull request on GitHub for the current branch of a project or session, for example an agent. create: push the branch and open the PR; FORGE writes title and description from the commits. status: state of the PR with CI checks and review.",
    params: {
      draft: "only with create: true opens a draft",
    },
  },
  remove_agent: {
    description:
      "Cleans up an agent: ends its session and removes its worktree. The branch with its commits stays, unless delete_branch = true. Uncommitted changes prevent the removal, unless force = true.",
    params: {
      session: "Short name of the agent session like S2",
      project: "or the name of the agent worktree, for example shop csv-export",
      delete_branch: "true also deletes the agent's branch; only if the caller explicitly wants it",
      force: "true removes it despite uncommitted changes; only if the caller explicitly wants it",
    },
  },
  finish_agent: {
    description:
      "Finishes an agent that is done. review: tells first what it did (commits, files, uncommitted work, its summary) and whether merging is possible right now. merge: takes its work into the branch it branched off from, afterwards worktree and branch are gone. discard: throws its work away, worktree and branch are deleted. If the rebase has conflicts, the agent resolves them and it continues with merge afterwards.",
    params: {
      session: "Short name of the agent session like S2",
      project: "or the name of the agent worktree, for example shop csv-export",
      action: "review: check; merge: merge; discard: throw away, only if the caller explicitly wants it",
    },
  },
  projects: {
    description: "List of the projects with their group, Git branch and whether a dev server is running.",
  },
  project: {
    description:
      "Manages projects. info: profile, default model, thinking effort, test and dev command, favorite, whether with Git and whether parallel agents are allowed. create: create a new project name (in path or in the projects folder from the settings), optionally with a GitHub repository right away (also in an organization) or without Git at all. import: add an existing folder path, with or without Git, optionally with a GitHub repository right away. clone: clone repository url, also by the name of a GitHub repository of the account. remove: remove the project from FORGE; folder and GitHub repository only with delete_folder or delete_github_repo. rename: new name. favorite: mark as favorite or not. group: put the project into the group group (for example by client), without group take it out of its group. rename_group: rename group group to name, for all its projects. dissolve_group: dissolve group group, the projects stay. settings: set profile, default model, thinking effort, test and dev command, switch Git on or off and allow or switch off parallel agents; only give what should change.",
    params: {
      project: "Project name or part of it; not for create, import and clone",
      name: "create: name of the new project; rename: the new name; rename_group: new name of the group; clone: folder name",
      path: "import: the folder; create and clone: the folder the project is created in, only if the caller names one",
      url: "clone: Git URL or name of a GitHub repository",
      git: "create and import: false sets the project up without Git at all (no Git areas, no agents, Claude does not use Git), but a folder with .git is always added with Git; settings: true switches Git on, false off",
      agents:
        "settings: false switches parallel agents off for the project, true allows them again. Before switching off, tell the caller that Claude then works less efficiently: tasks run one after another instead of at the same time",
      github: "create and import: also create a GitHub repository, private or public",
      owner: "create and import with github: GitHub organization the repository is created in; without: personal account",
      delete_folder: "remove: true also deletes the folder; only if the caller explicitly wants it, they have to confirm it on the keypad afterwards",
      delete_github_repo:
        "remove: true deletes the whole GitHub repository; only if the caller explicitly wants to delete the repository, never for branches. They have to confirm it on the keypad afterwards",
      favorite: "favorite: true marks it, false removes the mark",
      group: "group: name of the group, for example a client; empty takes the project out of its group. rename_group and dissolve_group: the existing group",
      profile: "settings: safe asks a lot, balanced is the default, autonomous works without asking",
      default_model: "settings: opus, sonnet, haiku or a model ID; default uses the global setting",
      default_effort: "settings: thinking effort of new sessions; default uses the global setting",
      test_command: "settings: test command, for example pnpm test; empty removes it; saved in .forge/project.json in the repository",
      dev_command: "settings: command for the dev server, for example pnpm dev; empty uses the detected one; saved in .forge/project.json in the repository",
    },
  },
  files: {
    description:
      "Looks at the files of a project or session. list: contents of a folder (without path the project folder). read: read a text file. find: find a file by its name (path = name or end of the path).",
    params: {
      path: "Path relative to the project, for example src or package.json",
    },
  },
  claude_md: {
    description:
      "Instructions for Claude Code in the CLAUDE.md. list: which there are. read: read it out. append: add text at the end. scope global applies to all projects, project is the CLAUDE.md in the project (gets committed), local applies only to the owner (CLAUDE.local.md), project-dir is .claude/CLAUDE.md.",
    params: {
      project: "Project name; leave out for the global CLAUDE.md",
      scope: "if not given: project when a project is named, otherwise global",
      text: "only with append: the new instruction, fully written out",
    },
  },
  sessions: {
    description:
      "All sessions, also older and closed ones. list: list them, optionally filtered by project, search words (query) or status; the short names then work for the other tools. delete: delete one session. delete_all: delete all sessions. fork: branch the history into a new session, all of it or up to before a message (messages_back). handoff: continue a long session in a new one; every message sends the whole history again, so a long session uses a lot of the limit. Claude summarizes the history once as a handoff, the new session knows everything and starts small; the old one stays. rewind: set files back to the state before a message of the caller; the history stays. edit: replace a message of the caller with text; a running turn stops and Claude continues with the new text as if the old message had never been sent. ui_compare: whether the last turn has a before and after comparison of the web app (page, changed UI files, state); the images themselves are only on the computer. ui_compare_retake: take the after image again. templates: list prompt templates (saved, recurring tasks with placeholders like {file}), with project the global ones and those of the project. template_send: send a template (template) with values for its placeholders (values) to a session (session) or start a new session in project with it; if values are missing FORGE names them, then ask the caller for them. template_save: create a template (name, text, optional description, with project only for that project) or change an existing one with template. template_delete: delete a template. template_move: move a template up or down in its list (direction). template_learn: learn recurring tasks from the latest messages as templates now (FORGE does this on its own otherwise, learned templates are marked). day_report: daily report for “What happened today?”: sessions with turns, agents (merged, discarded, waiting), commits, what is open and the calls; with summary a short summary by Claude.",
    params: {
      session: "with delete, fork, handoff, rewind, edit, ui_compare and ui_compare_retake: short name like S1 or part of the title",
      project: "with list and day_report: only this project",
      days_back: "with day_report: which day, 0 today (default), 1 yesterday",
      summary: "with day_report: true for a short summary by Claude (takes a few seconds)",
      query: "with list: words from the title",
      status: "with list: only sessions in this state",
      keep_transcript: "with delete and delete_all: true keeps the history at Claude Code",
      messages_back: "with fork, rewind and edit: which message of the caller, counted from the end (1 = the last one); fork without it takes the whole history",
      rewind_files: "with fork: true also sets the files back to the state before that message",
      text: "with edit: the new, complete text of the message; with template_save: the text of the template with placeholders in curly braces",
      template: "with template_send, template_save, template_delete and template_move: name of the template or part of it",
      values: "with template_send: values for the placeholders of the template",
      "values.name": "Name of the placeholder without braces, for example file",
      "values.value": "Value",
      name: "with template_save: name of the template",
      description: "with template_save: what the template is for",
      direction: "with template_move: up or down",
    },
  },
  extensions: {
    description:
      "Extensions of Claude Code, global (scope user) or for a project. kind mcp: list MCP servers, add one with add (target is a command or URL), remove one with remove. kind skill or agent: list skills and subagents, read one out with read, create one with add and description, delete one with remove. kind command: list own slash commands. kind hook: read hooks out (change them only in FORGE). kind plugin: list installed plugins or search the catalog with query, install with add, uninstall with remove, switch with enable and disable.",
    params: {
      project: "Project name, if it is about a project",
      name: "Name of the server, skill, subagent or plugin",
      scope: "user: global; project: in the project, gets committed; local: only for the owner in the project",
      description: "skill and agent with add: what it is for, fully written out",
      transport: "mcp with add: if not given http for URLs, otherwise stdio",
      target: "mcp with add: command or URL of the server",
      args: "mcp with add: arguments of the command, separated by spaces",
      query: "plugin with list: search words for the catalog",
    },
  },
  forge_settings: {
    description:
      "Global settings of FORGE. Only give what should change; without anything it tells the current settings. policy_rule with policy_rule_on switches a rule of the blocklist that forbids Claude dangerous commands; switch one off only if the caller explicitly wants it.",
    params: {
      default_model: "Default model of new sessions: opus, sonnet, haiku or a model ID; default uses the one from Claude Code",
      default_effort: "Default thinking effort; default uses the one from Claude Code",
      default_profile: "Profile of new projects",
      default_project_dir: "Folder new projects are created in",
      sounds: "Sounds",
      desktop_notifications: "Windows notifications",
      enter_to_send: "Enter sends the message",
      auto_continue: "Continue automatically after a usage limit",
      idle_close_minutes:
        "After how many minutes without activity FORGE closes the Claude process of a session (the session stays); 0 switches this off. Choices in the settings: 15, 30, 60, 120, 240",
      long_session_tokens:
        "From how many tokens of context FORGE suggests continuing in a new session; 0 switches the hint off. Choices in the settings: 100000, 200000, 400000, 800000",
      update_checks: "Look for FORGE updates",
      update_channel: "Where FORGE gets its updates: stable are the releases of main, dev the pre-releases from the branch dev. dev only works when the GitHub account in FORGE can push to the FORGE repository",
      debug_logs: "Detailed logs",
      strip_api_key: "Do not pass an API key from the environment to Claude Code, so the subscription counts",
      screenshot_key: "The Print key opens FORGE's snipping tool instead of the Windows one",
      ui_compare: "Before and after images of the web app when Claude changes UI files and a dev server is running",
      learn_templates: "FORGE turns tasks the caller sends again and again into prompt templates on its own",
      ask_push_on_close: "when FORGE closes, ask whether everything not pushed yet should be committed and pushed",
      usage_stats:
        "Anonymous usage statistics: every 5 minutes totals like tokens, projects and agents, without content, to FORGE's statistics service; off deletes the data sent there",
      language: "Language of FORGE for the interface, messages and the phone: en English, de German. Afterwards you speak the new language",
      policy_rule: "Rule of the blocklist",
      policy_rule_on: "true switches the rule on, false off",
    },
  },
  forge_system: {
    description:
      "FORGE itself. diagnostics: whether Claude Code, sign-in, Git, GitHub CLI and Python are fine. update_check: look for a new FORGE version. update_download: download it. update_install: install it; FORGE restarts and the call ends, open sessions continue on their own afterwards. Only if the caller explicitly wants it, and say first that the call ends. changelog: what the new version brings. install_check: whether FORGE is fully installed (bundled programs like Git and GitHub CLI in the version this FORGE version needs) and which installer fixes it. install_repair: reinstall FORGE with the full installer; FORGE restarts and the call ends, open sessions continue afterwards. Runs only after a keypad code. dev_status: whether FORGE gets its updates from main or dev and what dev has that main does not have yet (members of the FORGE repository only). dev_promote: bring dev into main on GitHub and start the release of main; everyone on the stable channel gets it as an update. Only works while update_channel is dev. Only if the caller explicitly wants it, runs only after a keypad code. claude_check: whether there is an update of Claude Code. claude_update: update Claude Code (or install it if it is missing). claude_logout: sign Claude Code out on this computer; signing in again only works at the computer, only if the caller explicitly wants it. backup_list: the latest backups. backup_create: create a backup. backup_restore: restore a backup; FORGE saves the current state first. Only if the caller explicitly wants it. sync_status: whether FORGE's data is synced with other computers through a private, encrypted GitHub repository, when last, which projects of other computers are still missing here and what is only left on this computer. sync_now: sync right away. sync_on and sync_off: switch syncing on or off. sync_clone: bring a project from another computer here (project). sync_keep: sync something again that is only left here (project: name from sync_status). sync_force: set this computer hard to the state on GitHub, with project only that entry; removes here what is missing on GitHub, only if the caller explicitly wants it. sync_versions: earlier states on GitHub. sync_restore: bring back an earlier state (backup: number from sync_versions, parts as with backup_restore). support: how to donate to FORGE and where to submit improvements or feature ideas.",
    params: {
      backup: "with backup_restore: number from backup_list, with sync_restore from sync_versions (1 = newest)",
      project: "with sync_clone, sync_keep and sync_force: name from sync_status",
      parts: "with backup_restore and sync_restore: which parts, separated by commas: settings, projects, claude, git; if not given all except the phone settings",
    },
  },
  ask: {
    description:
      "Answers a question about what is in the sessions from their history, for example “What is the idea behind the ultrathink test?”, “What is the export stuck on?”, “How would you rate the project?” or “What did we do on the login yesterday?”. Claude reads the matching histories, which takes a few seconds. Without session FORGE finds the sessions that fit the question itself. For questions about content, reasons and background that go beyond the latest status; details gives the status itself faster.",
    params: {
      question: "the caller's question, written out in full, with the topic or name it is about",
      session: "only this session: short name like S1 or part of the title; leave out when it is unclear which one is meant",
      project: "only the sessions of this project",
    },
  },
  search: {
    description:
      "Full text search in the history of the sessions (messages, answers, commands and file paths), for example “In which session did we build the Stripe webhook?”. All search words must appear, in any order. Without session and project it searches all sessions: matching sessions with the passage. With session: the passages in that session, newest first. With project: only the sessions of that project.",
    params: {
      query: "Search words",
      session: "Search only in this session: short name like S1 or part of the title",
      project: "Search only in the sessions of this project",
      phrase: "true: exactly this phrase",
    },
  },
  usage: {
    description:
      "Usage of the Claude subscription: how much of the limits is used, when they reset, whether the limit lasts until the reset at the current pace (forecast, for example for “Will my limit last?”) and how many tokens per second Claude is putting out right now.",
  },
  call_settings: {
    description:
      "When and whom FORGE calls on its own: when a session is done (done), when it needs a decision or Claude reports something urgent (approval), on errors (error). All three false: no more calls. FORGE calls all switched-on numbers at once, whoever answers first gets the call. With number_action switch a number of the list list on or off (on, off), add one (add, with label as its name) or delete one (remove); list notify are the numbers FORGE calls, allowed the ones that may call FORGE. number is the number or its name like Mobile. Only give what should change; without anything it tells the current settings.",
    params: {
      list: "notify: numbers FORGE calls (default); allowed: numbers that may call FORGE",
      number: "Phone number or the name of an entry, for example Mobile",
      label: "only with add: name of the new number, for example Office",
    },
  },
  call_back: {
    description: "Agrees a callback: FORGE calls the caller after the given time and then tells them what they wanted to know (checked fresh, not the state of now).",
    params: {
      minutes: "In how many minutes, for example 5 (at most 1440)",
      about: "What the caller wants to know at the callback, fully written out, for example “whether the tests of the cart session are green”",
    },
  },
  hang_up: {
    description: "Ends the call after your last answer has been spoken.",
  },
};
