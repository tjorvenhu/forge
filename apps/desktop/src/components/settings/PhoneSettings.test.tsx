import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  notifyNumber: "0172 999",
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
