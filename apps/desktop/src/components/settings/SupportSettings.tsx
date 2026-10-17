import type { LucideIcon } from "lucide-react";
import { ExternalLink, HandHeart, Lightbulb } from "lucide-react";
import { SUPPORT_LINKS } from "@forge/protocol";
import { openExternal } from "@/lib/native";
import { useUi } from "@/stores/ui";
import { buttonVariants } from "@/components/ui/button";
import { Group } from "@/components/settings/layout";

export function SupportSettings() {
  const openSettings = useUi((u) => u.openSettings);
  return (
    <>
      <Group title="Spenden" description="Wenn dir FORGE hilft, kannst du die Weiterentwicklung mit einer Spende unterstützen.">
        <LinkRow Icon={HandHeart} label="Über PayPal spenden" description="Den Betrag wählst du selbst auf der PayPal-Seite." href={SUPPORT_LINKS.donate} action="PayPal öffnen" />
      </Group>
      <Group title="Verbesserungen und Featurevorschläge" description="Vorschläge und Fehlermeldungen sammle ich auf GitHub. Dafür brauchst du ein GitHub-Konto.">
        <LinkRow Icon={Lightbulb} label="Vorschlag oder Fehler einreichen" description="Öffnet ein neues Issue im FORGE-Repository." href={SUPPORT_LINKS.feedback} action="GitHub öffnen" />
        <p className="px-4 py-3 text-xs text-muted">
          Bei einem Fehler helfen die FORGE-Version und die Angaben aus der Diagnose unter{" "}
          <button className="underline hover:text-fg" onClick={() => openSettings("about")}>
            Über FORGE
          </button>
          .
        </p>
      </Group>
    </>
  );
}

/** A real link, so the right click offers opening and copying it. */
function LinkRow({ Icon, label, description, href, action }: { Icon: LucideIcon; label: string; description: string; href: string; action: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 px-4 py-3.5">
      <div className="flex min-w-0 flex-[1_1_14rem] items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="text-body font-medium">{label}</div>
          <div className="text-xs text-muted">{description}</div>
          <div className="truncate font-mono text-xs text-subtle">{href.replace(/^https:\/\//, "")}</div>
        </div>
      </div>
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          void openExternal(href);
        }}
        className={buttonVariants({ variant: "secondary", size: "md" })}
      >
        <ExternalLink className="h-3.5 w-3.5" /> {action}
      </a>
    </div>
  );
}
