import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { TerminalMux, connectThread } from "./terminal-mux.mjs";
import { isCloseShortcut, parseKeyboardEvent } from "./keyboard.ts";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const slots = "1234567890";
const childSlots = slots.slice(1);
const directory = join(getAgentDir(), "chatthreads");
const configPath = join(directory, "config.json");
const extensionPath = fileURLToPath(import.meta.url);
const defaults = { targets: "ctrl+;", prefix: "ctrl", previous: "ctrl+shift+left", next: "ctrl+shift+right", newThread: "ctrl+n", mainThread: "ctrl+shift+1" };
type Config = typeof defaults;
type Thread = { slot: string; session: string; title: string; pid?: number; tty?: string; terminalId?: string; parent?: string; entry?: string; reservedAt?: number; kind?: "rpc" | "tui"; kickoff?: string };
type Group = { version: 1; root: string; threads: Thread[] };
type Target = { entry: string; boundary: string; title: string; slot: string };
type Reply = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
type Entry = any;

function loadConfig(): Config {
  try {
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    const config = Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, typeof saved[k] === "string" ? saved[k].toLowerCase().trim() : v])) as Config;
    // Preserve older bindings when a newly introduced default overlaps one.
    const used = [config.targets, config.previous, config.next, ...[...slots].map(s => `${config.prefix}+${s}`)].map(shortcutSignature);
    for (const name of ["newThread", "mainThread"] as const) {
      if (typeof saved[name] === "string") used.push(shortcutSignature(config[name]));
    }
    for (const [name, candidates] of [
      ["newThread", ["ctrl+n", "ctrl+shift+n", "ctrl+alt+n", "alt+n", "super+n"]],
      ["mainThread", ["ctrl+shift+1", "ctrl+alt+1", "alt+1", "ctrl+alt+shift+1", "ctrl+super+1", "super+1"]],
    ] as const) {
      if (typeof saved[name] === "string") continue;
      config[name] = candidates.find(v => !used.includes(shortcutSignature(v))) || config[name];
      used.push(shortcutSignature(config[name]));
    }
    const prefix = /^(?:(?:ctrl|alt|shift|super)\+)*(?:ctrl|alt|shift|super)$/;
    const key = /^(?:(?:ctrl|alt|shift|super)\+)+(?:[a-z0-9;]|left|right|up|down|f(?:[1-9]|1[0-2]))$/;
    return prefix.test(config.prefix) && [config.targets, config.previous, config.next, config.newThread, config.mainThread].every(v => key.test(v)) && uniqueShortcuts(config) ? config : { ...defaults };
  } catch { return { ...defaults }; }
}
function shortcutSignature(key: string) {
  const parts = key.split("+");
  const name = parts.pop();
  return `${[...new Set(parts)].sort().join("+")}+${name}`;
}
function uniqueShortcuts(config: Config) {
  const keys = [config.targets, config.previous, config.next, config.newThread, config.mainThread, ...[...slots].map(s => `${config.prefix}+${s}`)].map(shortcutSignature);
  return new Set(keys).size === keys.length;
}
function ensureDir() { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
function groupPath(root: string) { return join(directory, `${createHash("sha256").update(root).digest("hex")}.json`); }
function readGroup(path: string): Group | undefined {
  try {
    const g = JSON.parse(readFileSync(path, "utf8"));
    if (g.version === 1 && typeof g.root === "string" && Array.isArray(g.threads)) return g;
  } catch { /* absent or malformed */ }
}
function writeGroup(path: string, group: Group) {
  ensureDir();
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(group), { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally { try { unlinkSync(tmp); } catch {} }
}
function pidAlive(pid?: number) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}
function prune(g: Group) {
  for (const thread of g.threads) {
    if (thread.pid && !pidAlive(thread.pid)) { delete thread.pid; delete thread.tty; delete thread.terminalId; }
    if (thread.reservedAt && Date.now() - thread.reservedAt >= 120000) delete thread.reservedAt;
  }
}
async function locked<T>(path: string, fn: (group: Group | undefined) => T): Promise<T> {
  ensureDir();
  const lock = `${path}.lock`;
  const end = Date.now() + 5000;
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 30000) rmSync(lock, { recursive: true, force: true }); } catch {}
      if (Date.now() > end) throw new Error("Thread registry is busy");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  try {
    const group = readGroup(path);
    if (group) prune(group);
    return fn(group);
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
function findGroup(session: string): { path: string; group: Group } | undefined {
  const inherited = process.env.PI_CHATTHREADS_GROUP;
  const paths: string[] = [];
  if (inherited && basename(inherited).match(/^[a-f0-9]{64}\.json$/) && inherited === join(directory, basename(inherited))) paths.push(inherited);
  const own = groupPath(session);
  if (!paths.includes(own)) paths.push(own);
  try { for (const f of readdirSync(directory)) if (/^[a-f0-9]{64}\.json$/.test(f)) paths.push(join(directory, f)); } catch {}
  for (const path of new Set(paths)) {
    const group = readGroup(path);
    if (group && (group.root === session || group.threads.some(t => t.session === session))) return { path, group };
  }
}
function parentFlags() {
  const source = process.argv.slice(2), result: string[] = [];
  const switches = new Set(["--offline", "--verbose", "--no-extensions", "-ne", "--no-mcp", "--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-context-files", "-nc", "--no-themes", "--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--approve", "-a", "--no-approve", "-na"]);
  const valued = new Set(["--extension", "-e", "--skill", "--prompt-template", "--theme", "--use-theme", "--tools", "-t", "--exclude-tools", "-xt", "--models", "--system-prompt", "--append-system-prompt", "--api-key"]);
  for (let i = 0; i < source.length; i++) {
    const arg = source[i];
    if (arg === "--") break;
    if (switches.has(arg)) result.push(arg);
    else if (valued.has(arg) && source[i + 1]) {
      const value = source[++i];
      if (!((arg === "-e" || arg === "--extension") && value === extensionPath)) result.push(arg, value);
    }
    else if (["--session", "--session-id", "--session-dir", "--fork", "--provider", "--model", "--thinking", "--tui-mode", "--name", "-n", "--mode"].includes(arg)) i++;
    else if (arg === "--continue" || arg === "--resume" || arg === "--no-session") continue;
    else if (arg.startsWith("--")) {
      // Mirror Pi's parsing of extension-defined flags, including string values.
      result.push(arg);
      const next = source[i + 1];
      if (!arg.includes("=") && next && !next.startsWith("-") && !next.startsWith("@")) result.push(source[++i]);
    }
  }
  return result;
}
function titleFor(entry: Entry) {
  if (entry.type === "message") {
    if (entry.message.role === "toolResult") return `${entry.message.toolName || "Tool"} result`;
    if (entry.message.role === "bashExecution") return `Shell: ${entry.message.command}`.slice(0, 70);
    const parts = entry.message.content;
    return (Array.isArray(parts) ? parts.map((c: any) => c.text || c.thinking || "").join(" ") : String(parts || "")).replace(/\s+/g, " ").trim().slice(0, 70) || "Assistant response";
  }
  if (entry.type === "custom") return entry.customType || "Extension entry";
  if (entry.type === "custom_message") return entry.customType || "Extension message";
  if (entry.type === "compaction") return "Compaction summary";
  if (entry.type === "branch_summary") return "Branch summary";
  return "Message";
}
// A model request must never end between an assistant's tool calls and their results.
function safeBoundary(branch: Entry[], index: number): string | undefined {
  const outstanding = new Set<string>();
  const apply = (entry: Entry) => {
    if (entry.type !== "message") return;
    if (entry.message.role === "assistant") for (const c of entry.message.content || []) if (c.type === "toolCall") outstanding.add(c.id);
    if (entry.message.role === "toolResult") outstanding.delete(entry.message.toolCallId);
  };
  for (let i = 0; i <= index; i++) apply(branch[i]);
  if (!outstanding.size) return branch[index].id;
  for (let i = index + 1; i < branch.length; i++) {
    const e = branch[i];
    if (e.type === "message" && (e.message.role === "assistant" || e.message.role === "user")) return undefined;
    apply(e);
    if (!outstanding.size) return e.id;
  }
}
function componentEntry(component: any, branch: Entry[]): Entry | undefined {
  if (component.entry?.id) return branch.find(e => e.id === component.entry.id);
  if (component.toolCallId) return branch.find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === component.toolCallId);
  if (component.lastMessage?.role === "assistant") {
    if (component.messageId) return branch.find(e => e.id === component.messageId && e.type === "message" && e.message.role === "assistant");
    const matches = branch.filter(e => e.type === "message" && e.message.role === "assistant" && e.message.timestamp === component.lastMessage.timestamp && JSON.stringify(e.message.content) === JSON.stringify(component.lastMessage.content));
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (typeof component.getCommand === "function" && component.status !== "running") {
    const found = branch.filter(e => e.type === "message" && e.message.role === "bashExecution" && e.message.command === component.getCommand() && (e.message.output || "") === component.getOutput());
    return found.length === 1 ? found[0] : undefined;
  }
  const m = component.message;
  if (m?.role === "custom") {
    const found = branch.filter(e => e.type === "custom_message" && e.display && e.customType === m.customType && Date.parse(e.timestamp) === m.timestamp);
    return found.length === 1 ? found[0] : undefined;
  }
  if (m?.role === "compactionSummary" || m?.role === "branchSummary") {
    const type = m.role === "compactionSummary" ? "compaction" : "branch_summary";
    const found = branch.filter(e => e.type === type && e.summary === m.summary);
    return found.length === 1 ? found[0] : undefined;
  }
}
function errorText(e: unknown) { return e instanceof Error ? e.message : String(e); }
class UnsavedSessionError extends Error {}
function notifyThreadFailure(ctx: ExtensionContext, error: unknown, prefix: string, level: "error" | "warning" = "error") {
  if (error instanceof UnsavedSessionError) ctx.ui.notify("Threads: Heyah! Start talking to the agent first, then activate this.", "warning");
  else ctx.ui.notify(`${prefix}: ${errorText(error)}`, level);
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  let context: ExtensionContext | undefined;
  let ui: any;
  let groupFile: string | undefined;
  let targetMode = false;
  let holdMode = false;
  let held = false;
  let suppressHold = false;
  let generation = 0;
  let keyboardEnabled = false;
  let keyboardTimer: ReturnType<typeof setInterval> | undefined;
  let focusGeneration = 0;
  let selectedSession: string | undefined;
  const shared = globalThis as any;
  const muxKey = Symbol.for("pi.chatthreads.terminalMux");
  let mux: TerminalMux | undefined = shared[muxKey];
  let bridge: ReturnType<typeof connectThread> | undefined;
  const childSocket = process.env.PI_CHATTHREADS_SOCKET;
  const childToken = process.env.PI_CHATTHREADS_TOKEN;
  let pending: Target | undefined;
  let creating = false;
  let closing: string | undefined;
  let targets = new Map<string, Target>();
  let patched: { chat: any; original: Function; replacement: Function } | undefined;
  let footerPatch: { container: any; original: Function; replacement: Function } | undefined;
  let footerSlots = "";
  let unsubscribeInput: (() => void) | undefined;

  function refreshFooterSlots() {
    const group = groupFile && readGroup(groupFile);
    const list = (group?.threads || []).slice().sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
    const next = list.length
      ? list.map(t => t.session === selectedSession ? `[${t.slot}]` : t.slot).join(" ")
      : childSocket ? "" : "[1]";
    if (next !== footerSlots) { footerSlots = next; ui?.requestRender(); }
  }
  function patchNativeFooter(ctx: ExtensionContext) {
    const container = ui?.children?.[6];
    if (!container || !Array.isArray(container.children) || typeof container.render !== "function") return;
    const original = container.render;
    const replacement = function (width: number): string[] {
      const lines = original.call(container, width) as string[];
      const footer = container.children[0];
      // Leave other extensions' custom footers untouched. The built-in footer
      // supplies the native token/context formatting and right-aligned model.
      if (!footerSlots || typeof footer?.getSessionStats !== "function" || typeof footer?.footerData?.getExtensionStatuses !== "function" || lines.length < 2) return lines;
      const label = ` ${footerSlots}`;
      const labelWidth = visibleWidth(label);
      const available = width - labelWidth;
      if (available < 1) return lines;
      const compact = footer.render(available) as string[];
      if (typeof compact[1] !== "string") return lines;
      const plain = stripTerminalSequences(compact[1]);
      const gap = / {2,}/.exec(plain);
      const split = gap ? visibleWidth(plain.slice(0, gap.index)) : visibleWidth(plain);
      const before = sliceByColumn(compact[1], 0, split, true);
      const after = sliceByColumn(compact[1], split, Math.max(0, available - split), true);
      const output = lines.slice();
      output[1] = before + ctx.ui.theme.fg("accent", label) + after;
      return output;
    };
    container.render = replacement;
    footerPatch = { container, original, replacement };
    ui?.requestRender();
  }
  function restoreFooter() {
    if (footerPatch && footerPatch.container.render === footerPatch.replacement) footerPatch.container.render = footerPatch.original;
    footerPatch = undefined;
    footerSlots = "";
  }
  function refreshMode() {
    const ctx = context;
    if (!ctx || ctx.mode !== "tui") return;
    refreshFooterSlots();
    if (targetMode) {
      ctx.ui.setWidget("chatthreads-mode", (_tui, theme) => ({
        render(width) {
          const group = groupFile && readGroup(groupFile);
          if (group) prune(group);
          const list = (group?.threads || []).sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
          const threads = list.map(t => t.session === selectedSession ? `[${t.slot}]` : t.slot).join(" ");
          return [
            truncateToWidth(theme.fg("accent", `↳ ${config.prefix}+number: select or switch · ${config.mainThread}: main · ctrl+esc to close this thread · ${config.newThread}: fork latest`), width),
            truncateToWidth(theme.fg("dim", `  Threads: ${threads}`), width),
          ];
        },
        invalidate() {},
      }));
    } else {
      const text = pending ? `↳ Replying to ${pending.slot} · ${pending.title} · Enter to open thread · Esc cancel` : undefined;
      ctx.ui.setWidget("chatthreads-mode", text ? [ctx.ui.theme.fg("accent", text)] : undefined);
    }
    ui?.requestRender();
  }
  function restorePatch() {
    if (patched && patched.chat.render === patched.replacement) patched.chat.render = patched.original;
    patched = undefined;
    targets.clear();
  }
  function patchTranscript(ctx: ExtensionContext) {
    restorePatch();
    if (!ui || ui.mode !== "fullscreen") throw new Error("Visible-message targets require Pi fullscreen mode");
    const document = ui.children?.[0];
    const chat = document?.children?.[2];
    if (!chat || !Array.isArray(chat.children) || typeof chat.render !== "function" || typeof ui.getPrimaryScrollView !== "function") {
      throw new Error("This Pi version does not expose the expected transcript layout");
    }
    const original = chat.render;
    const replacement = function (width: number): string[] {
      if (!targetMode) return original.call(chat, width);
      if (width < 12) { targets.clear(); return original.call(chat, width); }
      const gutter = 5;
      const inner = width - gutter;
      const parts = chat.children.map((child: any) => ({ child, lines: child.render(inner) as string[] }));
      const top = document.children.slice(0, 2).reduce((n: number, c: any) => n + c.render(width).length, 0);
      const trailing = document.children.slice(3).reduce((n: number, c: any) => n + c.render(width).length, 0);
      const height = parts.reduce((n: number, p: any) => n + p.lines.length, 0);
      const view = ui.getPrimaryScrollView();
      const viewportHeight = view.viewportHeight || ui.terminal.rows;
      const scroll = view.isFollowingEnd ? Math.max(0, top + height + trailing - viewportHeight) : view.scrollTop;
      const bottom = scroll + viewportHeight;
      const session = ctx.sessionManager.getSessionFile();
      const group = groupFile && readGroup(groupFile);
      if (group) prune(group);
      const live = group?.threads || [];
      const free = [...childSlots].filter(s => !live.some(t => t.slot === s));
      const branch = ctx.sessionManager.getBranch() as Entry[];
      const selected = new Map<string, Target>();
      const result: string[] = [];
      let position = top;
      for (const part of parts) {
        let label: string | undefined;
        let labelLine = Math.max(0, scroll - position);
        const visibleEnd = Math.min(part.lines.length, bottom - position);
        while (labelLine < visibleEnd && !stripTerminalSequences(part.lines[labelLine] || "").trim()) labelLine++;
        const entry = labelLine < visibleEnd ? componentEntry(part.child, branch) : undefined;
        const index = entry && !(entry.type === "message" && entry.message.role === "user") ? branch.findIndex(e => e.id === entry.id) : -1;
        const boundary = index >= 0 ? safeBoundary(branch, index) : undefined;
        if (entry && boundary) {
          const pinned = live.find(t => t.parent === session && t.entry === entry.id);
          const slot = pinned?.slot || free.shift();
          if (slot) {
            const target = { entry: entry.id, boundary, title: titleFor(entry), slot };
            selected.set(slot, target);
            label = slot;
          }
        }
        for (let i = 0; i < part.lines.length; i++) {
          const prefix = label && i === labelLine ? ctx.ui.theme.fg("accent", ` ${label} › `) : " ".repeat(gutter);
          // Kitty/iTerm image escape sequences must stay at the beginning of their line.
          const line = part.lines[i];
          result.push(line.includes("\x1b_G") || line.includes("\x1b]1337;File=") ? line : prefix + line);
        }
        position += part.lines.length;
      }
      targets = selected;
      return result;
    };
    chat.render = replacement;
    patched = { chat, original, replacement };
  }
  async function registerMe(ctx: ExtensionContext, create: boolean) {
    const session = ctx.sessionManager.getSessionFile();
    if (!session || !existsSync(session)) throw new UnsavedSessionError("A saved Pi session is required");
    const found = findGroup(session);
    const path = found?.path || groupPath(session);
    await locked(path, existing => {
      const group: Group = existing || { version: 1, root: session, threads: [{ slot: "1", session, title: "Main" }] };
      let me = group.threads.find(t => t.session === session);
      if (!me && create && group.root === session) { me = { slot: "1", session, title: "Main" }; group.threads.unshift(me); }
      if (!me) throw new Error("This thread is no longer registered");
      if (me.pid && me.pid !== process.pid && pidAlive(me.pid)) throw new Error("This session is already open in another thread process");
      me.pid = process.pid; delete me.tty; delete me.terminalId; delete me.reservedAt;
      writeGroup(path, group);
    });
    groupFile = path;
  }
  function getMux(ctx: ExtensionContext) {
    const onSwitch = async (slot: string) => {
      if (slot.startsWith("close:")) {
        const child = mux?.active;
        if (!child || slot !== `close:${child.token}`) throw new Error("This thread is no longer active");
        // Reply to the child before stopping it; the session is rechecked when closing.
        setImmediate(() => { void closeThread(ctx, child.session); });
        return;
      }
      await switchSlot(ctx, slot);
    };
    const onExit = (session: string, pid: number, active: boolean) => {
      const path = groupFile;
      if (path) void locked(path, group => {
        const entry = group?.threads.find(t => t.session === session && t.pid === pid);
        if (entry && group) { delete entry.pid; delete entry.reservedAt; writeGroup(path, group); }
      }).catch(() => {});
      if (active) { selectedSession = ctx.sessionManager.getSessionFile(); refreshMode(); }
    };
    const getAppearance = () => ctx.ui.theme.appearance;
    if (!mux) shared[muxKey] = mux = new TerminalMux({ ui, onSwitch, onExit, getAppearance });
    else mux.bind(ui, onSwitch, onExit, getAppearance);
    return mux;
  }
  async function ensureTerminal(ctx: ExtensionContext, thread: Thread) {
    const manager = getMux(ctx);
    const existing = manager.children.get(thread.session);
    if (existing) return existing;
    const path = groupFile!;
    await locked(path, group => {
      const entry = group?.threads.find(t => t.session === thread.session);
      if (!group || !entry) throw new Error("Thread is no longer registered");
      if (entry.pid && pidAlive(entry.pid)) throw new Error("This session is open in another Pi process; close it first");
      if (entry.reservedAt && Date.now() - entry.reservedAt < 120000) throw new Error("Thread is already starting");
      entry.reservedAt = Date.now(); writeGroup(path, group);
    });
    const env = { ...process.env, PI_CODING_AGENT_DIR: getAgentDir(), PI_CHATTHREADS_GROUP: path };
    delete env.PI_SESSION_FILE; delete env.PI_SESSION_ID; delete env.PI_CHATTHREADS_KICKOFF;
    if (thread.kickoff) env.PI_CHATTHREADS_KICKOFF = thread.kickoff;
    // Let Pi restore the model and thinking level recorded in this fork,
    // rather than overriding an independent thread with the host's settings.
    const args = [...parentFlags(), "--tui-mode", "fullscreen", "-e", extensionPath, "--session", thread.session];
    try {
      const child = await manager.start({ session: thread.session, executable: process.env.PI_CHATTHREADS_PI || "pi", args, cwd: ctx.cwd, env });
      await locked(path, group => {
        const entry = group?.threads.find(t => t.session === thread.session);
        if (!entry || !group) throw new Error("Thread is no longer registered");
        entry.pid = child.pty.pid; entry.kind = "tui"; delete entry.reservedAt; writeGroup(path, group);
      });
      return child;
    } catch (error) {
      manager.stop(thread.session);
      await locked(path, group => {
        const entry = group?.threads.find(t => t.session === thread.session);
        if (entry && group) { delete entry.reservedAt; if (!pidAlive(entry.pid)) delete entry.pid; writeGroup(path, group); }
      });
      throw error;
    }
  }
  async function switchSlot(ctx: ExtensionContext, slot: string) {
    if (bridge) { await bridge.switch(slot); return; }
    const request = ++focusGeneration;
    if (!groupFile) await registerMe(ctx, true);
    const thread = readGroup(groupFile!)?.threads.find(t => t.slot === slot);
    if (!thread || !existsSync(thread.session)) throw new Error(`Thread ${slot} is unavailable`);
    held = false; suppressHold = false; hideTargets();
    if (thread.session === ctx.sessionManager.getSessionFile()) {
      selectedSession = thread.session; mux?.showMain(); refreshMode(); return;
    }
    const child = await ensureTerminal(ctx, thread);
    if (request !== focusGeneration) return;
    selectedSession = thread.session;
    try { await getMux(ctx).show(child); }
    catch (e) {
      if (request !== focusGeneration) return;
      getMux(ctx).showMain(); selectedSession = ctx.sessionManager.getSessionFile(); refreshMode(); throw e;
    }
  }
  async function focusSlot(ctx: ExtensionContext, slot: string) {
    try { await switchSlot(ctx, slot); }
    catch (e) { notifyThreadFailure(ctx, e, `Could not open thread ${slot}`); }
  }
  async function cycle(ctx: ExtensionContext, direction: number) {
    const group = groupFile && readGroup(groupFile);
    const list = (group?.threads || []).slice().sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
    const i = list.findIndex(t => t.session === selectedSession);
    if (i >= 0 && list.length > 1) await focusSlot(ctx, list[(i + direction + list.length) % list.length].slot);
  }
  async function listThreads(ctx: ExtensionContext) {
    try {
      if (!groupFile) await registerMe(ctx, true);
      const group = groupFile && readGroup(groupFile);
      const list = (group?.threads || []).slice().sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
      const options = list.map(t => `${t.slot}  ${t.title}${t.session === selectedSession ? "  (current)" : ""}`);
      const selected = await ctx.ui.select("Chat threads", options);
      if (selected) await focusSlot(ctx, list[options.indexOf(selected)].slot);
    } catch (e) { notifyThreadFailure(ctx, e, "Chat threads"); }
  }
  async function closeThread(ctx: ExtensionContext, session: string) {
    const manager = mux;
    const path = groupFile;
    const child = manager?.children.get(session);
    if (closing || !manager || !path || !child || manager.active !== child) return;
    closing = session;
    const request = ++focusGeneration;
    let closed = false;
    try {
      await locked(path, group => {
        const entry = group?.threads.find(t => t.session === session);
        if (!group || !entry || group.root === session || (entry.pid && entry.pid !== child.pty.pid)) {
          throw new Error("The current thread is no longer available");
        }
      });
      if (request !== focusGeneration || manager.active !== child) return;
      manager.stop(session);
      const deadline = Date.now() + 10000;
      while (manager.children.get(session) === child && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (manager.children.get(session) === child) throw new Error("The thread did not stop");
      const next = await locked(path, group => {
        const entry = group?.threads.find(t => t.session === session);
        if (!group || !entry) throw new Error("The thread was already removed");
        if (manager.children.has(session) || entry.reservedAt || pidAlive(entry.pid)) throw new Error("The thread was reopened while closing");
        group.threads = group.threads.filter(t => t !== entry);
        writeGroup(path, group);
        // Forks are appended to the registry when created, regardless of slot number.
        return [...group.threads].reverse().find(t => t.session !== group.root && existsSync(t.session))?.slot
          ?? group.threads.find(t => t.session === group.root)?.slot;
      });
      closed = true;
      if (request === focusGeneration && next) {
        closing = undefined;
        await switchSlot(ctx, next);
      }
    } catch (e) {
      if (manager.active === child) {
        manager.showMain(); selectedSession = ctx.sessionManager.getSessionFile(); refreshMode();
      }
      ctx.ui.notify(`${closed ? "Thread closed, but could not switch" : "Could not close thread"}: ${errorText(e)}`, "error");
    } finally { if (closing === session) closing = undefined; }
  }
  function hideTargets() {
    generation++;
    targetMode = false; holdMode = false; restorePatch(); refreshMode();
  }
  async function showTargets(ctx: ExtensionContext, hold: boolean) {
    if (pending || creating) return;
    const request = ++generation;
    try {
      if (!groupFile) await registerMe(ctx, true);
      if (request !== generation || (hold && !held)) return;
      patchTranscript(ctx);
      holdMode = hold; targetMode = true;
      refreshMode();
    } catch (e) {
      if (request === generation) { restorePatch(); notifyThreadFailure(ctx, e, "Chat threads"); }
    }
  }
  async function toggleTargets(ctx: ExtensionContext) {
    if (targetMode) hideTargets();
    else await showTargets(ctx, false);
  }
  async function enableTargets(ctx: ExtensionContext) {
    if (targetMode) { holdMode = false; return; }
    if (pending || creating) { ctx.ui.notify("Finish your reply or run /threads off first", "info"); return; }
    await showTargets(ctx, false);
  }
  async function choose(ctx: ExtensionContext, slot: string) {
    if (!targetMode) return focusSlot(ctx, slot);
    const target = targets.get(slot);
    const group = groupFile && readGroup(groupFile);
    const existing = group?.threads.find(t => t.slot === slot);
    if (existing) {
      suppressHold = held; hideTargets();
      return focusSlot(ctx, slot);
    }
    if (!target) { ctx.ui.notify(`No visible message assigned to ${slot}`, "warning"); return; }
    suppressHold = held; hideTargets();
    pending = target;
    refreshMode();
  }
  async function createThread(ctx: ExtensionContext, target?: Target, message?: Reply) {
    const session = ctx.sessionManager.getSessionFile();
    if (!session || !groupFile) throw new Error("Thread parent is no longer available");
    const path = groupFile;
    let selected = target;
    let child = "";
    try {
      await locked(path, group => {
        if (!group) throw new Error("Thread registry disappeared");
        const activeBranch = ctx.sessionManager.getBranch() as Entry[];
        if (target) {
          const existing = group.threads.find(t => t.parent === session && t.entry === target.entry);
          if (existing) throw new Error(`A thread for this message already exists in slot ${existing.slot}`);
          if (group.threads.some(t => t.slot === target.slot)) throw new Error(`Slot ${target.slot} was taken; select the message again`);
          const index = activeBranch.findIndex(e => e.id === target.entry);
          const boundary = index < 0 ? undefined : safeBoundary(activeBranch, index);
          if (!boundary || boundary !== target.boundary) throw new Error("The selected message is no longer on this branch; select it again");
        } else {
          const slot = [...childSlots].find(s => !group.threads.some(t => t.slot === s));
          if (!slot) throw new Error("All thread slots are in use");
          const entry = [...activeBranch].reverse().find(e =>
            (e.type === "message" && e.message.role !== "system") || (e.type === "custom_message" && e.display) || e.type === "compaction" || e.type === "branch_summary");
          if (!entry) throw new Error("There is no message to fork yet");
          // Include trailing branch metadata, but never fork with outstanding tool calls.
          const boundary = safeBoundary(activeBranch, activeBranch.length - 1);
          if (!boundary) throw new Error("Wait for the current tool calls to finish before forking");
          selected = { entry: entry.id, boundary, title: titleFor(entry), slot };
        }
        const fork = selected!;
        child = SessionManager.open(session).createBranchedSession(fork.boundary) || "";
        if (!child || !existsSync(child)) throw new Error("Could not save the forked session");
        let kickoff: string | undefined;
        if (message !== undefined) {
          kickoff = join(directory, `kickoff-${randomUUID()}.json`);
          writeFileSync(kickoff, JSON.stringify({ session: child, message }), { mode: 0o600, flag: "wx" });
        }
        group.threads.push({ slot: fork.slot, session: child, parent: session, entry: fork.entry, title: fork.title.slice(0, 35), ...(kickoff ? { kickoff } : {}) });
        writeGroup(path, group);
      });
      await switchSlot(ctx, selected!.slot);
    } catch (e) {
      throw new Error(`${errorText(e)}${child ? `; fork${message !== undefined ? " and reply" : ""} saved at ${child}` : ""}`);
    }
  }
  async function forkLatest(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    if (pending || creating) { ctx.ui.notify("Finish your reply or run /threads off first", "info"); return; }
    suppressHold = held; hideTargets();
    creating = true;
    try {
      if (!groupFile) await registerMe(ctx, true);
      await createThread(ctx);
    } catch (e) { notifyThreadFailure(ctx, e, "Could not open thread"); }
    finally { creating = false; }
  }
  async function settings(ctx: ExtensionContext) {
    const choices = ["Target shortcut", "Thread modifier prefix", "Previous thread shortcut", "Next thread shortcut", "New thread shortcut", "Main thread shortcut", "Restore defaults"];
    const picked = await ctx.ui.select("Thread keybindings", choices);
    if (!picked) return;
    let nextConfig: Config;
    if (picked === choices[6]) nextConfig = { ...defaults };
    else {
      const key = (["targets", "prefix", "previous", "next", "newThread", "mainThread"] as const)[choices.indexOf(picked)];
      const value = await ctx.ui.input(`${picked} (current: ${config[key]})`, config[key]);
      if (value === undefined) return;
      const v = value.trim().toLowerCase();
      if (key === "prefix" ? !/^(?:(?:ctrl|alt|shift|super)\+)*(?:ctrl|alt|shift|super)$/.test(v) : !/^(?:(?:ctrl|alt|shift|super)\+)+(?:[a-z0-9;]|left|right|up|down|f(?:[1-9]|1[0-2]))$/.test(v)) {
        ctx.ui.notify("Invalid shortcut", "error"); return;
      }
      nextConfig = { ...config, [key]: v };
    }
    if (!uniqueShortcuts(nextConfig)) { ctx.ui.notify("Those thread shortcuts overlap; choose distinct keys", "error"); return; }
    ensureDir();
    writeFileSync(configPath, JSON.stringify(nextConfig, null, 2) + "\n", { mode: 0o600 });
    ctx.ui.notify("Shortcuts saved. Run /reload to apply them.", "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    context = ctx;
    selectedSession = ctx.sessionManager.getSessionFile();
    ctx.ui.setWidget("chatthreads-hook", (tui) => {
      ui = tui;
      refreshFooterSlots();
      patchNativeFooter(ctx);
      return { render: () => [], invalidate() {} };
    });
    const enableKeyboard = () => {
      if (!ui?.terminal?.kittyProtocolActive) { keyboardEnabled = false; return; }
      if (!keyboardEnabled) { ui.terminal.write("\x1b[=24;2u"); keyboardEnabled = true; }
    };
    const tick = () => { enableKeyboard(); refreshFooterSlots(); };
    tick();
    keyboardTimer = setInterval(tick, 250);
    keyboardTimer.unref();
    const mask = config.prefix.split("+").reduce((n, part) => n | ({ shift: 1, alt: 2, ctrl: 4, super: 8 } as Record<string, number>)[part], 0);
    unsubscribeInput = ctx.ui.onTerminalInput(raw => {
      const key = parseKeyboardEvent(raw);
      const data = key?.normalized || raw;
      if (key) {
        const active = (key.modifiers & mask) === mask;
        // A modified key is not proof that the terminal can report modifier
        // releases. Only start the transient preview on a modifier-only event.
        if ((key.modifierKey || held) && active !== held) {
          held = active;
          if (!held) { suppressHold = false; if (holdMode) hideTargets(); else generation++; }
          else if (!suppressHold && !targetMode) void showTargets(ctx, true);
        }
        if (key.modifierKey) return { consume: true };
      }
      if (isKeyRelease(data)) return data !== raw ? { data } : undefined;
      if (isCloseShortcut(raw)) {
        if (bridge && childToken) {
          void bridge.switch(`close:${childToken}`).catch(e => ctx.ui.notify(`Could not close thread: ${errorText(e)}`, "error"));
        } else ctx.ui.notify(childSocket ? "The thread manager is not connected yet" : "The main thread cannot be closed with Ctrl+Esc", "info");
        return { consume: true };
      }
      if (matchesKey(data, "escape") && (targetMode || pending)) {
        if (creating) { ctx.ui.notify("The new thread is starting", "warning"); return { consume: true }; }
        targetMode = false; pending = undefined; restorePatch(); refreshMode();
        return { consume: true };
      }
      if (pending && matchesKey(data, "enter") && ctx.ui.getEditorText().startsWith("/") && !/^\/threads(?:\s|$)/.test(ctx.ui.getEditorText())) {
        if (creating) return { consume: true };
        const text = ctx.ui.getEditorText();
        const target = pending;
        creating = true;
        void createThread(ctx, target, text).then(() => {
          if (ctx.ui.getEditorText() === text) ctx.ui.setEditorText("");
          pending = undefined; refreshMode();
        }, e => ctx.ui.notify(`Could not open thread: ${errorText(e)}`, "error")).finally(() => { creating = false; });
        return { consume: true };
      }
      for (const slot of slots) {
        if (matchesKey(data, `${config.prefix}+${slot}` as any)) {
          void choose(ctx, slot);
          return { consume: true };
        }
      }
      if (matchesKey(data, config.previous as any)) { void cycle(ctx, -1); return { consume: true }; }
      if (matchesKey(data, config.next as any)) { void cycle(ctx, 1); return { consume: true }; }
      if (matchesKey(data, config.mainThread as any)) { void choose(ctx, "1"); return { consume: true }; }
      // Ctrl+N also filters Pi's session picker. Handle this shortcut only
      // in the editor instead of registering a conflicting global shortcut.
      if (matchesKey(data, config.newThread as any)) {
        const focused = ui?.getFocusedComponent();
        const inEditor = focused && focused === ui?.children?.[4]?.children?.[0]
          && typeof focused.getText === "function" && typeof focused.setText === "function";
        if (inEditor) {
          if (!key || key.event === 1) void forkLatest(ctx);
          return { consume: true };
        }
      }
      if (key && (key.text !== undefined || data !== raw)) return { data: key.text ?? data };
    });
    const session = ctx.sessionManager.getSessionFile();
    if (session && findGroup(session)) {
      try { await registerMe(ctx, false); } catch (e) { notifyThreadFailure(ctx, e, "Chat threads", "warning"); }
    }
    if (session && childSocket && childToken) {
      bridge = connectThread({ path: childSocket, token: childToken, session, onActivate: (appearance: string) => {
        held = false; suppressHold = false; hideTargets();
        // A background PTY cannot receive terminal palette replies. Re-query
        // on activation so Pi's native system theme matches the host terminal.
        ui?.handleTerminalInput?.(`\x1b[?997;${appearance === "light" ? "2" : "1"}n`);
        ui?.requestRender(true);
      } });
    } else if (mux) getMux(ctx);
    const kickoff = process.env.PI_CHATTHREADS_KICKOFF;
    if (session && kickoff && kickoff.startsWith(`${directory}/kickoff-`) && kickoff.endsWith(".json")) {
      delete process.env.PI_CHATTHREADS_KICKOFF;
      try {
        const payload = JSON.parse(readFileSync(kickoff, "utf8"));
        const valid = typeof payload.message === "string" || (Array.isArray(payload.message) && payload.message.every((part: any) =>
          (part?.type === "text" && typeof part.text === "string") || (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string")));
        if (payload.session !== session || !valid) throw new Error("Invalid thread reply");
        unlinkSync(kickoff);
        if (groupFile) await locked(groupFile, group => {
          const thread = group?.threads.find(t => t.session === session && t.kickoff === kickoff);
          if (thread && group) { delete thread.kickoff; writeGroup(groupFile!, group); }
        });
        setTimeout(() => pi.sendUserMessage(payload.message, { expandPromptTemplates: true }), 100);
      } catch (e) { ctx.ui.notify(`Could not send thread reply: ${errorText(e)}`, "error"); }
    }
  });
  pi.on("session_shutdown", async (event, ctx) => {
    targetMode = false; pending = undefined; generation++; focusGeneration++; restorePatch(); restoreFooter(); unsubscribeInput?.();
    bridge?.close(); bridge = undefined;
    if (keyboardTimer) clearInterval(keyboardTimer);
    if (keyboardEnabled && ui?.terminal?.kittyProtocolActive) ui.terminal.write("\x1b[=24;3u");
    const session = ctx.sessionManager.getSessionFile();
    const path = groupFile;
    if (event.reason !== "reload") {
      if (!childSocket && mux) { mux.dispose(); delete shared[muxKey]; mux = undefined; }
      if (session && path) try {
        await locked(path, group => {
          const me = group?.threads.find(t => t.session === session && t.pid === process.pid);
          if (me && group) { delete me.pid; delete me.tty; writeGroup(path, group); }
        });
      } catch { /* never block shutdown */ }
    } else if (!childSocket) mux?.detachInput();
    groupFile = undefined; context = undefined; ui = undefined;
  });
  pi.on("input", async (event, ctx) => {
    if (!pending || event.source !== "interactive") return;
    if (creating) return { action: "handled" };
    const target = pending;
    const reply: Reply = event.images?.length ? [{ type: "text", text: event.text }, ...event.images] : event.text;
    creating = true;
    try {
      await createThread(ctx, target, reply);
      pending = undefined; refreshMode();
    } catch (e) {
      ctx.ui.setEditorText(event.text);
      ctx.ui.notify(`Could not open thread: ${errorText(e)}${event.images?.length ? " (please reattach images)" : ""}`, "error");
    } finally { creating = false; }
    return { action: "handled" };
  });
  pi.registerCommand("threads", {
    description: "Manage threads: on, off, show, keybinding",
    getArgumentCompletions: (prefix) => {
      const group = groupFile && readGroup(groupFile);
      const options = [
        { value: "on", label: "on", description: "Show message numbers" },
        { value: "off", label: "off", description: "Hide numbers and cancel a pending reply" },
        { value: "show", label: "show", description: "Choose an existing thread" },
        { value: "keybinding", label: "keybinding", description: "Configure shortcuts" },
        ...(group?.threads || []).map(t => ({ value: t.slot, label: t.slot, description: `Switch to ${t.title}` })),
      ];
      const matches = options.filter(option => option.value.startsWith(prefix));
      // Once a complete command is typed, Enter should run it instead of accepting it again.
      if (matches.some(option => option.value === prefix)) return null;
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const command = args.trim();
      if (command === "keybinding") await settings(ctx);
      else if (command === "show") await listThreads(ctx);
      else if (command === "on") await enableTargets(ctx);
      else if (command === "off") {
        if (creating) ctx.ui.notify("The new thread is starting", "warning");
        else { pending = undefined; hideTargets(); }
      } else if (/^[0-9]$/.test(command)) await focusSlot(ctx, command);
      else ctx.ui.notify("Use /threads on, off, show, keybinding, or <number>", command ? "warning" : "info");
    },
  });
  pi.registerShortcut(config.targets as any, { description: "Show visible chat thread targets", handler: toggleTargets });
  for (const slot of slots) pi.registerShortcut(`${config.prefix}+${slot}` as any, { description: `Open chat thread ${slot}`, handler: ctx => choose(ctx, slot) });
  pi.registerShortcut(config.previous as any, { description: "Previous chat thread", handler: ctx => cycle(ctx, -1) });
  pi.registerShortcut(config.next as any, { description: "Next chat thread", handler: ctx => cycle(ctx, 1) });
  pi.registerShortcut(config.mainThread as any, { description: "Return to the main chat thread", handler: ctx => choose(ctx, "1") });
}
