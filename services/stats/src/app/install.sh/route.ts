import { INSTALL_SCRIPT_URL } from "@/lib/constants";

/**
 * `curl -fsSL https://forge.vanturis.de/install.sh | sh` (curl -L follows): the script lives in the
 * repository, so a change there needs no new deploy of this site.
 */
export function GET() {
  return Response.redirect(INSTALL_SCRIPT_URL, 302);
}
