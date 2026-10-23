import type { Metadata } from "next";
import { CrewApp } from "@/components/crew-web/app";
import { crewMessages } from "@/lib/crew-web/messages";
import { getLocale } from "@/lib/locale-server";
import "./crew.css";

export async function generateMetadata(): Promise<Metadata> {
  const m = crewMessages(await getLocale());
  // A tool for crew members, not a page for search results.
  return { title: m.metaTitle, description: m.metaDescription, robots: { index: false, follow: false } };
}

/** The crew in the browser: invite links from FORGE (…/crew#forge-crew1.…) open here. */
export default function CrewPage() {
  return (
    <main className="container crew-page">
      <CrewApp />
    </main>
  );
}
