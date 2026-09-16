import "./errlog";
import ReactDOM from "react-dom/client";
import App from "./App";
import "dockview/dist/styles/dockview.css";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark-dimmed.css";
import "./app.css";

// No StrictMode: its double effects open and kill a real pty, and the stale pty-exit closes the re-mounted pane.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
