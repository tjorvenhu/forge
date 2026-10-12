import { useState } from "react";
import { cn } from "@/lib/utils";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : parts;
  return letters.map((p) => [...p][0]!.toUpperCase()).join("") || "?";
}

/** GitHub picture of a commit author, otherwise the initials in the style of the "Du" badge in the chat. */
export function AuthorAvatar({ name, url, className }: { name: string; url: string | null | undefined; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (url && url !== failedUrl) {
    return <img src={url} alt="" loading="lazy" draggable={false} className={cn("shrink-0 rounded-full border border-border", className)} onError={() => setFailedUrl(url)} />;
  }
  return (
    <span
      aria-hidden
      className={cn("flex shrink-0 select-none items-center justify-center rounded-full border border-accent/25 bg-accent-soft text-3xs font-semibold leading-none text-accent", className)}
    >
      {initials(name)}
    </span>
  );
}
