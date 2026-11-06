import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Home from "../app/page";
import "../app/globals.css";
import { installDesktopBridge } from "./desktop";

const root = document.getElementById("root");

if (!root) throw new Error("Missing application root");

void installDesktopBridge().then(() => {
  createRoot(root).render(
    <StrictMode>
      <Home />
    </StrictMode>,
  );
});
