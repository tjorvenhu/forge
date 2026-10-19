/** Where people can support FORGE (voluntary payment to Vanturis); shown behind the heart and read out on the phone. */
export const SUPPORT_LINKS = {
  donate: "https://buy.stripe.com/9B64gBc4e5j80vg1WxbV600",
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

/** Statistics service and website (services/stats): takes the anonymous usage totals and shows the sums of all installations. */
export const USAGE_STATS_URL = "https://forge.vanturis.de";
/** Public page with those sums; the root of USAGE_STATS_URL is the FORGE start page. */
export const STATS_PAGE_URL = `${USAGE_STATS_URL}/stats`;
