import { byPlatform } from "@/lib/platform";

/** Names that differ by operating system, for both languages. Windows keeps the texts it always had. */
export const osName = byPlatform({ windows: "Windows", macos: "macOS", linux: "Linux" });
export const fileManagerDe = byPlatform({ windows: "Explorer", macos: "Finder", linux: "Dateimanager" });
export const fileManagerEn = byPlatform({ windows: "Explorer", macos: "Finder", linux: "the file manager" });
