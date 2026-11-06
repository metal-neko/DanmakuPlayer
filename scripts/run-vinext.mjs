import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Set the environment without POSIX-only shell assignment syntax.
const child = spawn(process.execPath, [
  fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url)),
  ...process.argv.slice(2),
], {
  stdio: "inherit",
  env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
