/** Where people can support FORGE (voluntary payment to Vanturis); shown behind the heart and read out on the phone. */
export const SUPPORT_LINKS = {
  donate: "https://paypal.me/tjorvenhu",
  feedback: "https://github.com/vanturis/forge/issues/new",
} as const;

/** FORGE is published by Vanturis UG (haftungsbeschränkt) under AGPL-3.0-only (see NOTICE). */
export const PUBLISHER = {
  name: "Vanturis UG (haftungsbeschränkt)",
  site: "https://vanturis.de",
  imprint: "https://vanturis.de/impressum",
  privacy: "https://vanturis.de/datenschutz",
  source: "https://github.com/vanturis/forge",
  license: "AGPL-3.0",
} as const;

/** Statistics service (services/stats): takes the anonymous usage totals, shows the sums of all installations. */
export const USAGE_STATS_URL = "https://forge-stats.vanturis.de";
