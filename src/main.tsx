import { createRoot } from "react-dom/client";
import App from "./App";

// StrictMode is left out on purpose: it mounts effects twice in development,
// which would start the audio engine twice.
createRoot(document.getElementById("root")!).render(<App />);
