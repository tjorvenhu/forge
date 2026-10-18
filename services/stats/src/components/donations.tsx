"use client";

import { Heart } from "lucide-react";
import { DONATE_URL } from "@/lib/constants";
import type { Donations } from "@/lib/donations";
import { formatCount, formatEur } from "@/lib/format";
import { Skeleton } from "./blocks";
import { AnimatedNumber } from "./motion";

/** What people gave over the "Unterstützen" link so far, with the link itself. Null data: still loading. */
export function DonationBanner({ data }: { data: Donations | null }) {
  return (
    <section className="donation tile-enter" aria-labelledby="donation-label" aria-busy={!data}>
      <span className="donation-icon" aria-hidden>
        <Heart />
      </span>
      <div className="donation-text">
        <span id="donation-label" className="tile-label">
          Bisher gespendet
        </span>
        <div className="tile-value tile-value-accent">{data ? <AnimatedNumber value={data.cents} format={formatEur} /> : <Skeleton width="7rem" />}</div>
        <div className="tile-sub">
          {data ? `${formatCount(data.count)} ${data.count === 1 ? "Spende" : "Spenden"} über „Unterstützen“, vor Gebühren` : <Skeleton width="14rem" />}
        </div>
      </div>
      <a className="btn btn-primary donation-action" href={DONATE_URL}>
        <Heart aria-hidden />
        Unterstützen
      </a>
    </section>
  );
}
