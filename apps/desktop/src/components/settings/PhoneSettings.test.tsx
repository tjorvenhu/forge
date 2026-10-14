import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { PhoneConfig } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<typeof RpcModuleNs>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { PhoneSettings } = await import("./PhoneSettings");
const { useToasts } = await import("@/stores/toast");

const config: PhoneConfig = {
  engine: "gemini-live",
  liveModel: "live",
  geminiVoice: "Kore",
  speechProvider: "openai",
  geminiSttModel: "stt",
  geminiTtsModel: "tts",
  hasGeminiKey: false,
  desk: { enabled: false, phoneIp: "", httpPort: 8765, webUser: "admin", hasWebPassword: false, sessionKeys: [1, 2, 3, 4], clearKeys: [], leds: true, hotline: true, display: "lines", provisioningUrl: null },
  server: "pbx.local",
  port: 5060,
  username: "30",
  authUsername: null,
  domain: null,
  displayName: "FORGE",
  voice: "alloy",
  sttModel: "s",
  ttsModel: "t",
  allowedCallers: [],
  notifyNumbers: [{ id: "n1", number: "0172 999", label: "Handy", enabled: true }],
  notifyOn: { done: true, approval: true, error: true },
  requirePin: true,
  enabled: false,
  hasPassword: false,
  hasOpenAiKey: false,
  hasPin: false,
} as PhoneConfig;

const saves = () => callMock.mock.calls.filter(([m]) => m === "phone.saveConfig").map(([, p]) => p as Record<string, unknown>);

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <PhoneSettings />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  useToasts.setState({ toasts: [] });
  callMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "phone.config") return config;
    if (method === "phone.state") return { enabled: false, registration: "off", message: null, call: null };
    if (method === "phone.calls") return [];
    if (method === "phone.saveConfig") return { ...config, ...params, hasPassword: config.hasPassword || !!params.password, desk: { ...config.desk, ...(params.desk as object) } };
    return {};
  });
});
afterEach(cleanup);

describe("phone on and off", () => {
  it("follows the phone state, which the header button and the phone switch too", async () => {
    const plain = callMock.getMockImplementation()!;
    callMock.mockImplementation(async (method: string, params: Record<string, unknown>) =>
      method === "phone.state" ? { enabled: true, registration: "registering", message: null, call: null } : plain(method, params),
    );
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Ausschalten" }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("phone.setEnabled", { enabled: false }));
  });
});

describe("phone settings save by themselves", () => {
  it("has no save button and saves a switch at once", async () => {
    setup();
    await screen.findByText("Anmeldung an der Telefonanlage (SIP)");
    expect(screen.queryByRole("button", { name: "Speichern" })).toBeNull();
    // Opening the form saves nothing.
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(saves()).toEqual([]);

    fireEvent.click(screen.getByRole("checkbox", { name: "PIN zum Steuern verlangen" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]).toMatchObject({ requirePin: false, server: "pbx.local" });
    await waitFor(() => expect(useToasts.getState().toasts[0]).toMatchObject({ title: "Automatisch gespeichert" }));
  });

  it("saves a text field when it is left, not on every key, and sends a typed password once", async () => {
    setup();
    const server = await screen.findByPlaceholderText(/pbx.example.de/);
    fireEvent.focus(server);
    server.focus();
    fireEvent.change(server, { target: { value: "192.168." } });
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(saves()).toEqual([]);
    fireEvent.change(server, { target: { value: "192.168.1.10" } });
    fireEvent.blur(server);
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]).toMatchObject({ server: "192.168.1.10" });
    expect(saves()[0]).not.toHaveProperty("password");

    const password = screen.getAllByPlaceholderText("nicht gesetzt")[0]!;
    password.focus();
    fireEvent.change(password, { target: { value: "geheim" } });
    fireEvent.blur(password);
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(saves()[1]).toMatchObject({ password: "geheim" });
    // The field empties and shows the stored state; nothing is sent again.
    await waitFor(() => expect((password as HTMLInputElement).value).toBe(""));
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(saves()).toHaveLength(2);
  });

  it("saves one change after the other, so a slow older answer cannot undo a newer change", async () => {
    const plain = callMock.getMockImplementation()!;
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    callMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "phone.saveConfig" && saves().length === 1) await slow;
      return plain(method, params);
    });
    setup();
    fireEvent.click(await screen.findByRole("checkbox", { name: "PIN zum Steuern verlangen" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    fireEvent.click(screen.getByRole("checkbox", { name: "Bei Fehlern" }));
    await act(() => new Promise((r) => setTimeout(r, 400)));
    // The second change waits for the first save.
    expect(saves()).toHaveLength(1);
    await act(async () => release());
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(saves()[1]).toMatchObject({ requirePin: false, notifyOn: { done: true, approval: true, error: false } });
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(saves()).toHaveLength(2);
  });

  it("saves a text field still being typed in when the settings close", async () => {
    const view = setup();
    const server = await screen.findByPlaceholderText(/pbx.example.de/);
    server.focus();
    fireEvent.change(server, { target: { value: "10.0.0.5" } });
    view.unmount();
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]).toMatchObject({ server: "10.0.0.5" });
  });

  it("keeps numbers as single entries: add one, switch one off, delete one", async () => {
    setup();
    const calls = await screen.findByRole("group", { name: "FORGE ruft diese Nummern an" });
    expect(within(calls).getByDisplayValue("0172 999")).toBeTruthy();

    // A new row without a number is not saved; its number is saved when the field is left.
    fireEvent.click(within(calls).getByRole("button", { name: /Nummer hinzufügen/ }));
    const fresh = within(calls).getByRole("textbox", { name: "Nummer von neue Nummer" });
    await waitFor(() => expect(document.activeElement).toBe(fresh));
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(saves()).toEqual([]);
    fireEvent.change(fresh, { target: { value: "030 2" } });
    fireEvent.blur(fresh);
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]!.notifyNumbers).toEqual([
      { id: "n1", number: "0172 999", label: "Handy", enabled: true },
      { id: expect.any(String), number: "030 2", label: "", enabled: true },
    ]);

    // Switched off right away, without a text field.
    // A click moves the focus out of the text field, as in the app.
    const off = within(calls).getByRole("switch", { name: "Handy ausschalten" });
    off.focus();
    fireEvent.click(off);
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect((saves()[1]!.notifyNumbers as Array<{ enabled: boolean }>).map((n) => n.enabled)).toEqual([false, true]);

    const del = within(calls).getByRole("button", { name: "030 2 löschen" });
    del.focus();
    fireEvent.click(del);
    await waitFor(() => expect(saves()).toHaveLength(3));
    expect(saves()[2]!.notifyNumbers).toEqual([{ id: "n1", number: "0172 999", label: "Handy", enabled: false }]);

    // Allowed callers are entries just the same.
    const allowed = screen.getByRole("group", { name: "Erlaubte Anrufer" });
    expect(within(allowed).getByText(/FORGE nimmt keine Anrufe an/)).toBeTruthy();
  });

  it("says why an invalid value was not saved", async () => {
    setup();
    const port = await screen.findByDisplayValue("5060");
    port.focus();
    fireEvent.change(port, { target: { value: "99999" } });
    fireEvent.blur(port);
    await waitFor(() => expect(useToasts.getState().toasts.at(-1)).toMatchObject({ tone: "error", body: expect.stringMatching(/Port/) }));
    expect(saves()).toEqual([]);
  });
});
