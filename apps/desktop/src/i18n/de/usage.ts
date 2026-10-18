/** German texts (usage). Source of the keys: the English file is typed against this one. */
export const usage = {
  resetPast: (relative: string, date: string) => `Wurde ${relative} zurückgesetzt (${date})`,
  resetFuture: (relative: string, date: string) => `Wird ${relative} zurückgesetzt (${date})`,
  fetched: (relative: string) => `Stand ${relative}`,
  skeletonLabel: "Lädt Nutzung",
  forecastWarning: {
    title: "Bei diesem Tempo ist das Limit vor dem Reset erreicht.",
    window: (label: string, text: string, reset: string | null) => `${label}: ${text}${reset ? `, Reset ${reset}` : ""}`,
    detail: (windows: string) => `${windows}. Ein weiterer Agent verbraucht es schneller.`,
  },
  refresh: "Nutzung aktualisieren",
  viewForecast: "Prognose ansehen",
  unavailable: "Claude Code meldet keine Nutzungsdaten. Sie gibt es nur mit einem Claude-Abo (Pro oder Max).",
};
