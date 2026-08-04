import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { applyTheme, readStoredTheme } from "./ThemeToggle.tsx";
import "./styles.css";

applyTheme(readStoredTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
