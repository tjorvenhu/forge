import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TriangleAlert } from "lucide-react";
import { isTauri } from "@/lib/rpc";
import { t } from "@/i18n";
import { SwitchRow } from "@/components/settings/layout";
import { isLinux, isMac } from "@/lib/platform";

/** screenshot.rs `screenshot_key_status` */
interface KeyStatus {
  key: "print" | "cmd-shift-2";
  takenByOther: boolean;
  other: string | null;
}

/** The shell retries the registration every 2 s on Windows; another tool may also start later. */
const POLL_MS = 5_000;

/** Setting "Druck-Taste für Screenshots", with a warning when another program holds the key too. */
export function ScreenshotKeyRow({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const [status, setStatus] = useState<KeyStatus | null>(null);

  useEffect(() => {
    if (!checked || !isTauri()) {
      setStatus(null);
      return;
    }
    let live = true;
    const load = () =>
      void invoke<KeyStatus>("screenshot_key_status")
        .then((s) => live && setStatus(s))
        .catch(() => {});
    // The shell needs a moment after switching on before the registration is known.
    const first = window.setTimeout(load, 2_500);
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [checked]);

  const k = t.screenshot.key;
  const text = isMac ? k.descriptionMac : isLinux ? k.descriptionLinux : k.description;
  const warning = status?.takenByOther ? (isMac || isLinux ? k.notRegistered : k.takenWindows(status.other ?? k.otherProgram)) : null;

  return (
    <SwitchRow
      label={isMac ? k.labelMac : k.label}
      description={
        warning ? (
          <>
            {text}
            <span className="mt-1.5 flex items-start gap-1.5 text-warning">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{warning}</span>
            </span>
          </>
        ) : (
          text
        )
      }
      checked={checked}
      onChange={onChange}
    />
  );
}
