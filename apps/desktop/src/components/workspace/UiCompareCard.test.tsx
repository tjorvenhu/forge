import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { UiCompare } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { RpcCallError } from "@/lib/rpc";
import { keys } from "@/lib/queries";
import { buildChatItems, type ChatItem } from "./chat-items";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { UiCompareCard, pagePath } = await import("./UiCompareCard");

const shot = (side: string) => ({ width: 1280, height: 800, path: `C:\\forge\\ui-compare\\c1\\${side}.jpg`, takenAt: "2026-10-16T10:00:00.000Z" });
const compare = (over: Partial<UiCompare> = {}): UiCompare => ({
  id: "c1",
  sessionId: "s1",
  projectId: "p1",
  url: "http://localhost:5173/cart?step=2",
  files: ["src/Cart.tsx", "src/cart.css"],
  createdAt: "2026-10-16T10:00:00.000Z",
  status: "ready",
  before: shot("before"),
  after: shot("after"),
  error: null,
  ...over,
});

const item = buildChatItems(
  [{ seq: 7, sessionId: "s1", ts: "2026-10-16T10:00:00.000Z", body: { type: "ui.compare", compareId: "c1", url: "http://localhost:5173/cart?step=2", files: ["src/Cart.tsx", "src/cart.css"] } }],
  {},
)[0] as Extract<ChatItem, { kind: "uiCompare" }>;

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <UiCompareCard item={item} sessionId="s1" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return qc;
}

const respond = (meta: () => UiCompare | Error) =>
  callMock.mockImplementation(async (method: string, p: { side?: string }) => {
    if (method === "uiCompare.get") {
      const m = meta();
      if (m instanceof Error) throw m;
      return m;
    }
    if (method === "uiCompare.image") return { mediaType: "image/jpeg", base64: p.side === "before" ? "QkVGT1JF" : "QUZURVI=" };
    if (method === "uiCompare.retake") return compare({ status: "capturing", after: null });
    throw new Error(`unexpected ${method}`);
  });

beforeEach(() => {
  callMock.mockReset();
});
afterEach(cleanup);

describe("UiCompareCard", () => {
  it("is built from the ui.compare event", () => {
    expect(item).toMatchObject({ kind: "uiCompare", key: "vc1", body: { compareId: "c1" } });
    expect(pagePath("http://localhost:5173/cart?step=2")).toBe("/cart?step=2");
    expect(pagePath("http://localhost:5173")).toBe("/");
  });

  it("shows placeholders first, then both images side by side; a click enlarges", async () => {
    respond(() => compare());
    setup();
    expect(screen.getByText("/cart?step=2")).toBeTruthy();
    expect(screen.getByText("2 UI-Dateien geändert")).toBeTruthy();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    const before = await screen.findByAltText("Vorher: Screenshot der Web-App");
    expect(before.getAttribute("src")).toBe("data:image/jpeg;base64,QkVGT1JF");
    expect((await screen.findByAltText("Nachher: Screenshot der Web-App")).getAttribute("src")).toBe("data:image/jpeg;base64,QUZURVI=");

    fireEvent.click(screen.getByRole("radio", { name: "Nachher" }));
    expect(screen.queryByAltText("Vorher: Screenshot der Web-App")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Schieber/ }));
    expect(screen.getByLabelText("Grenze zwischen Vorher und Nachher")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Nebeneinander/ }));
    fireEvent.click(screen.getAllByTitle("Vergrößern")[1]!);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("keeps a placeholder of the after image while it is taken, and shows it once the sidecar says so", async () => {
    respond(() => compare({ status: "capturing", after: null }));
    const qc = setup();
    await screen.findByAltText("Vorher: Screenshot der Web-App");
    expect(screen.getByRole("status", { name: "Lädt Nachher-Bild" })).toBeTruthy();
    act(() => qc.setQueryData(keys.uiCompare("s1", "c1"), compare()));
    await screen.findByAltText("Nachher: Screenshot der Web-App");
  });

  it("offers to take a failed after image again", async () => {
    respond(() => compare({ status: "failed", after: null, error: "Der Dev-Server läuft nicht mehr." }));
    setup();
    expect(await screen.findByText("Nachher-Bild fehlgeschlagen: Der Dev-Server läuft nicht mehr.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Neu aufnehmen/ }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("uiCompare.retake", { sessionId: "s1", compareId: "c1" }));
    expect(await screen.findByRole("status", { name: "Lädt Nachher-Bild" })).toBeTruthy();
  });

  it("says when the images were cleaned up", async () => {
    respond(() => new RpcCallError("NOT_FOUND", "Vergleich nicht mehr vorhanden."));
    setup();
    expect(await screen.findByText(/Bilder nicht mehr vorhanden/)).toBeTruthy();
  });
});
