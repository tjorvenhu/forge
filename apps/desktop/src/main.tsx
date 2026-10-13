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
import "./styles.css";

const chatWindow = chatWindowTarget();
if (chatWindow) {
  prepareChatWindowUi(chatWindow);
  startChatWindowEvents(queryClient);
} else startServerEvents(queryClient);
startPresenceReporting();
void startChatWindowTracking().catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <App chatWindow={chatWindow} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
