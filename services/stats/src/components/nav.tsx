"use client";

import { usePathname } from "next/navigation";
import { ArrowUpRight, BarChart3, GitFork } from "lucide-react";
import { REPO_URL } from "@/lib/constants";
import { useI18n } from "./locale";

/** Links of the top bar: live stats (marked while open) and the repository. */
export function TopLinks() {
  const { t } = useI18n();
  const path = usePathname();
  const h = t.header;
  return (
    <ul className="nav-links">
      <li>
        <a href="/stats" aria-current={path === "/stats" ? "page" : undefined} aria-label={h.liveStats}>
          <BarChart3 aria-hidden />
          <span className="nav-label">{h.liveStats}</span>
          <ArrowUpRight aria-hidden className="nav-arrow" />
        </a>
      </li>
      <li>
        <a href={REPO_URL} aria-label={h.github}>
          <GitFork aria-hidden />
          <span className="nav-label">{h.github}</span>
        </a>
      </li>
    </ul>
  );
}
