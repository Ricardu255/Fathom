import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/cormorant-garamond";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource/lxgw-wenkai-tc/400.css";
import "@fontsource/pinyon-script/400.css";
import "@fontsource/special-elite/400.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { initializeTheme } from "./theme";
import "./styles.css";
import "./styles/maison.css";
import "./styles/trace.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

initializeTheme();
document.documentElement.dataset.design = "maison";
if (window.fathom !== undefined) {
  document.documentElement.dataset.desktop = "true";
  document.documentElement.dataset.platform = window.fathom.platform;
}

const root = document.getElementById("root");
if (root === null) throw new Error("Root element is missing");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
