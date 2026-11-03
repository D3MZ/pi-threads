import { createConnection } from "node:net";
import { spawn } from "node:child_process";

const [path, token] = process.argv.slice(2);
if (!path || !token) {
  console.error("Chat thread launch information is missing.");
  process.exit(1);
}
const socket = createConnection(path);
let data = "";
let received = false;
socket.setTimeout(30000, () => socket.destroy(new Error("Thread launch timed out")));
socket.on("connect", () => socket.write(`${token}\n`));
socket.on("data", chunk => {
  data += chunk.toString("utf8");
  if (data.length > 4 * 1024 * 1024) { socket.destroy(new Error("Thread launch information is too large")); return; }
  const end = data.indexOf("\n");
  if (end < 0 || received) return;
  received = true;
  try {
    const payload = JSON.parse(data.slice(0, end));
    if (typeof payload.executable !== "string" || !Array.isArray(payload.args) || !payload.env || typeof payload.env !== "object") {
      throw new Error("Invalid thread launch information");
    }
    const env = payload.env;
    for (const key of Object.keys(process.env)) {
      if (/^(TERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|COLORTERM|GHOSTTY_.*|KITTY_.*|WINDOWID)$/.test(key)) env[key] = process.env[key];
    }
    socket.destroy();
    if (typeof process.execve === "function") {
      process.execve("/usr/bin/env", ["/usr/bin/env", payload.executable, ...payload.args], env);
      throw new Error("Could not replace the launcher process");
    }
    const child = spawn(payload.executable, payload.args, { stdio: "inherit", env });
    child.on("error", error => { console.error(`Chat thread launch failed: ${error.message}`); process.exitCode = 1; });
    child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  } catch (error) {
    console.error(`Chat thread launch failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
});
socket.on("error", error => { console.error(`Chat thread launch failed: ${error.message}`); process.exitCode = 1; });
socket.on("end", () => { if (!received) { console.error("Chat thread launch was cancelled."); process.exitCode = 1; } });
