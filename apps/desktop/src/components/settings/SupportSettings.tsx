import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { Copy, ExternalLink, Gauge, Heart, Lightbulb } from "lucide-react";
import { SUPPORT_LINKS, STATS_PAGE_URL } from "@forge/protocol";
import { addContextItems, copyText } from "@/lib/context-menu";
import { openExternal } from "@/lib/native";
import { call } from "@/lib/queries";
import { Skeleton } from "@/components/ui/skeleton";
import { useUi } from "@/stores/ui";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/misc";
import { locale, t } from "@/i18n";

const ts = t.settings.support;

const LINKS: ReadonlyArray<{ Icon: LucideIcon; label: string; description: string; href: string; action: string }> = [
  {
    Icon: Heart,
    ...ts.donate,
    href: SUPPORT_LINKS.donate,
  },
  {
    Icon: Lightbulb,
    ...ts.feedback,
    href: SUPPORT_LINKS.feedback,
  },
  { Icon: Gauge, ...ts.stats, href: STATS_PAGE_URL },
];

/** Small red heart in the sidebar, right of the search field: opens the support dialog. */
export function SupportButton() {
  const open = useUi((u) => u.setSupportOpen);
  return (
    <Tooltip content={ts.title}>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => open(true)}
        onContextMenu={(e) =>
          addContextItems(e, [
            { label: ts.payDonation, icon: <Heart className="h-3.5 w-3.5" />, onSelect: () => void openExternal(SUPPORT_LINKS.donate) },
            { label: ts.suggest, icon: <Lightbulb className="h-3.5 w-3.5" />, onSelect: () => void openExternal(SUPPORT_LINKS.feedback) },
            { label: ts.copyDonateLink, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(SUPPORT_LINKS.donate) },
          ])
        }
        aria-label={ts.title}
        // Same box as the search field next to it.
        className="h-9 w-9 rounded-lg border border-border bg-surface text-danger transition-colors hover:border-border-strong hover:bg-surface hover:text-danger"
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
      title={ts.title}
      description={ts.description}
      className="w-150"
      bodyClassName="flex flex-col"
    >
      <Donated enabled={open} />
      <div className="divide-y divide-border">
        {LINKS.map((l) => (
          <LinkRow key={l.href} {...l} />
        ))}
      </div>
      <p className="pt-3 text-xs text-muted">
        {ts.diagnosticsBefore}{" "}
        <button
          className="underline hover:text-fg"
          onClick={() => {
            setOpen(false);
            openSettings("about");
          }}
        >
          {ts.about}
        </button>
        {ts.diagnosticsAfter}
      </p>
    </Dialog>
  );
}

const euro = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const euroCents = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });

/** "Bisher gespendet" from the statistics service; asked when the dialog opens, left out when it does not know. */
function Donated({ enabled }: { enabled: boolean }) {
  // Only a known sum is kept; without one the next opening asks again (the sidecar holds back for a minute).
  const q = useQuery({ queryKey: ["donations"], queryFn: () => call("app.donations", {}), enabled, staleTime: (s) => (s.state.data ? 10 * 60_000 : 0), retry: false });
  if (q.isPending && !enabled) return null;
  if (!q.isPending && !q.data) return null;
  const d = q.data;
  return (
    <div className="mb-1 flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-2 px-3 py-2.5" aria-busy={!d}>
      <div className="min-w-0">
        <div className="text-small text-muted">{ts.donated}</div>
        <div className="text-xs text-subtle">{d ? ts.donations(d.count) : <Skeleton className="mt-1 h-3 w-32" />}</div>
      </div>
      {d ? (
        <div className="shrink-0 text-lg font-semibold tabular-nums text-accent">{(d.cents % 100 === 0 ? euro : euroCents).format(d.cents / 100)}</div>
      ) : (
        <Skeleton className="h-6 w-20" />
      )}
    </div>
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
