import type { LucideIcon } from "lucide-react";
import { Copy, ExternalLink, Gauge, Heart, Lightbulb } from "lucide-react";
import { SUPPORT_LINKS, USAGE_STATS_URL } from "@forge/protocol";
import { addContextItems, copyText } from "@/lib/context-menu";
import { openExternal } from "@/lib/native";
import { useUi } from "@/stores/ui";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/misc";

const LINKS: ReadonlyArray<{ Icon: LucideIcon; label: string; description: string; href: string; action: string }> = [
  { Icon: Heart, label: "Über PayPal spenden", description: "Den Betrag wählst du selbst auf der PayPal-Seite.", href: SUPPORT_LINKS.donate, action: "PayPal öffnen" },
  {
    Icon: Lightbulb,
    label: "Vorschlag oder Fehler einreichen",
    description: "Als Issue auf GitHub. Dafür brauchst du ein GitHub-Konto.",
    href: SUPPORT_LINKS.feedback,
    action: "GitHub öffnen",
  },
  { Icon: Gauge, label: "FORGE in Zahlen", description: "Gesamtzahlen aller Installationen mit eingeschalteter Nutzungsstatistik.", href: USAGE_STATS_URL, action: "Statistik öffnen" },
];

/** Small red heart in the header, next to the sync symbol: opens the support dialog. */
export function SupportButton() {
  const open = useUi((u) => u.setSupportOpen);
  return (
    <Tooltip content="FORGE unterstützen">
      <Button
        size="icon"
        variant="ghost"
        onClick={() => open(true)}
        onContextMenu={(e) =>
          addContextItems(e, [
            { label: "Spenden über PayPal", icon: <Heart className="h-3.5 w-3.5" />, onSelect: () => void openExternal(SUPPORT_LINKS.donate) },
            { label: "Vorschlag einreichen", icon: <Lightbulb className="h-3.5 w-3.5" />, onSelect: () => void openExternal(SUPPORT_LINKS.feedback) },
            { label: "Spendenlink kopieren", icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(SUPPORT_LINKS.donate) },
          ])
        }
        aria-label="FORGE unterstützen"
        className="h-9 w-9 rounded-lg text-danger hover:text-danger"
      >
        <Heart className="h-4 w-4 fill-current" />
      </Button>
    </Tooltip>
  );
}

export function SupportDialog() {
  const open = useUi((u) => u.supportOpen);
  const setOpen = useUi((u) => u.setSupportOpen);
  const openSettings = useUi((u) => u.openSettings);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="FORGE unterstützen"
      description="Wenn dir FORGE hilft, kannst du die Weiterentwicklung mit einer Spende unterstützen oder Verbesserungen vorschlagen."
      className="w-150"
      bodyClassName="flex flex-col"
    >
      <div className="divide-y divide-border">
        {LINKS.map((l) => (
          <LinkRow key={l.href} {...l} />
        ))}
      </div>
      <p className="pt-3 text-xs text-muted">
        Bei einem Fehler helfen die FORGE-Version und die Angaben aus der Diagnose unter{" "}
        <button
          className="underline hover:text-fg"
          onClick={() => {
            setOpen(false);
            openSettings("about");
          }}
        >
          Über FORGE
        </button>
        .
      </p>
    </Dialog>
  );
}

/** A real link, so the right click offers opening and copying it. */
function LinkRow({ Icon, label, description, href, action }: { Icon: LucideIcon; label: string; description: string; href: string; action: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 py-3">
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
