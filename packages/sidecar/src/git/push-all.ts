import type { Project, PushAllResult, UnpushedProject } from "@forge/protocol";
import { isArtifactPath, isSensitiveFile, type GitEngine } from "./git.js";
import { tr } from "../i18n/index.js";

export interface PushAllDeps {
  git: GitEngine;
  projects: () => Project[];
  suggestCommitMessage: (projectId: string, paths: string[]) => Promise<{ message: string }>;
  notifyProject: (projectId: string) => void;
}

/** Files a commit of the open work takes: secrets, build output and conflicts stay out, as with auto-commit. */
function committable(files: Array<{ path: string; kind: string }>): string[] {
  return files.filter((f) => f.kind !== "conflicted" && !isSensitiveFile(f.path) && !isArtifactPath(f.path)).map((f) => f.path);
}

/**
 * Brings the open work of all projects to their remote: what is still uncommitted is committed, then
 * the branch is pushed. Used when FORGE closes, so the work can go on from another computer.
 */
export class PushAll {
  constructor(private d: PushAllDeps) {}

  /** Agents' worktrees are left out: their branches come into the project by merging, not on GitHub. */
  private candidates(ids?: Set<string>): Project[] {
    return this.d.projects().filter((p) => p.exists && p.gitEnabled && !p.parentId && (!ids || ids.has(p.id)));
  }

  async unpushed(): Promise<UnpushedProject[]> {
    const found = await Promise.all(
      this.candidates().map(async (p): Promise<UnpushedProject | null> => {
        try {
          const st = await this.d.git.status(p.path);
          const s = st.summary;
          if (!s.remoteUrl || !s.branch || s.detached) return null;
          const changed = committable(st.files).length;
          const ahead = await this.d.git.unpushedCount(p.path, s);
          return changed || ahead ? { projectId: p.id, name: p.name, branch: s.branch, changed, ahead } : null;
        } catch {
          return null;
        }
      }),
    );
    return found.filter((x): x is UnpushedProject => x !== null);
  }

  async pushAll(projectIds: string[], allowProtected: boolean): Promise<PushAllResult[]> {
    const projects = this.candidates(new Set(projectIds));
    // Projects in one repository share its index: they run one after the other, repositories side by side.
    const byRoot = new Map<string, Project[]>();
    for (const p of projects) {
      const root = await this.d.git.repoRoot(p.path).catch(() => p.path);
      byRoot.set(root, [...(byRoot.get(root) ?? []), p]);
    }
    const results = new Map<string, PushAllResult>();
    await Promise.all(
      [...byRoot.values()].map(async (group) => {
        for (const p of group) results.set(p.id, await this.pushOne(p, allowProtected));
      }),
    );
    return projects.map((p) => results.get(p.id)!);
  }

  private async pushOne(p: Project, allowProtected: boolean): Promise<PushAllResult> {
    let committed: string | null = null;
    try {
      const paths = committable((await this.d.git.status(p.path)).files);
      if (paths.length) {
        const message = await this.d.suggestCommitMessage(p.id, paths).then(
          (r) => r.message,
          () => tr().system.git.pushAllMessage,
        );
        committed = (await this.d.git.commit(p.path, message, paths, false)).summary;
        this.d.notifyProject(p.id);
      }
      await this.d.git.push(p.path, allowProtected);
      this.d.notifyProject(p.id);
      return { projectId: p.id, name: p.name, committed, pushed: true, error: null };
    } catch (e) {
      return { projectId: p.id, name: p.name, committed, pushed: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
