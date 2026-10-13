import { create } from "zustand";

interface TokenRateState {
  /** output tokens per second of all Claude processes, from the tokens.rate events */
  perSecond: number;
  set: (perSecond: number) => void;
}

export const useTokenRate = create<TokenRateState>((set) => ({
  perSecond: 0,
  set: (perSecond) => set({ perSecond }),
}));
