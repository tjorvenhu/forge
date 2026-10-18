import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

// Building blocks after the FORGE app: the tiles of the daily report (ReportView), the settings cards
// (settings/layout.tsx Group and Row), SectionTitle and Skeleton from components/ui.

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{children}</h2>
      {action}
    </div>
  );
}

export function Tile({
  icon: Icon,
  label,
  value,
  unit,
  sub,
  highlight,
  wide,
  live,
  index = 0,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  unit?: string;
  sub: string;
  highlight?: boolean;
  wide?: boolean;
  /** live dot in front of the value; true pulses, false stays gray */
  live?: boolean;
  /** position, for the staggered entrance */
  index?: number;
}) {
  return (
    <div className={`tile tile-enter${wide ? " tile-wide" : ""}${highlight ? " tile-highlight" : ""}`} style={{ "--i": index } as CSSProperties}>
      <div className="tile-head">
        <span className="tile-label">{label}</span>
        <Icon className="tile-icon" aria-hidden />
      </div>
      <div className={highlight ? "tile-value tile-value-accent" : "tile-value"}>
        {live !== undefined && <LiveDot on={live} />}
        {value}
        {unit && <span className="tile-unit">{unit}</span>}
      </div>
      <div className="tile-sub">{sub}</div>
    </div>
  );
}

export function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="group">
      <header className="group-head">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      <div className="group-rows">{children}</div>
    </section>
  );
}

export function Row({ icon: Icon, label, description, children }: { icon?: LucideIcon; label: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="row">
      {Icon && <Icon className="row-icon" aria-hidden />}
      <div className="row-text">
        <span className="row-label">{label}</span>
        {description && <span className="row-description">{description}</span>}
      </div>
      {children !== undefined && <div className="row-value">{children}</div>}
    </div>
  );
}

/** Green dot with a ping ring while `on`; gray and still otherwise. */
export function LiveDot({ on }: { on: boolean }) {
  return <span className={on ? "live-dot live-dot-on" : "live-dot"} aria-hidden />;
}

/** A placeholder bar inside an element of the real text style, so the loaded text takes exactly its place. */
export function Skeleton({ width, style }: { width: string; style?: CSSProperties }) {
  return <span className="skeleton" style={{ width, ...style }} aria-hidden />;
}
