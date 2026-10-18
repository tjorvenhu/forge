import type { usage as De } from "../de/usage";

export const usage: typeof De = {
  resetPast: (relative, date) => `Was reset ${relative} (${date})`,
  resetFuture: (relative, date) => `Resets ${relative} (${date})`,
  fetched: (relative) => `Updated ${relative}`,
  skeletonLabel: "Loading usage",
  forecastWarning: {
    title: "At this pace the limit is reached before the reset.",
    window: (label, text, reset) => `${label}: ${text}${reset ? `, reset ${reset}` : ""}`,
    detail: (windows) => `${windows}. Another agent uses it up faster.`,
  },
  refresh: "Refresh usage",
  viewForecast: "View forecast",
  unavailable: "Claude Code reports no usage data. It is only available with a Claude subscription (Pro or Max).",
};
