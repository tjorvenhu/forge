import { setProtocolLanguage } from "@forge/protocol";

// The tests were written against the German texts; i18n reads the language from here when it loads.
localStorage.setItem("forge.language", "de");
setProtocolLanguage("de");
