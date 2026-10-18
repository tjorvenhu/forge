import type { layout as De } from "../de/layout";

export const layout: typeof De = {
  paletteLanguage: (name) => `Language: ${name}`,
  paletteLanguageOption: "Interface language",
  paletteLanguageNow: (name) => `now ${name}`,
};
