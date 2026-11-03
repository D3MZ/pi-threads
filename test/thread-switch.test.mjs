import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import pty from "node-pty";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pi = spawnSync("which", ["pi"], { encoding: "utf8" }).stdout?.trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await sleep(20);
  }
}

// Answer the same probes Ghostty answers, including palette queries. The
// remainder handles queries that arrive split across PTY output chunks.
function answerTerminalQueries(host) {
  let buffer = "";
  const queries = /\x1b\[\?u|\x1b\[c|\x1b\[\?996n|\x1b\[16t|\x1b\](?:10|11);\?\x07|\x1b\]4;(\d+);\?\x07/g;
  return data => {
    buffer += data;
    let match, end = 0;
    queries.lastIndex = 0;
    while ((match = queries.exec(buffer))) {
      end = queries.lastIndex;
      const query = match[0];
      let reply;
      if (query === "\x1b[?u") reply = "\x1b[?7u";
      else if (query === "\x1b[c") reply = "\x1b[?1;2c";
      else if (query === "\x1b[?996n") reply = "\x1b[?997;1n";
      else if (query === "\x1b[16t") reply = "\x1b[6;16;8t";
      else if (query.startsWith("\x1b]4;")) reply = `\x1b]4;${match[1]};rgb:1111/2222/3333\x1b\\`;
      else reply = `\x1b]${query.startsWith("\x1b]10;") ? "10" : "11"};rgb:1111/2222/3333\x1b\\`;
      host.write(reply);
    }
    buffer = end ? buffer.slice(end) : buffer.slice(-100);
  };
}

test("switching a real Pi thread does not echo Ghostty release events", { skip: !pi && "Pi is not on PATH", timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-chatthreads-test-"));
  const agent = join(dir, "agent");
  const main = join(dir, "main.jsonl"), fork = join(dir, "fork.jsonl");
  const now = new Date().toISOString();
  for (const [file, text] of [[main, "MAIN MARKER"], [fork, "FORK MARKER"]]) {
    const header = { type: "session", version: 3, id: randomUUID(), timestamp: now, cwd: dir };
    const message = { type: "message", id: "a1b2c3d4", parentId: null, timestamp: now, message: { role: "user", content: text, timestamp: Date.now() } };
    writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
  }
  mkdirSync(join(agent, "chatthreads"), { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  const registry = join(agent, "chatthreads", `${createHash("sha256").update(main).digest("hex")}.json`);
  writeFileSync(registry, JSON.stringify({ version: 1, root: main, threads: [{ slot: "1", session: main, title: "Main" }, { slot: "2", session: fork, title: "Fork" }] }));

  // Ensure the switching key releases arrive while the child PTY is still in
  // canonical/echo mode, independent of machine startup speed.
  const wrapper = join(dir, "delayed-pi");
  writeFileSync(wrapper, '#!/bin/sh\nsleep 1\nexec "$PI_TEST_PI_EXECUTABLE" "$@"\n');
  chmodSync(wrapper, 0o700);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_")));
  Object.assign(env, { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_PROGRAM_STATUS: "0", PI_CHATTHREADS_PI: wrapper, PI_TEST_PI_EXECUTABLE: pi });
  const host = pty.spawn(pi, ["--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-themes", "--no-prompt-templates", "--no-context-files", "--tui-mode", "fullscreen", "-e", join(root, "chatthreads.ts"), "--session", main], { cwd: dir, env, cols: 100, rows: 30 });
  let exited = false;
  host.onExit(() => { exited = true; });
  t.after(async () => {
    try { host.kill(); } catch {}
    await waitFor(() => exited, "test Pi to exit", 5000).catch(() => {});
    // Only processes from this isolated test registry are ever touched.
    try {
      const group = JSON.parse(readFileSync(registry, "utf8"));
      for (const thread of group.threads) if (thread.pid) { try { process.kill(thread.pid, "SIGTERM"); } catch {} }
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  let output = "";
  const answer = answerTerminalQueries(host);
  host.onData(data => { output += data; answer(data); });

  await waitFor(() => output.includes("MAIN MARKER"), "main thread");
  const start = output.length;
  host.write("\x1b[50;5u"); // Ctrl+2
  await waitFor(() => output.slice(start).includes("\x1b[=31u\x1b[2J\x1b[H"), "switch to the new PTY");
  host.write("\x1b[50;5:3u\x1b[57441;1:3u"); // key and Ctrl release
  host.write("draft-early-marker");
  await sleep(200);
  assert.doesNotMatch(output.slice(start), /\^\[|draft-early-marker/, "early input must not be echoed by the uninitialized PTY");
  await waitFor(() => output.slice(start).includes("FORK MARKER") && output.slice(start).includes("draft-early-marker"), "fork and buffered draft");
  assert.doesNotMatch(output.slice(start), /\^\[/);
  // The editor starts before session_start connects the bridge. Activation
  // re-queries the terminal palette, after the initial startup palette query.
  await waitFor(() => (output.slice(start).match(/\x1b\]10;\?/g) || []).length >= 2, "fork activation");

  const back = output.length;
  host.write("\x1b[49;5u"); // Ctrl+1
  await waitFor(() => output.slice(back).includes("MAIN MARKER"), "return to main");
  const revisit = output.length;
  host.write("\x1b[50;5u");
  await waitFor(() => output.slice(revisit).includes("FORK MARKER") && output.slice(revisit).includes("draft-early-marker"), "reopen fork with its draft");
  assert.doesNotMatch(output.slice(revisit), /\^\[/);
});

test("Ctrl+Esc closes the active fork and selects the newest remaining fork", { skip: !pi && "Pi is not on PATH", timeout: 45000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-threads-close-test-"));
  const agent = join(dir, "agent");
  const sessions = Object.fromEntries(["1", "4", "2", "3"].map(slot => [slot, join(dir, `session-${slot}.jsonl`)]));
  const now = new Date().toISOString();
  for (const [slot, file] of Object.entries(sessions)) {
    const header = { type: "session", version: 3, id: randomUUID(), timestamp: now, cwd: dir };
    const message = { type: "message", id: "a1b2c3d4", parentId: null, timestamp: now, message: { role: "user", content: `THREAD-${slot}-MARKER`, timestamp: Date.now() } };
    writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
  }
  mkdirSync(join(agent, "chatthreads"), { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  const registry = join(agent, "chatthreads", `${createHash("sha256").update(sessions["1"]).digest("hex")}.json`);
  // Creation order differs from slot order; thread 3 is nested under thread 2.
  const parents = { "4": sessions["1"], "2": sessions["1"], "3": sessions["2"] };
  writeFileSync(registry, JSON.stringify({ version: 1, root: sessions["1"], threads: ["1", "4", "2", "3"].map(slot => ({ slot, session: sessions[slot], title: `Thread ${slot}`, ...(parents[slot] ? { parent: parents[slot], entry: `entry-${slot}` } : {}) })) }));
  const group = () => JSON.parse(readFileSync(registry, "utf8"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_")));
  Object.assign(env, { HOME: dir, TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_PROGRAM_STATUS: "0", PI_CHATTHREADS_PI: pi });
  const host = pty.spawn(pi, ["--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-themes", "--no-prompt-templates", "--no-context-files", "--tui-mode", "fullscreen", "-e", join(root, "chatthreads.ts"), "--session", sessions["1"]], { cwd: dir, env, cols: 160, rows: 35 });
  let exited = false, output = "";
  host.onExit(() => { exited = true; });
  const answer = answerTerminalQueries(host);
  host.onData(data => { output += data; answer(data); });
  t.after(async () => {
    try { host.kill(); } catch {}
    await waitFor(() => exited, "test Pi to exit", 5000).catch(() => {});
    try { for (const thread of group().threads) if (thread.pid) { try { process.kill(thread.pid, "SIGTERM"); } catch {} } } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await waitFor(() => output.includes("THREAD-1-MARKER"), "main thread");
  let start = output.length;
  host.write("\x1b[50;5u"); // Ctrl+2
  await waitFor(() => output.slice(start).includes("THREAD-2-MARKER") && (output.slice(start).match(/\x1b\]10;\?/g) || []).length >= 2, "thread 2 activation");
  start = output.length;
  host.write("\x1b[57442;5u"); // Hold Ctrl to show the preview.
  await waitFor(() => stripVTControlCharacters(output.slice(start)).includes("Threads: 1 [2] 3 4"), "thread preview");
  assert.match(stripVTControlCharacters(output.slice(start)), /ctrl\+esc to close this thread/);

  start = output.length;
  host.write("\x1b[27;5u"); // Ctrl+Esc
  await waitFor(() => !group().threads.some(thread => thread.slot === "2") && output.slice(start).includes("THREAD-3-MARKER") && (output.slice(start).match(/\x1b\]10;\?/g) || []).length >= 2, "close 2 and switch to newest thread 3");
  assert(existsSync(sessions["2"]), "closing must retain the session file");
  assert.equal(group().threads.find(thread => thread.slot === "3").parent, sessions["2"], "nested threads remain registered");
  host.write("\x1b[27;5:2u\x1b[27;5:3u\x1b[57442;1:3u\x1b[27;6u"); // Repeats, releases and Ctrl+Shift+Esc must not close another thread.
  await sleep(300);
  host.write("\x1b"); // Plain Escape is still not a close shortcut.
  await sleep(100);
  assert.deepEqual(group().threads.map(thread => thread.slot), ["1", "4", "3"]);

  start = output.length;
  host.write("\x1b[27;5u");
  await waitFor(() => !group().threads.some(thread => thread.slot === "3") && output.slice(start).includes("THREAD-4-MARKER") && (output.slice(start).match(/\x1b\]10;\?/g) || []).length >= 2, "close 3 and switch to thread 4");
  assert(existsSync(sessions["3"]));
  start = output.length;
  host.write("\x1b[27;5u");
  await waitFor(() => group().threads.length === 1 && output.slice(start).includes("THREAD-1-MARKER"), "close last fork and switch to main");
  assert(existsSync(sessions["4"]));

  start = output.length;
  host.write("\x1b[27;5u");
  await waitFor(() => stripVTControlCharacters(output.slice(start)).includes("main thread cannot be closed"), "main thread protection");
  assert.equal(exited, false);
  assert.deepEqual(group().threads.map(thread => thread.slot), ["1"]);
});

test("Ctrl+Esc works after reloading the host without restarting its running fork", { skip: !pi && "Pi is not on PATH", timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-threads-reload-test-"));
  const agent = join(dir, "agent");
  const main = join(dir, "main.jsonl"), fork = join(dir, "fork.jsonl");
  mkdirSync(join(agent, "chatthreads"), { recursive: true });
  const now = new Date().toISOString();
  for (const [file, text] of [[main, "RELOAD-MAIN"], [fork, "RELOAD-FORK"]]) {
    const header = { type: "session", version: 3, id: randomUUID(), timestamp: now, cwd: dir };
    const message = { type: "message", id: "a1b2c3d4", parentId: null, timestamp: now, message: { role: "user", content: text, timestamp: Date.now() } };
    writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
  }
  const registry = join(agent, "chatthreads", `${createHash("sha256").update(main).digest("hex")}.json`);
  writeFileSync(registry, JSON.stringify({ version: 1, root: main, threads: [{ slot: "1", session: main, title: "Main" }, { slot: "2", session: fork, title: "Fork" }] }));
  const group = () => JSON.parse(readFileSync(registry, "utf8"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_")));
  Object.assign(env, { HOME: dir, TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_PROGRAM_STATUS: "0", PI_CHATTHREADS_PI: pi });
  const host = pty.spawn(pi, ["--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-themes", "--no-prompt-templates", "--no-context-files", "--tui-mode", "fullscreen", "-e", join(root, "chatthreads.ts"), "--session", main], { cwd: dir, env, cols: 120, rows: 30 });
  let exited = false, output = "";
  host.onExit(() => { exited = true; });
  const answer = answerTerminalQueries(host);
  host.onData(data => { output += data; answer(data); });
  t.after(async () => {
    try { host.kill(); } catch {}
    await waitFor(() => exited, "test Pi to exit", 5000).catch(() => {});
    try { for (const thread of group().threads) if (thread.pid) { try { process.kill(thread.pid, "SIGTERM"); } catch {} } } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await waitFor(() => output.includes("RELOAD-MAIN"), "main thread");
  let start = output.length;
  host.write("\x1b[50;5u");
  await waitFor(() => output.slice(start).includes("RELOAD-FORK") && (output.slice(start).match(/\x1b\]10;\?/g) || []).length >= 2, "fork activation");
  const forkPid = group().threads.find(thread => thread.slot === "2").pid;
  assert(forkPid);
  start = output.length;
  host.write("\x1b[49;5u");
  await waitFor(() => output.slice(start).includes("RELOAD-MAIN"), "return to main");
  start = output.length;
  host.write("\x1b[200~/reload\x1b[201~");
  await sleep(100);
  host.write("\r");
  await waitFor(() => stripVTControlCharacters(output.slice(start)).includes("Reloaded keybindings, extensions"), "reload");
  start = output.length;
  host.write("\x1b[50;5u");
  await waitFor(() => output.slice(start).includes("RELOAD-FORK"), "return to preserved fork");
  assert.equal(group().threads.find(thread => thread.slot === "2").pid, forkPid);
  start = output.length;
  host.write("\x1b[27;5u");
  await waitFor(() => !group().threads.some(thread => thread.slot === "2") && output.slice(start).includes("RELOAD-MAIN"), "close fork after reload").catch(error => {
    throw new Error(`${error.message}\nRegistry: ${JSON.stringify(group())}\nOutput: ${stripVTControlCharacters(output.slice(start)).slice(-3000)}`);
  });
});
