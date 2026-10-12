import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { App } from "./App";
import { queryClient } from "./lib/queries";
import { startServerEvents } from "./lib/server-events";
import { startPresenceReporting } from "./lib/presence";
import "./styles.css";

startServerEvents(queryClient);
startPresenceReporting();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
