import { DEFAULT_SETTINGS } from "../src/persistence/db.js";
import { setLanguage } from "../src/i18n/index.js";

// The tests were written against the German texts; English has its own tests that switch on purpose.
DEFAULT_SETTINGS.language = "de";
setLanguage("de");
