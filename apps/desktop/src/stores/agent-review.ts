import { create } from "zustand";

interface AgentReviewState {
  /** worktree projects of agents waiting for "merge or discard", oldest first; the dialog shows the first */
  queue: string[];
  request: (projectId: string) => void;
  /** decided or put off; a later finished turn asks again */
  done: (projectId: string) => void;
}

export const useAgentReview = create<AgentReviewState>((set) => ({
  queue: [],
  request: (projectId) => set((s) => (s.queue.includes(projectId) ? s : { queue: [...s.queue, projectId] })),
  done: (projectId) => set((s) => ({ queue: s.queue.filter((id) => id !== projectId) })),
}));
