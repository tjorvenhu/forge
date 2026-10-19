"use client";

import { usePathname } from "next/navigation";
import { DOCS_URL, REPO_URL } from "@/lib/constants";
import { useI18n } from "./locale";

/** Page links of top bar and footer; the current page is marked. */
export function PageLinks({ className }: { className: string }) {
  const { locale, t } = useI18n();
  const path = usePathname();
  const h = t.header;
  const links = [
    { href: "/#features", label: h.features },
    { href: "/stats", label: h.stats, current: path === "/stats" },
    { href: DOCS_URL[locale], label: h.docs },
    { href: REPO_URL, label: "GitHub" },
  ];
  return (
    <ul className={className}>
      {links.map((l) => (
        <li key={l.href}>
          <a href={l.href} aria-current={l.current ? "page" : undefined}>
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
