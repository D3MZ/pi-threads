import { strict as assert } from "node:assert";
import { spawn as spawnProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node-pty";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_THREADS_TEST_PI || "pi";
const extension = join(root, "chatthreads.ts");
const mockProvider = join(root, "test", "fixtures", "mock-provider.ts");
const flags = ["--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-threads-test-"));
  const agent = join(dir, "agent");
  mkdirSync(join(agent, "chatthreads"), { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !key.startsWith("PI_") && value !== undefined));
  Object.assign(env, { HOME: dir, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_CHATTHREADS_PI: pi, TERM: "xterm-256color" });
  return { dir, agent, env };
}

function writeSession(path, marker) {
  const now = Date.now();
  const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date(now).toISOString(), cwd: root };
  const message = {
    type: "message", id: "a1b2c3d4", parentId: null, timestamp: new Date(now).toISOString(),
    message: {
      role: "assistant", content: [{ type: "text", text: marker }], api: "openai-completions", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: now,
    },
  };
  writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
}

async function waitFor(readOutput, predicate, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const output = stripVTControlCharacters(readOutput());
    if (predicate(output)) return output;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}. Output:\n${stripVTControlCharacters(readOutput()).slice(-5000)}`);
}

test("registers one threads command", { timeout: 30000 }, async () => {
  const { dir, env } = fixture();
  const child = spawnProcess(pi, [...flags, "--mode", "rpc", "-e", extension], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  try {
    child.stdin.write('{"type":"get_commands"}\n');
    await waitFor(() => stdout, text => text.includes('"command":"get_commands"'), "command list");
    const response = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(event => event.command === "get_commands");
    assert.equal(response.success, true, stderr);
    const names = response.data.commands.filter(command => command.source === "extension").map(command => command.name);
    assert.deepEqual(names, ["threads"]);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new sessions warn until the first conversation, then Control activates threads", { timeout: 30000 }, async () => {
  const { dir, agent, env } = fixture();
  const session = join(dir, "new-session.jsonl");
  const pty = spawn(pi, [...flags, "--provider", "threads-test", "--model", "mock", "--tui-mode", "fullscreen", "--session", session, "-e", extension, "-e", mockProvider], { name: "xterm-256color", cols: 120, rows: 35, cwd: root, env });
  let output = "";
  pty.onData(data => { output += data; });
  const exited = new Promise(resolve => pty.onExit(resolve));
  const warning = "Warning: Threads: Heyah! Start talking to the agent first, then activate this.";
  async function expectWarning(trigger, description) {
    const index = output.length;
    await trigger();
    const text = await waitFor(() => output.slice(index), text => text.includes(warning), description);
    assert.doesNotMatch(text, /Error: (?:Chat threads|Could not open thread)/);
  }
  async function submit(text) {
    pty.write(`\x1b[200~${text}\x1b[201~`);
    await sleep(100);
    pty.write("\r");
  }
  try {
    await waitFor(() => output, text => text.includes("MOCK_READY_MARKER"), "Pi startup");
    assert.equal(existsSync(session), false, "the new session should not be saved yet");
    await expectWarning(() => pty.write("\x1b[57441;5u"), "Control warning");
    pty.write("\x1b[57441;1:3u"); // Control release
    await expectWarning(() => submit("/threads on"), "on warning");
    await expectWarning(() => submit("/threads show"), "show warning");
    await expectWarning(() => submit("/threads 2"), "switch warning");
    assert.equal(existsSync(session), false);

    const index = output.length;
    await submit("Hello, agent!");
    await waitFor(() => output.slice(index), text => text.includes("MOCK_RESPONSE_MARKER"), "first agent response");
    assert.equal(existsSync(session), true, "the first conversation should save the session");
    const preview = output.length;
    pty.write("\x1b[57441;5u");
    await waitFor(() => output.slice(preview), text => text.includes("Threads:") && text.includes("[1]"), "Control preview after chatting");
    pty.write("\x1b[57441;1:3u");
    const registry = join(agent, "chatthreads", `${createHash("sha256").update(session).digest("hex")}.json`);
    assert.equal(JSON.parse(readFileSync(registry, "utf8")).root, session);
  } finally {
    try { pty.kill("SIGTERM"); } catch {}
    const timer = setTimeout(() => { try { pty.kill("SIGKILL"); } catch {} }, 5000);
    timer.unref();
    await exited;
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ephemeral sessions get the same missing-session warning", { timeout: 30000 }, async t => {
  const { dir, env } = fixture();
  const pty = spawn(pi, [...flags, "--no-session", "--tui-mode", "fullscreen", "-e", extension, "-e", mockProvider], { name: "xterm-256color", cols: 120, rows: 35, cwd: root, env });
  let output = "";
  pty.onData(data => { output += data; });
  const exited = new Promise(resolve => pty.onExit(resolve));
  t.after(async () => {
    try { pty.kill("SIGTERM"); } catch {}
    const timer = setTimeout(() => { try { pty.kill("SIGKILL"); } catch {} }, 5000);
    timer.unref();
    await exited;
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => output, text => text.includes("MOCK_READY_MARKER"), "Pi startup");
  const index = output.length;
  pty.write("\x1b[57441;5u");
  const result = await waitFor(() => output.slice(index), text => text.includes("Warning: Threads: Heyah! Start talking to the agent first, then activate this."), "ephemeral session warning");
  assert.doesNotMatch(result, /Error: Chat threads/);
});

test("other thread activation failures remain errors", { timeout: 30000 }, async t => {
  const { dir, env } = fixture();
  const session = join(dir, "main.jsonl");
  writeSession(session, "MAIN_SESSION_MARKER");
  const pty = spawn(pi, [...flags, "--tui-mode", "regular", "--session", session, "-e", extension], { name: "xterm-256color", cols: 120, rows: 35, cwd: root, env });
  let output = "";
  pty.onData(data => { output += data; });
  const exited = new Promise(resolve => pty.onExit(resolve));
  t.after(async () => {
    try { pty.kill("SIGTERM"); } catch {}
    const timer = setTimeout(() => { try { pty.kill("SIGKILL"); } catch {} }, 5000);
    timer.unref();
    await exited;
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => output, text => text.includes("MAIN_SESSION_MARKER"), "saved session");
  const index = output.length;
  pty.write("\x1b[200~/threads on\x1b[201~");
  await sleep(100);
  pty.write("\r");
  await waitFor(() => output.slice(index), text => text.includes("Error: Chat threads: Visible-message targets require Pi fullscreen mode"), "fullscreen mode error");
});

test("thread commands work in Pi, including cancelling a pending reply and switching", { timeout: 60000 }, async () => {
  const { dir, agent, env } = fixture();
  const main = join(dir, "main.jsonl"), fork = join(dir, "fork.jsonl");
  writeSession(main, "MAIN_SESSION_MARKER");
  writeSession(fork, "FORK_SESSION_MARKER");
  const registry = join(agent, "chatthreads", `${createHash("sha256").update(main).digest("hex")}.json`);
  writeFileSync(registry, JSON.stringify({ version: 1, root: main, threads: [
    { slot: "1", session: main, title: "Main" }, { slot: "2", session: fork, title: "Fork test" },
  ] }));
  const pty = spawn(pi, [...flags, "--tui-mode", "fullscreen", "--session", main, "-e", extension], { name: "xterm-256color", cols: 120, rows: 35, cwd: root, env });
  let output = "";
  pty.onData(data => { output += data; });
  const exited = new Promise(resolve => pty.onExit(resolve));
  const since = index => () => output.slice(index);
  async function submit(text) {
    // Bracketed paste avoids autocomplete accepting a partial command instead of submitting it.
    pty.write(`\x1b[200~${text}\x1b[201~`);
    await sleep(100);
    pty.write("\r");
  }
  async function send(text, expected, description) {
    const index = output.length;
    await submit(text);
    return waitFor(since(index), expected, description);
  }
  try {
    await waitFor(() => output, text => text.includes("MAIN_SESSION_MARKER"), "main session");
    let index = output.length;
    pty.write("/threads ");
    const suggestions = await waitFor(since(index), text => ["on", "off", "show", "keybinding"].every(item => text.includes(item)), "subcommand suggestions");
    assert.doesNotMatch(suggestions, /\bforget\b|reply <number>/);
    pty.write("\x1b"); // Close autocomplete, then clear the editor.
    await sleep(150);
    pty.write("\x15");
    await sleep(150);
    await send("/threads keybinding", text => text.includes("Thread keybindings") && text.includes("Target shortcut"), "keybinding selector");
    index = output.length;
    pty.write("\r");
    await waitFor(since(index), text => text.includes("Target shortcut") && text.includes("ctrl+;"), "keybinding input");
    index = output.length;
    pty.write("ctrl+alt+;\r");
    await waitFor(since(index), text => text.includes("Shortcuts saved"), "saved keybinding");
    assert.equal(JSON.parse(readFileSync(join(agent, "chatthreads", "config.json"), "utf8")).targets, "ctrl+alt+;");
    await send("/reload", text => text.includes("Reloaded keybindings, extensions"), "reload keybindings");
    index = output.length;
    pty.write("\x1b[59;7u"); // Ctrl+Alt+; in the Kitty keyboard protocol.
    await waitFor(since(index), text => text.includes("Threads:") && text.includes("[1]"), "updated keybinding");
    await submit("/threads off");
    await sleep(150);
    await send("/threads on", text => text.includes("Threads:") && text.includes("[1]") && text.includes("2"), "numbered view");
    // Running on twice must not turn the numbered view off.
    await submit("/threads on");
    await sleep(200);
    const removedTarget = await send("/threads reply 3", text => text.includes("Use /threads on, off, show, keybinding"), "removed reply command for a target");
    assert.doesNotMatch(removedTarget, /Replying to 3/);
    const removedSwitch = await send("/threads reply 2", text => text.includes("Use /threads on, off, show, keybinding"), "removed reply command for a registered thread");
    assert.doesNotMatch(removedSwitch, /FORK_SESSION_MARKER/);
    assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")).threads.map(thread => thread.slot), ["1", "2"]);
    index = output.length;
    pty.write("\x1b[51;5u"); // Ctrl+3 selects the visible message.
    await waitFor(since(index), text => text.includes("Replying to 3"), "keyboard-selected reply");
    // Type normally so completion is exercised while a reply is pending.
    index = output.length;
    pty.write("/threads o");
    await waitFor(since(index), text => text.includes("Hide numbers and cancel a pending reply"), "off autocomplete");
    pty.write("ff");
    await sleep(300);
    pty.write("\r"); // A fully typed command should run with one Enter.
    await sleep(250);
    await send("/threads reply 3", text => text.includes("Use /threads on, off, show, keybinding"), "reply command remains unavailable with targets hidden");
    await send("/threads on", text => text.includes("Threads:") && text.includes("[1]"), "off cancels the pending reply and allows targets to reopen");
    const unregistered = await send("/threads 3", text => text.includes("Thread 3 is unavailable"), "an unregistered target cannot be opened by command");
    assert.doesNotMatch(unregistered, /Replying to 3/);
    await submit("/threads off");
    assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")).threads.map(thread => thread.slot), ["1", "2"]);
    await send("/threads show", text => text.includes("Chat threads") && text.includes("Fork test"), "thread selector");
    pty.write("\x1b");
    await sleep(150);
    await send("/threads 2", text => text.includes("FORK_SESSION_MARKER"), "switch to fork");
    await send("/threads 1", text => text.includes("MAIN_SESSION_MARKER"), "switch back to main");
    await send("/threads", text => text.includes("Use /threads on, off, show, keybinding"), "command usage");
    await send("/threads forget 2", text => text.includes("Use /threads on, off, show, keybinding"), "removed forget command");
    assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")).threads.map(thread => thread.slot), ["1", "2"]);
    await send("/threads nonsense", text => text.includes("Use /threads on, off, show, keybinding"), "invalid command usage");
  } finally {
    try { pty.kill("SIGTERM"); } catch {}
    const timer = setTimeout(() => { try { pty.kill("SIGKILL"); } catch {} }, 5000);
    timer.unref();
    await exited;
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Ctrl+number creates a fork and switches to an existing thread", { timeout: 60000 }, async () => {
  const { dir, agent, env } = fixture();
  const main = join(dir, "main.jsonl");
  const registry = join(agent, "chatthreads", `${createHash("sha256").update(main).digest("hex")}.json`);
  const pty = spawn(pi, [...flags, "--provider", "threads-test", "--model", "mock", "--tui-mode", "fullscreen", "--session", main, "-e", extension, "-e", mockProvider], { name: "xterm-256color", cols: 120, rows: 35, cwd: root, env });
  let output = "";
  pty.onData(data => { output += data; });
  const exited = new Promise(resolve => pty.onExit(resolve));
  const since = index => () => output.slice(index);
  const group = () => JSON.parse(readFileSync(registry, "utf8"));
  const messages = path => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "message");
  const textOf = entry => Array.isArray(entry.message.content) ? entry.message.content.map(part => part.text || "").join("") : entry.message.content;
  async function submit(text) {
    pty.write(`\x1b[200~${text}\x1b[201~`);
    await sleep(100);
    pty.write("\r");
  }
  try {
    await waitFor(() => output, text => text.includes("MOCK_READY_MARKER"), "Pi startup");
    let index = output.length;
    await submit("MAIN_CONTEXT_MARKER");
    await waitFor(since(index), text => text.includes("MOCK_RESPONSE_MARKER"), "main response");

    index = output.length;
    pty.write("\x1b[57441;5u"); // Hold Ctrl to show targets.
    await waitFor(since(index), text => text.includes("Threads:") && text.includes("2 ›"), "numbered target");
    index = output.length;
    pty.write("\x1b[50;5u"); // Ctrl+2 selects the target.
    await waitFor(since(index), text => text.includes("Replying to 2"), "keyboard-selected target");
    pty.write("\x1b[57441;1:3u"); // Release Ctrl before typing.

    index = output.length;
    await submit("FORK_REPLY_MARKER");
    await waitFor(since(index), text => {
      try {
        const fork = group().threads.find(thread => thread.slot === "2");
        if (!fork || !text.includes("FORK_REPLY_MARKER")) return false;
        const entries = messages(fork.session);
        return entries.some(entry => entry.message.role === "user" && textOf(entry) === "FORK_REPLY_MARKER")
          && entries.filter(entry => entry.message.role === "assistant" && textOf(entry) === "MOCK_RESPONSE_MARKER").length === 2;
      } catch { return false; }
    }, "fork reply and response");
    const fork = group().threads.find(thread => thread.slot === "2");
    assert.equal(fork.parent, main);
    assert(messages(fork.session).some(entry => entry.message.role === "user" && textOf(entry) === "MAIN_CONTEXT_MARKER"));
    assert(!messages(main).some(entry => textOf(entry) === "FORK_REPLY_MARKER"));

    index = output.length;
    await submit("/threads 1");
    await waitFor(since(index), text => text.includes("MAIN_CONTEXT_MARKER"), "return to main");
    index = output.length;
    pty.write("\x1b[57441;5u");
    await waitFor(since(index), text => text.includes("Threads:") && text.includes("2"), "thread preview");
    index = output.length;
    pty.write("\x1b[50;5u"); // The registered number now switches instead of creating another fork.
    await waitFor(since(index), text => text.includes("FORK_REPLY_MARKER"), "switch to existing thread");
    pty.write("\x1b[57441;1:3u");
    assert.deepEqual(group().threads.map(thread => thread.slot), ["1", "2"]);
  } finally {
    try { pty.kill("SIGTERM"); } catch {}
    const timer = setTimeout(() => { try { pty.kill("SIGKILL"); } catch {} }, 5000);
    timer.unref();
    await exited;
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  }
});
