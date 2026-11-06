import { copyFile } from "node:fs/promises";

// Keep the renderer and BrowserWindow icon identical to the packaging source.
await copyFile(
  new URL("../build-resources/icon.png", import.meta.url),
  new URL("../public/app-icon.png", import.meta.url),
);
