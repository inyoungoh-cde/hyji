import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

// Suppress the native WebView2 browser context menu throughout the app.
// HYJI's own context menus (PDF text selection, paper list) call
// e.preventDefault() themselves; this catch-all blocks it everywhere else.
document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
