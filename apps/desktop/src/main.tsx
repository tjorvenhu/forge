import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { App } from "./App";
import { queryClient } from "./lib/queries";
import { startServerEvents } from "./lib/server-events";
import { startPresenceReporting } from "./lib/presence";
import { chatWindowTarget, prepareChatWindowUi, startChatWindowTracking } from "./lib/chat-windows";
import { startChatWindowEvents } from "./lib/chat-window-events";
import { isScreenshotWindow, startScreenshotReceiver } from "./lib/screenshot";
import { ScreenshotOverlay } from "./components/screenshot/ScreenshotOverlay";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

if (isScreenshotWindow()) {
  // The snipping overlay of the Print key: no sidecar, no presence, only the overlay.
  root.render(
    <StrictMode>
      <TooltipProvider>
        <ScreenshotOverlay />
      </TooltipProvider>
    </StrictMode>,
  );
} else {
  const chatWindow = chatWindowTarget();
  if (chatWindow) {
    prepareChatWindowUi(chatWindow);
    startChatWindowEvents(queryClient);
  } else startServerEvents(queryClient);
  startPresenceReporting();
  startScreenshotReceiver();
  void startChatWindowTracking().catch(() => {});

  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <App chatWindow={chatWindow} />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
