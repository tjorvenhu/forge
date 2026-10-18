import { randomUUID } from "node:crypto";
import { ForgeError, normalizeForMatch, type PromptTemplate } from "@forge/protocol";
import { tr } from "../i18n/index.js";
import type { Db } from "../persistence/db.js";

export interface TemplateInput {
  id: string | null;
  projectId: string | null;
  name: string;
  description: string | null;
  text: string;
  /** made by TemplateLearner; only for new templates */
  learned?: boolean;
}

/** Deleted learned templates FORGE remembers, so it does not learn them again; the oldest are forgotten first. */
export const MAX_DISMISSED = 300;

/**
 * Prompt templates, global or per project, in the database. Every change is announced with
 * templates.updated, so all windows, the composer suggestions and the sync see it.
 */
export class TemplateService {
  constructor(
    private readonly d: {
      db: Db;
      /** the project templates are kept for: an agent's worktree has those of its project; throws when there is no such project */
      rootOf(projectId: string): string;
      emit(projectId: string | null): void;
      now?: () => string;
    },
  ) {}

  private now() {
    return this.d.now?.() ?? new Date().toISOString();
  }

  list(projectId?: string, all = false): PromptTemplate[] {
    if (all) return this.d.db.listTemplates("all");
    return this.d.db.listTemplates(projectId ? this.d.rootOf(projectId) : null);
  }

  get(id: string): PromptTemplate {
    const t = this.d.db.getTemplate(id);
    if (!t) throw new ForgeError("NOT_FOUND", tr().core.templates.notFound);
    return t;
  }

  save(given: TemplateInput): PromptTemplate {
    const input = { ...given, projectId: given.projectId ? this.d.rootOf(given.projectId) : null };
    const description = input.description?.trim() || null;
    const now = this.now();
    let t: PromptTemplate;
    if (input.id) {
      const before = this.get(input.id);
      // Moved to another list (global <-> project): it goes to the end there.
      const sortOrder = before.projectId === input.projectId ? before.sortOrder : this.d.db.nextTemplateOrder(input.projectId);
      // Edited by the user: no longer a learned one.
      const { learned: _learned, ...kept } = before;
      t = { ...kept, projectId: input.projectId, name: input.name.trim(), description, text: input.text, sortOrder, updatedAt: now };
      this.d.db.putTemplate(t);
      if (before.projectId !== input.projectId) this.d.emit(before.projectId);
    } else {
      t = {
        id: randomUUID(),
        projectId: input.projectId,
        name: input.name.trim(),
        description,
        text: input.text,
        sortOrder: this.d.db.nextTemplateOrder(input.projectId),
        createdAt: now,
        updatedAt: now,
        ...(input.learned ? { learned: true } : {}),
      };
      this.d.db.putTemplate(t);
    }
    this.d.emit(t.projectId);
    return t;
  }

  delete(id: string): boolean {
    const t = this.d.db.getTemplate(id);
    if (!t) return false;
    this.d.db.deleteTemplate(id);
    // A learned template the user threw away is not learned again.
    if (t.learned) {
      const state = this.d.db.getTemplateLearning();
      const key = normalizeForMatch(t.text);
      this.d.db.setTemplateLearning({ ...state, dismissed: [...state.dismissed.filter((x) => x !== key), key].slice(-MAX_DISMISSED) });
    }
    this.d.emit(t.projectId);
    return true;
  }

  /**
   * New order within one list: the given templates take the places they held so far, in the new order.
   * All of them must belong to the same list.
   */
  reorder(ids: string[]): PromptTemplate[] {
    const picked = [...new Set(ids)].map((id) => this.get(id));
    const projectId = picked[0]!.projectId;
    if (picked.some((t) => t.projectId !== projectId)) throw new ForgeError("VALIDATION", tr().core.templates.mixedOrder);
    const list = this.d.db.listTemplates(projectId).filter((t) => t.projectId === projectId);
    const wanted = new Set(picked.map((t) => t.id));
    const queue = [...picked];
    // Templates left out keep their place; the named ones fill the places of the named ones.
    const next = list.map((t) => (wanted.has(t.id) ? queue.shift()! : t));
    this.d.db.setTemplateOrder(next.map((t, i) => ({ id: t.id, sortOrder: i })));
    this.d.emit(projectId);
    return this.d.db.listTemplates(projectId).filter((t) => t.projectId === projectId);
  }
}
