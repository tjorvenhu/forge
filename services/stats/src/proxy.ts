import { NextResponse, type NextRequest } from "next/server";
import { LOCALE_HEADER } from "@/lib/i18n";

/**
 * Pages with the language in the path (/de, /en/stats) for search engines: they render the page without
 * the prefix in that language. Without a prefix the cookie or Accept-Language decides, as before.
 */
export function proxy(req: NextRequest) {
  const match = /^\/(de|en)(\/stats)?\/?$/.exec(req.nextUrl.pathname);
  const headers = new Headers(req.headers);
  // A header sent by the visitor must not pick the language of an unprefixed page.
  headers.delete(LOCALE_HEADER);
  if (!match) return NextResponse.next({ request: { headers } });
  headers.set(LOCALE_HEADER, match[1]!);
  const url = req.nextUrl.clone();
  url.pathname = match[2] ?? "/";
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  matcher: ["/", "/stats", "/de", "/de/", "/de/stats", "/en", "/en/", "/en/stats"],
};
