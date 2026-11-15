import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "./api"; // creates the API client first so fixture mode reads ?fixture= before any redirect
import { App } from "./App";
import { SessionProvider } from "./state/session";
import { ThemeProvider } from "./state/theme";
import "./styles.css";

document.documentElement.classList.add("js");

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <SessionProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </SessionProvider>
  </ThemeProvider>,
);
