import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "dockview/dist/styles/dockview.css";
import "katex/dist/katex.min.css";
import "./app.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
