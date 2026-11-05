import { copyToClipboard, getAgentDir, SessionManager, TreeSelectorComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { loadTerminalMux } from "./terminal-mux-loader.mjs";
import { isCloseShortcut, parseKeyboardEvent } from "./keyboard.ts";
import { heartbeatBrightness, renderThreadIndicators, type ThreadIndicator } from "./thread-activity.ts";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const slots = "1234567890";
const tapDurationMs = 300;
const directory = join(getAgentDir(), "pi-threads");
// Keep old registries in place so live threads continue sharing the same locks.
const legacyDirectory = join(getAgentDir(), "chatthreads");
const directories = [directory, legacyDirectory];
const configPath = join(directory, "config.json");
const extensionPath = fileURLToPath(import.meta.url);
const legacyExtensionPath = fileURLToPath(new URL("./chatthreads.ts", import.meta.url));
const defaults = { targets: "ctrl+;", prefix: "ctrl", previous: "ctrl+shift+left", next: "ctrl+shift+right", newThread: "ctrl+n", mainThread: "ctrl+shift+1" };
type Config = typeof defaults;
type Thread = { slot: string; session: string; title: string; pid?: number; tty?: string; terminalId?: string; parent?: string; entry?: string; reservedAt?: number; kind?: "rpc" | "tui"; kickoff?: string; working?: boolean; unread?: boolean; closed?: boolean; initialModel?: { provider: string; id: string; thinking: string } };
type Group = { version: 1; root: string; threads: Thread[]; viewing?: string };
type Target = { entry: string; boundary: string; title: string; slot: string };
type TreePreview = (width: number, theme: ExtensionContext["ui"]["theme"]) => string[];
type PendingTarget = Target & { preview: TreePreview };
type Reply = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
type Entry = any;

function loadConfig(): Config {
  try {
    const saved = JSON.parse(readFileSync(existsSync(configPath) ? configPath : join(legacyDirectory, "config.json"), "utf8"));
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
function ensureDir(path = directory) { mkdirSync(path, { recursive: true, mode: 0o700 }); }
function groupPath(root: string, dir = directory) { return join(dir, `${createHash("sha256").update(root).digest("hex")}.json`); }
function readGroup(path: string): Group | undefined {
  try {
    const g = JSON.parse(readFileSync(path, "utf8"));
    if (g.version === 1 && typeof g.root === "string" && Array.isArray(g.threads)) return g;
  } catch { /* absent or malformed */ }
}
function visibleThreads(group?: Group): Thread[] { return (group?.threads || []).filter(thread => !thread.closed); }
function writeGroup(path: string, group: Group) {
  ensureDir(dirname(path));
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
    if (thread.pid && !pidAlive(thread.pid)) {
      if (thread.working && g.viewing !== thread.session) thread.unread = true;
      delete thread.pid; delete thread.tty; delete thread.terminalId; delete thread.working;
    }
    if (thread.reservedAt && Date.now() - thread.reservedAt >= 120000) delete thread.reservedAt;
  }
}
async function locked<T>(path: string, fn: (group: Group | undefined) => T): Promise<T> {
  ensureDir(dirname(path));
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
  const paths: string[] = [];
  for (const inherited of [process.env.PI_THREADS_GROUP, process.env.PI_CHATTHREADS_GROUP]) {
    if (inherited && /^[a-f0-9]{64}\.json$/.test(basename(inherited)) && directories.some(dir => inherited === join(dir, basename(inherited)))) paths.push(inherited);
  }
  for (const dir of directories) paths.push(groupPath(session, dir));
  for (const dir of directories) {
    try { for (const f of readdirSync(dir)) if (/^[a-f0-9]{64}\.json$/.test(f)) paths.push(join(dir, f)); } catch {}
  }
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
      // Do not load both entry points in a child launched from the legacy path.
      if (!((arg === "-e" || arg === "--extension") && [extensionPath, legacyExtensionPath].includes(resolve(value)))) result.push(arg, value);
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
// Tree selections can also be on an abandoned branch. Include all tool results
// before forking, but do not guess if an old branch has ambiguous continuations.
function boundaryFor(ctx: ExtensionContext, entryId: string): string | undefined {
  const active = ctx.sessionManager.getBranch() as Entry[];
  const activeIndex = active.findIndex(e => e.id === entryId);
  if (activeIndex >= 0) return safeBoundary(active, activeIndex);
  const path = ctx.sessionManager.getBranch(entryId) as Entry[];
  if (path.at(-1)?.id !== entryId) return;
  const index = path.length - 1;
  const immediate = safeBoundary(path, index);
  if (immediate) return immediate;
  const children = new Map<string, Entry[]>();
  for (const entry of ctx.sessionManager.getEntries() as Entry[]) {
    if (!entry.parentId) continue;
    const siblings = children.get(entry.parentId) || [];
    siblings.push(entry); children.set(entry.parentId, siblings);
  }
  const found = new Set<string>();
  const stack = (children.get(entryId) || []).map(entry => ({ entry, path }));
  while (stack.length && found.size < 2) {
    const item = stack.pop()!;
    if (item.path.some(e => e.id === item.entry.id)) continue;
    if (item.entry.type === "message" && (item.entry.message.role === "assistant" || item.entry.message.role === "user")) continue;
    const next = [...item.path, item.entry];
    const boundary = safeBoundary(next, index);
    if (boundary) found.add(boundary);
    else for (const entry of children.get(item.entry.id) || []) stack.push({ entry, path: next });
  }
  return found.size === 1 ? [...found][0] : undefined;
}
function errorText(e: unknown) { return e instanceof Error ? e.message : String(e); }
class UnsavedSessionError extends Error {}
function notifyThreadFailure(ctx: ExtensionContext, error: unknown, prefix: string, level: "error" | "warning" = "error") {
  if (error instanceof UnsavedSessionError) ctx.ui.notify("Threads need a saved session. Send a message first; --no-session cannot create threads.", "warning");
  else ctx.ui.notify(`${prefix}: ${errorText(error)}`, level);
}

export default async function (pi: ExtensionAPI) {
  // Native ESM imports otherwise keep the old mux implementation after /reload.
  const muxUrl = new URL("./terminal-mux.mjs", import.meta.url);
  muxUrl.searchParams.set("v", createHash("sha256").update(readFileSync(muxUrl)).update(readFileSync(new URL("./screen-transition.mjs", import.meta.url))).digest("hex"));
  const { TerminalMux, connectThread } = await loadTerminalMux(muxUrl.href);
  const config = loadConfig();
  const reserved = new Set([config.targets, config.previous, config.next, config.newThread, config.mainThread, ...[...slots].map(slot => `${config.prefix}+${slot}`)].map(shortcutSignature));
  const searchPrefix = ["alt", "ctrl+alt", "shift+alt", "ctrl+shift+alt", "super+alt", "ctrl+super+alt", "shift+super+alt", "ctrl+shift+super+alt"]
    .find(prefix => [...slots].every(slot => !reserved.has(shortcutSignature(`${prefix}+${slot}`))))!;
  const prefixMask = config.prefix.split("+").reduce((n, part) => n | ({ shift: 1, alt: 2, ctrl: 4, super: 8 } as Record<string, number>)[part], 0);
  let context: ExtensionContext | undefined;
  let ui: any;
  let groupFile: string | undefined;
  let targetMode = false;
  let prefixHeld = false;
  let inheritedPrefixHeld = false;
  let selectorHeld = false;
  let prefixTapStartedAt: number | undefined;
  let closePicker: (() => void) | undefined;
  let pickerTargets: (() => Map<string, Target>) | undefined;
  let pickerPreview: ((target: Target) => TreePreview | undefined) | undefined;
  let pickerCapturesInput: (() => boolean) | undefined;
  let generation = 0;
  let keyboardEnabled = false;
  let keyboardTimer: ReturnType<typeof setInterval> | undefined;
  let terminalFocused = true;
  let focusPatch: { tui: any; original: Function; replacement: Function } | undefined;
  let startupPaintPatch: { tui: any; original: Function; replacement: Function } | undefined;
  let focusGeneration = 0;
  let selectedSession: string | undefined;
  const shared = globalThis as any;
  const muxKey = Symbol.for("pi.threads.terminalMux");
  // Adopt the old mux on reload instead of restarting live child processes.
  const legacyMuxKey = Symbol.for("pi.chatthreads.terminalMux");
  let mux: InstanceType<typeof TerminalMux> | undefined = shared[muxKey] || shared[legacyMuxKey];
  if (mux) { shared[muxKey] = mux; delete shared[legacyMuxKey]; }
  let bridge: ReturnType<typeof connectThread> | undefined;
  const childSocket = process.env.PI_THREADS_SOCKET || process.env.PI_CHATTHREADS_SOCKET;
  const childToken = process.env.PI_THREADS_SOCKET ? process.env.PI_THREADS_TOKEN : process.env.PI_CHATTHREADS_TOKEN;
  let pending: PendingTarget | undefined;
  let creating = false;
  let closing: string | undefined;
  let recovering = false;
  let footerPatch: { container: any; original: Function; replacement: Function } | undefined;
  let footerSlots: ThreadIndicator[] = [];
  let footerSignature = "";
  let localWorking = false;
  let locallyVisible = false;
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  let viewQueue = Promise.resolve();
  let unsubscribeInput: (() => void) | undefined;

  function updateAnimation() {
    const animate = selectorHeld && locallyVisible && footerSlots.some(slot => slot.working);
    if (animate && !animationTimer) {
      let brightness = heartbeatBrightness(performance.now());
      animationTimer = setInterval(() => {
        const next = heartbeatBrightness(performance.now());
        if (next !== brightness) { brightness = next; ui?.requestRender(); }
      }, 60);
      animationTimer.unref();
    } else if (!animate && animationTimer) {
      clearInterval(animationTimer); animationTimer = undefined;
    }
  }
  function setSelectorHeld(held: boolean) {
    if (selectorHeld === held) return;
    selectorHeld = held;
    refreshFooterSlots();
    ui?.requestRender();
  }
  function setPrefixHeld(held: boolean) {
    prefixHeld = held;
    inheritedPrefixHeld = held;
    setSelectorHeld(held);
  }
  function refreshFooterSlots() {
    const group = groupFile && readGroup(groupFile);
    const list = visibleThreads(group).sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
    const next: ThreadIndicator[] = group
      ? list.map(t => ({ slot: t.slot, current: t.session === selectedSession, working: t.working === true && pidAlive(t.pid), unread: t.unread === true }))
      : childSocket ? [] : [{ slot: "1", current: true, working: localWorking, unread: false }];
    locallyVisible = group ? group.viewing === context?.sessionManager.getSessionFile() : !childSocket && terminalFocused && !mux?.active;
    const signature = JSON.stringify(next);
    if (signature !== footerSignature) { footerSlots = next; footerSignature = signature; ui?.requestRender(); }
    updateAnimation();
  }
  function updateViewing() {
    const path = groupFile;
    if (childSocket || !path) return;
    const viewing = terminalFocused ? selectedSession : undefined;
    viewQueue = viewQueue.then(async () => {
      if (groupFile !== path) return;
      await locked(path, group => {
        if (!group) return;
        const viewed = visibleThreads(group).find(thread => thread.session === viewing);
        if (group.viewing === viewed?.session && !viewed?.unread) return;
        if (viewed) { group.viewing = viewed.session; delete viewed.unread; }
        else delete group.viewing;
        writeGroup(path, group);
      });
      if (groupFile === path) refreshFooterSlots();
    }).catch(() => {});
  }
  async function updateActivity(ctx: ExtensionContext, working: boolean) {
    if (ctx.mode !== "tui") return;
    localWorking = working;
    refreshFooterSlots();
    const path = groupFile, session = ctx.sessionManager.getSessionFile();
    if (!path || !session) return;
    try {
      await locked(path, group => {
        const me = group?.threads.find(thread => thread.session === session && thread.pid === process.pid);
        if (!group || !me || me.closed) return;
        if (working) me.working = true;
        else {
          delete me.working;
          if (group.viewing === session) delete me.unread;
          else me.unread = true;
        }
        writeGroup(path, group);
      });
      if (groupFile === path) refreshFooterSlots();
    } catch { /* Activity indicators must not interrupt the agent. */ }
  }
  function patchFooter(ctx: ExtensionContext) {
    const container = ui?.children?.[6];
    if (!container || !Array.isArray(container.children) || typeof container.render !== "function") return;
    const original = container.render;
    const replacement = function (width: number): string[] {
      const lines = original.call(container, width) as string[];
      if (!selectorHeld || !footerSlots.length) return lines;
      const footer = container.children[0];
      // Preserve custom footer content without assuming its layout or whether
      // it displays extension statuses. Keep our thread strip on its own row.
      const indicators = renderThreadIndicators(footerSlots, ctx.ui.theme, performance.now());
      const separate = () => [...lines, ...wrapTextWithAnsi(indicators, Math.max(1, width))];
      if (typeof footer?.getSessionStats !== "function" || typeof footer?.footerData?.getExtensionStatuses !== "function" || lines.length < 2) return separate();
      const label = ` ${indicators}`;
      const labelWidth = visibleWidth(label);
      const available = width - labelWidth;
      if (available < 1) return separate();
      const compact = footer.render(available) as string[];
      if (typeof compact[1] !== "string") return separate();
      const plain = stripTerminalSequences(compact[1]);
      const gap = / {2,}/.exec(plain);
      const split = gap ? visibleWidth(plain.slice(0, gap.index)) : visibleWidth(plain);
      const before = sliceByColumn(compact[1], 0, split, true);
      const after = sliceByColumn(compact[1], split, Math.max(0, available - split), true);
      const output = lines.slice();
      output[1] = before + label + after;
      return output;
    };
    container.render = replacement;
    footerPatch = { container, original, replacement };
    ui?.requestRender();
  }
  function restoreFooter() {
    if (footerPatch && footerPatch.container.render === footerPatch.replacement) footerPatch.container.render = footerPatch.original;
    footerPatch = undefined;
    footerSlots = []; footerSignature = "";
    if (animationTimer) clearInterval(animationTimer);
    animationTimer = undefined;
  }
  function refreshMode() {
    const ctx = context;
    if (!ctx || ctx.mode !== "tui") return;
    refreshFooterSlots();
    if (pending) {
      const preview = pending.preview;
      ctx.ui.setWidget("threads-mode", (_tui, theme) => ({
        render: width => preview(width, theme),
        invalidate() {},
      }));
    } else ctx.ui.setWidget("threads-mode", undefined);
    ui?.requestRender();
  }
  function editorFocused() {
    const focused = ui?.getFocusedComponent();
    return !!focused && focused === ui?.children?.[4]?.children?.[0]
      && typeof focused.getText === "function" && typeof focused.setText === "function";
  }
  async function registerMe(ctx: ExtensionContext, create: boolean, allowUnsaved = false) {
    const session = ctx.sessionManager.getSessionFile();
    if (!session || (!allowUnsaved && !existsSync(session))) throw new UnsavedSessionError("A saved Pi session is required");
    const found = findGroup(session);
    const path = found?.path || groupPath(session);
    await locked(path, existing => {
      const group: Group = existing || { version: 1, root: session, threads: [{ slot: "1", session, title: "Main" }] };
      let me = group.threads.find(t => t.session === session);
      if (!me && create && group.root === session) { me = { slot: "1", session, title: "Main" }; group.threads.unshift(me); }
      if (!me) throw new Error("This thread is no longer registered");
      if (me.pid && me.pid !== process.pid && pidAlive(me.pid)) throw new Error("This session is already open in another thread process");
      if (me.closed && !childSocket && group.root === session && me.pid !== process.pid) {
        const slot = [...slots].find(value => !visibleThreads(group).some(thread => thread.slot === value));
        if (!slot) throw new Error("All thread slots are in use");
        me.slot = slot; delete me.closed;
      }
      me.pid = process.pid; delete me.tty; delete me.terminalId; delete me.reservedAt;
      if (localWorking) me.working = true; else delete me.working;
      if (!childSocket) {
        const viewed = terminalFocused && visibleThreads(group).find(thread => thread.session === selectedSession);
        if (viewed) { group.viewing = viewed.session; delete viewed.unread; }
        else delete group.viewing;
      }
      writeGroup(path, group);
    });
    groupFile = path;
    refreshFooterSlots();
  }
  function hostClosed(ctx: ExtensionContext) {
    const group = groupFile && readGroup(groupFile);
    return group?.threads.some(thread => thread.session === ctx.sessionManager.getSessionFile() && thread.closed) === true;
  }
  function getMux(ctx: ExtensionContext) {
    const onSwitch = async (slot: string) => {
      if (closing) throw new Error("A thread is closing; please wait");
      if (slot === "reopen-host") { await reopenHost(ctx); return; }
      if (slot.startsWith("close:")) {
        const child = mux?.active;
        if (!child || slot !== `close:${child.token}`) throw new Error("This thread is no longer active");
        // Reply to the child before stopping it; the session is rechecked when closing.
        setImmediate(() => { void closeThread(ctx, child.session); });
        return;
      }
      await switchSlot(ctx, slot);
    };
    const onExit = (session: string, pid: number, active: boolean, header?: Entry) => {
      // Pi defers writing a fresh session until the first message. Once its
      // process has exited, preserve an empty thread without interfering with
      // the live SessionManager's exclusive first write.
      if (header && !existsSync(session)) try {
        writeFileSync(session, `${JSON.stringify(header)}\n`, { mode: 0o600, flag: "wx" });
      } catch (e: any) {
        if (e?.code !== "EEXIST") ctx.ui.notify(`Could not preserve empty thread: ${errorText(e)}`, "warning");
      }
      const path = groupFile;
      if (path) void locked(path, group => {
        const entry = group?.threads.find(t => t.session === session && (!t.pid || t.pid === pid));
        if (entry && group) {
          if (entry.working && group.viewing !== session) entry.unread = true;
          delete entry.pid; delete entry.reservedAt; delete entry.working; writeGroup(path, group);
        }
      }).catch(() => {});
      if (active) {
        if (hostClosed(ctx)) {
          const exited = mux?.active;
          if (!closing) setImmediate(() => {
            if (mux?.active === exited && !closing) void focusRemaining(ctx, session);
          });
          return true;
        }
        selectedSession = ctx.sessionManager.getSessionFile(); updateViewing(); refreshMode();
      }
      return false;
    };
    const getAppearance = () => ctx.ui.theme.appearance;
    const isFocused = () => terminalFocused;
    const onChildInput = (data: string) => {
      const key = parseKeyboardEvent(data);
      if (!terminalFocused || !key?.modifierKey) return false;
      const held = (key.modifiers & prefixMask) === prefixMask;
      const changed = prefixHeld !== held;
      setPrefixHeld(held);
      prefixTapStartedAt = undefined;
      return changed;
    };
    const isPrefixHeld = () => terminalFocused && prefixHeld;
    const onRebind = async (previous: string, session: string, child: any, message: any, current: () => boolean) => {
      const path = groupFile;
      if (!path || !["new", "resume", "fork", "recover"].includes(message.reason)) throw new Error("Invalid thread session replacement");
      const other = findGroup(session);
      if (other && other.path !== path) throw new Error("That session belongs to another thread group");
      await locked(path, group => {
        if (!current()) throw new Error("Thread changed during session replacement");
        const thread = group?.threads.find(t => t.session === previous);
        if (!group || !thread || group.root === previous || (thread.pid && thread.pid !== child.pty.pid)) throw new Error("This thread is no longer registered");
        if (group.threads.some(t => t !== thread && t.session === session)) throw new Error("That session is already open in another thread");
        thread.session = session;
        thread.pid = child.pty.pid;
        thread.title = message.reason === "new" ? "New session" : message.reason === "fork" ? "Forked session" : "Session";
        if (group.viewing === previous) group.viewing = session;
        delete thread.working; delete thread.unread;
        delete thread.parent; delete thread.entry; delete thread.kickoff; delete thread.reservedAt; delete thread.initialModel;
        const model = message.initialModel;
        if (model && typeof model.provider === "string" && typeof model.id === "string" && typeof model.thinking === "string") thread.initialModel = model;
        writeGroup(path, group);
      });
      if (selectedSession === previous) { selectedSession = session; refreshMode(); }
    };
    if (!mux) shared[muxKey] = mux = new TerminalMux({ ui, onSwitch, onExit, onRebind, getAppearance, isFocused, onChildInput, isPrefixHeld });
    else {
      // Reload preserves live PTYs; upgrade their manager and input routing too.
      const upgrading = Object.getPrototypeOf(mux) !== TerminalMux.prototype;
      Object.setPrototypeOf(mux, TerminalMux.prototype);
      if (upgrading) mux.detachInput();
      mux.bind(ui, onSwitch, onExit, getAppearance, isFocused, onChildInput, isPrefixHeld, onRebind);
      if (upgrading && mux.active) mux.installInput();
    }
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
    const env = { ...process.env, PI_CODING_AGENT_DIR: getAgentDir(), PI_THREADS_GROUP: path, PI_CHATTHREADS_GROUP: path };
    delete env.PI_SESSION_FILE; delete env.PI_SESSION_ID; delete env.PI_THREADS_KICKOFF; delete env.PI_CHATTHREADS_KICKOFF;
    if (thread.kickoff) env.PI_THREADS_KICKOFF = env.PI_CHATTHREADS_KICKOFF = thread.kickoff;
    // Let Pi restore the model and thinking level recorded in this fork,
    // rather than overriding an independent thread with the host's settings.
    const args = [...parentFlags(), "--tui-mode", "fullscreen", "-e", extensionPath, "--session", thread.session];
    try {
      if (thread.initialModel) {
        const saved = SessionManager.open(thread.session);
        if (!saved.buildSessionContext().messages.length) {
          const entries = saved.getBranch();
          const model = entries.findLast(entry => entry.type === "model_change");
          const thinking = entries.findLast(entry => entry.type === "thinking_level_change");
          args.push("--provider", model?.provider ?? thread.initialModel.provider, "--model", model?.modelId ?? thread.initialModel.id,
            "--thinking", thinking?.thinkingLevel ?? thread.initialModel.thinking);
        }
      }
      const child = await manager.start({ session: thread.session, executable: process.env.PI_THREADS_PI || process.env.PI_CHATTHREADS_PI || "pi", args, cwd: ctx.cwd, env });
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
    mux?.screenTransition?.cancel();
    if (!groupFile) await registerMe(ctx, true);
    const thread = readGroup(groupFile!)?.threads.find(t => t.slot === slot);
    if (!thread || (thread.session !== ctx.sessionManager.getSessionFile() && !existsSync(thread.session) && !mux?.children.has(thread.session))) throw new Error(`Thread ${slot} is unavailable`);
    hideTargets();
    if (thread.session === ctx.sessionManager.getSessionFile()) {
      selectedSession = thread.session; mux?.showMain(); updateViewing(); refreshMode(); return;
    }
    const previous = mux?.active;
    const child = await ensureTerminal(ctx, thread);
    if (request !== focusGeneration) return;
    const manager = getMux(ctx);
    try {
      const shown = await manager.show(child);
      if (!shown || request !== focusGeneration || manager.active !== child || manager.children.get(child.session) !== child) return;
      selectedSession = thread.session; updateViewing(); refreshMode();
    } catch (e) {
      if (request !== focusGeneration) return;
      if (previous && manager.children.get(previous.session) === previous) {
        try {
          if (manager.active !== previous) await manager.show(previous);
          if (request !== focusGeneration) return;
          selectedSession = previous.session; updateViewing(); refreshMode();
        } catch {
          if (hostClosed(ctx)) { if (!closing && !recovering) void focusRemaining(ctx, thread.session); }
          else { manager.showMain(); selectedSession = ctx.sessionManager.getSessionFile(); updateViewing(); refreshMode(); }
        }
      } else if (hostClosed(ctx)) {
        if (!closing && !recovering) void focusRemaining(ctx, thread.session);
      } else {
        if (manager.active) manager.showMain();
        selectedSession = ctx.sessionManager.getSessionFile(); updateViewing(); refreshMode();
      }
      throw e;
    }
  }
  async function reopenHost(ctx: ExtensionContext) {
    const path = groupFile, session = ctx.sessionManager.getSessionFile();
    if (!path || !session) throw new Error("The thread manager is unavailable");
    const slot = await locked(path, group => {
      const host = group?.threads.find(thread => thread.session === session);
      if (!group || group.root !== session || !host) throw new Error("The original session is unavailable");
      if (!host.closed) return host.slot;
      const free = [...slots].find(value => !visibleThreads(group).some(thread => thread.slot === value));
      if (!free) throw new Error("All thread slots are in use");
      host.slot = free; delete host.closed;
      if (!ctx.isIdle()) host.working = true;
      writeGroup(path, group);
      return free;
    });
    await switchSlot(ctx, slot);
  }
  async function focusRemaining(ctx: ExtensionContext, excluded: string) {
    if (recovering || closing) return;
    recovering = true;
    try {
      const group = groupFile && readGroup(groupFile);
      const candidates = visibleThreads(group).filter(thread => thread.session !== excluded).reverse();
      if (!candidates.length) { ctx.abort(); ctx.shutdown(); return; }
      let failure: unknown;
      for (const thread of candidates) {
        try {
          await switchSlot(ctx, thread.slot);
          return;
        } catch (e) { failure = e; }
      }
      try { await reopenHost(ctx); }
      catch { mux?.showMain(); selectedSession = ctx.sessionManager.getSessionFile(); updateViewing(); refreshMode(); }
      ctx.ui.notify(`Could not switch to a remaining thread: ${errorText(failure)}`, "error");
    } finally { recovering = false; }
  }
  async function focusSlot(ctx: ExtensionContext, slot: string) {
    try { await switchSlot(ctx, slot); }
    catch (e) { notifyThreadFailure(ctx, e, `Could not open thread ${slot}`); }
  }
  async function cycle(ctx: ExtensionContext, direction: number) {
    const group = groupFile && readGroup(groupFile);
    const list = visibleThreads(group).sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
    const i = list.findIndex(t => t.session === selectedSession);
    if (i >= 0 && list.length > 1) await focusSlot(ctx, list[(i + direction + list.length) % list.length].slot);
  }
  async function listThreads(ctx: ExtensionContext) {
    try {
      if (!groupFile) await registerMe(ctx, true);
      const group = groupFile && readGroup(groupFile);
      const list = visibleThreads(group).sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
      const options = list.map(t => `${t.slot}  ${t.title}${t.session === selectedSession ? "  (current)" : ""}`);
      const selected = await ctx.ui.select("Pi Threads", options);
      if (selected) await focusSlot(ctx, list[options.indexOf(selected)].slot);
    } catch (e) { notifyThreadFailure(ctx, e, "Pi Threads"); }
  }
  function stopHostWork(ctx: ExtensionContext) {
    ctx.abort();
    // ctx.abort() stops the agent, but Pi's interactive shell has its own
    // Escape handler. Invoke it on the host editor, not the visible child PTY.
    const cancelShell = () => {
      const editor = ui?.children?.[4]?.children?.[0];
      if (typeof editor?.onEscape !== "function" || typeof editor.getText !== "function" || typeof editor.setText !== "function") return;
      const text = editor.getText();
      if (!text.trim()) editor.setText("\u200b");
      try { editor.onEscape(); }
      finally { if (editor.getText() !== text) editor.setText(text); }
    };
    if (ctx.isIdle()) cancelShell();
    else {
      const deadline = Date.now() + 10000;
      const timer = setInterval(() => {
        if (context !== ctx || Date.now() >= deadline || (!closing && !hostClosed(ctx))) { clearInterval(timer); return; }
        if (ctx.isIdle()) { clearInterval(timer); cancelShell(); }
      }, 50);
      timer.unref();
    }
  }
  async function closeHost(ctx: ExtensionContext) {
    if (closing) return;
    const session = ctx.sessionManager.getSessionFile();
    const path = groupFile;
    const group = path && readGroup(path);
    const others = visibleThreads(group).filter(thread => thread.session !== session);
    if (!others.length) { stopHostWork(ctx); ctx.shutdown(); return; }
    if (!path || !session) throw new Error("The current thread is unavailable");
    closing = session;
    try {
      const next = [...others].reverse().find(thread => existsSync(thread.session) || mux?.children.has(thread.session)) || others[others.length - 1];
      await switchSlot(ctx, next.slot);
      if (selectedSession !== next.session || mux?.active?.session !== next.session) return;
      await locked(path, current => {
        const host = current?.threads.find(thread => thread.session === session);
        if (!current || current.root !== session || !host || host.closed || host.pid !== process.pid) throw new Error("The current thread is no longer available");
        host.slot = ""; host.closed = true; delete host.working; delete host.unread;
        writeGroup(path, current);
      });
      stopHostWork(ctx);
      refreshFooterSlots();
    } catch (e) {
      if (!hostClosed(ctx)) {
        mux?.showMain(); selectedSession = session; updateViewing(); refreshMode();
      }
      notifyThreadFailure(ctx, e, "Could not close thread");
    } finally { if (closing === session) closing = undefined; }
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
        // Threads are appended to the registry when created, regardless of slot number.
        const remaining = visibleThreads(group);
        return [...remaining].reverse().find(t => t.session !== group.root && (existsSync(t.session) || manager.children.has(t.session)))?.slot
          ?? remaining.find(t => t.session === group.root)?.slot;
      });
      closed = true;
      if (request === focusGeneration) {
        closing = undefined;
        if (next) await switchSlot(ctx, next);
        else if (hostClosed(ctx)) { ctx.abort(); ctx.shutdown(); }
      }
    } catch (e) {
      if (manager.active === child && !hostClosed(ctx)) {
        manager.showMain(); selectedSession = ctx.sessionManager.getSessionFile(); updateViewing(); refreshMode();
      }
      ctx.ui.notify(`${closed ? "Thread closed, but could not switch" : "Could not close thread"}: ${errorText(e)}`, "error");
    } finally { if (closing === session) closing = undefined; }
  }
  function hideTargets() {
    generation++;
    prefixTapStartedAt = undefined;
    targetMode = false;
    const close = closePicker;
    closePicker = undefined; pickerTargets = undefined; pickerPreview = undefined; pickerCapturesInput = undefined;
    close?.();
    refreshMode();
  }
  function setTerminalFocus(focused: boolean) {
    if (terminalFocused === focused) return;
    terminalFocused = focused;
    setPrefixHeld(false); prefixTapStartedAt = undefined;
    updateViewing();
    if (!targetMode) generation++;
  }
  function prepareReply(ctx: ExtensionContext, target: Target) {
    const preview = pickerPreview?.(target);
    if (!preview) { ctx.ui.notify("That tree entry is no longer visible. Reopen the tree and choose again.", "warning"); return; }
    hideTargets();
    pending = { ...target, preview };
    refreshMode();
  }
  async function selectEntry(ctx: ExtensionContext, entryId: string) {
    const session = ctx.sessionManager.getSessionFile();
    const group = groupFile && readGroup(groupFile);
    const existing = group?.threads.find(t => t.parent === session && t.entry === entryId);
    if (existing) {
      hideTargets();
      return focusSlot(ctx, existing.slot);
    }
    const numbered = [...(pickerTargets?.().values() || [])].find(target => target.entry === entryId);
    const slot = numbered?.slot || [...slots].find(s => !visibleThreads(group).some(t => t.slot === s));
    if (!slot) { ctx.ui.notify("All thread slots are in use. Close a thread to free a number.", "warning"); return; }
    const entry = ctx.sessionManager.getEntry(entryId) as Entry | undefined;
    const boundary = numbered?.boundary || (entry && boundaryFor(ctx, entryId));
    if (!entry) { ctx.ui.notify("That tree entry is no longer available. Reopen the tree and choose again.", "warning"); return; }
    if (!boundary) { ctx.ui.notify("Cannot fork here: tool calls are incomplete or their continuation is ambiguous.", "warning"); return; }
    prepareReply(ctx, { entry: entryId, boundary, title: titleFor(entry), slot });
  }
  async function showTargets(ctx: ExtensionContext) {
    if (targetMode || pending || creating) return;
    const request = ++generation;
    try {
      if (!groupFile) await registerMe(ctx, true);
      if (request !== generation) return;
      const tree = ctx.sessionManager.getTree();
      if (!tree.length) { ctx.ui.notify("No entries to choose yet. Send a message first.", "info"); return; }
      targetMode = true;
      refreshMode();
      const promise = ctx.ui.custom<void>((tui, theme, _keys, done) => {
        closePicker = () => done();
        const filter = (pi.getSettings() as any).treeFilterMode;
        const modes = ["default", "no-tools", "user-only", "labeled-only", "all"];
        const selector = new TreeSelectorComponent(tree, ctx.sessionManager.getLeafId(), tui.terminal.rows,
          entryId => { void selectEntry(ctx, entryId); },
          () => hideTargets(),
          (entryId, label) => { pi.setLabel(entryId, label); tui.requestRender(); },
          undefined, modes.includes(filter) ? filter : "default");
        const handleInput = selector.handleInput.bind(selector);
        // In the picker, Escape closes the tree even when a search is active.
        selector.handleInput = data => {
          if (selector.capturesViewportInput && matchesKey(data, "escape")) hideTargets();
          else handleInput(data);
        };
        selector.onCopy = text => {
          if (!text) { ctx.ui.notify("Selected entry has no text to copy", "warning"); return; }
          void copyToClipboard(text).then(() => ctx.ui.notify("Copied selected message to clipboard", "info"), e => ctx.ui.notify(`Copy failed: ${errorText(e)}`, "error"));
        };
        // Pi exposes the tree list but not its filtered viewport; use its current
        // rows so the shortcut numbers always match the native filter and scroll.
        const list = selector.getTreeList() as any;
        if (!Array.isArray(list.filteredNodes) || typeof list.selectedIndex !== "number" || typeof list.maxVisibleLines !== "number") {
          throw new Error("This Pi version does not expose the tree rows needed for thread numbering");
        }
        const handleMouse = selector.handleMouse.bind(selector);
        selector.handleMouse = event => {
          if (event.type !== "wheel" || !event.wheelDelta || !selector.capturesViewportInput) return handleMouse(event);
          const previous = list.selectedIndex;
          if (list.filteredNodes.length) {
            list.selectedIndex = Math.max(0, Math.min(list.filteredNodes.length - 1, previous + Math.sign(event.wheelDelta)));
          }
          // Do not scroll the conversation behind the tree, even at the ends.
          return { handled: true, render: list.selectedIndex !== previous };
        };
        const visible = (): Entry[] => {
          list.maxVisibleLines = Math.max(5, Math.floor(tui.terminal.rows / 2));
          const start = Math.max(0, Math.min(list.selectedIndex - Math.floor(list.maxVisibleLines / 2), list.filteredNodes.length - list.maxVisibleLines));
          return list.filteredNodes.slice(start, start + list.maxVisibleLines).map((item: any) => item.node.entry);
        };
        const numbered = (): Map<string, Target> => {
          const session = ctx.sessionManager.getSessionFile();
          const group = groupFile && readGroup(groupFile);
          const threads = visibleThreads(group);
          const free = [...slots].filter(slot => !threads.some(t => t.slot === slot));
          const result = new Map<string, Target>();
          const rows = visible();
          const selectedId = list.getSelectedNode()?.entry.id;
          const selected = rows.findIndex(entry => entry.id === selectedId);
          // Start at the cursor and work upward; use newer rows only if there
          // are still free numbers. Existing thread numbers remain pinned.
          const ordered = selected < 0 ? rows.slice().reverse() : [...rows.slice(0, selected + 1).reverse(), ...rows.slice(selected + 1)];
          for (const entry of ordered) {
            const pinned = threads.find(t => t.parent === session && t.entry === entry.id);
            if (pinned) result.set(pinned.slot, { entry: entry.id, boundary: "", title: titleFor(entry), slot: pinned.slot });
            else if (free.length) {
              const boundary = boundaryFor(ctx, entry.id);
              if (boundary) {
                const slot = free.shift()!;
                result.set(slot, { entry: entry.id, boundary, title: titleFor(entry), slot });
              }
            }
          }
          return result;
        };
        let showNumbers = true;
        pickerTargets = () => showNumbers ? numbered() : new Map();
        pickerCapturesInput = () => selector.capturesViewportInput;
        const renderList = list.render;
        pickerPreview = target => {
          const index = list.filteredNodes.findIndex((item: any) => item.node.entry.id === target.entry);
          if (index < 0) return;
          return (width, previewTheme) => {
            const selectedIndex = list.selectedIndex;
            const maxVisibleLines = list.maxVisibleLines;
            try {
              // Render the chosen row with Pi's own tree renderer, including
              // labels, tool-call formatting, selected styling, and clipping.
              list.selectedIndex = index;
              list.maxVisibleLines = 1;
              const gutter = width >= 8 ? 4 : 0;
              const row = renderList.call(list, Math.max(1, width - gutter))[0] as string;
              return [gutter ? truncateToWidth(previewTheme.fg("accent", ` ${target.slot}  `) + row, width) : row];
            } finally {
              list.selectedIndex = selectedIndex;
              list.maxVisibleLines = maxVisibleLines;
            }
          };
        };
        list.render = (width: number) => {
          showNumbers = width >= 8;
          const gutter = showNumbers ? 4 : 0;
          const rows = visible();
          const numbers = new Map([...(showNumbers ? numbered() : [])].map(([slot, target]) => [target.entry, slot]));
          const lines = renderList.call(list, Math.max(1, width - gutter)) as string[];
          if (!gutter) return lines;
          return lines.map((line, i) => {
            const slot = rows[i] && numbers.get(rows[i].id);
            return truncateToWidth((slot ? theme.fg("accent", ` ${slot}  `) : " ".repeat(gutter)) + line, width);
          });
        };
        // Keep Pi's tree and its controls intact; add only the thread-specific legend.
        selector.children.splice(4, 0, {
          render(width: number) {
            const group = groupFile && readGroup(groupFile);
            const threads = selectorHeld ? renderThreadIndicators(footerSlots, theme, performance.now()) : "";
            const closeHint = group ? " · ctrl+esc to close this thread" : "";
            const detail = threads ? theme.fg("dim", "  Threads: ") + threads + theme.fg("dim", ` (brackets = current) · ${searchPrefix}+number: search digits${closeHint}`)
              : theme.fg("dim", `  ${searchPrefix}+number: search digits${closeHint}`);
            return [
              ...wrapTextWithAnsi(theme.fg("accent", `  Enter: choose row · number: choose/switch · ${config.prefix}+number: open thread · Esc: close`), width),
              ...wrapTextWithAnsi(detail, width),
            ];
          },
          invalidate() {},
        });
        return selector;
      });
      void promise.catch(e => notifyThreadFailure(ctx, e, "Pi Threads")).finally(() => {
        if (request === generation) {
          targetMode = false; closePicker = undefined; pickerTargets = undefined; pickerPreview = undefined; pickerCapturesInput = undefined;
          refreshMode();
        }
      });
    } catch (e) {
      if (request === generation) notifyThreadFailure(ctx, e, "Pi Threads");
    }
  }
  function replyBlocksSelection(ctx: ExtensionContext) {
    if (creating) { ctx.ui.notify("A thread is starting; please wait.", "info"); return true; }
    if (pending) { ctx.ui.notify("Type a reply and press Enter, or press Esc to cancel.", "info"); return true; }
    return false;
  }
  async function toggleTargets(ctx: ExtensionContext) {
    if (targetMode) hideTargets();
    else if (!replyBlocksSelection(ctx)) await showTargets(ctx);
  }
  async function enableTargets(ctx: ExtensionContext) {
    if (targetMode || replyBlocksSelection(ctx)) return;
    await showTargets(ctx);
  }
  async function choose(ctx: ExtensionContext, slot: string) {
    if (!targetMode) return focusSlot(ctx, slot);
    const group = groupFile && readGroup(groupFile);
    const existing = group?.threads.find(t => t.slot === slot);
    if (existing) {
      hideTargets();
      return focusSlot(ctx, slot);
    }
    const target = pickerTargets?.().get(slot);
    if (!target) { ctx.ui.notify(`No visible row or existing thread is numbered ${slot}. To search for the digit, press ${searchPrefix}+${slot}.`, "warning"); return; }
    prepareReply(ctx, target);
  }
  function missingThread(ctx: ExtensionContext, group: Group | undefined, thread: Thread | undefined) {
    return !thread || (thread.session !== group?.root && thread.session !== ctx.sessionManager.getSessionFile()
      && !existsSync(thread.session) && !pidAlive(thread.pid) && !mux?.children.has(thread.session)
      && !(thread.reservedAt && Date.now() - thread.reservedAt < 120000));
  }
  async function switchOrCreate(ctx: ExtensionContext, slot: string) {
    if (closing) return;
    const group = groupFile ? readGroup(groupFile) : undefined;
    const thread = group?.threads.find(entry => entry.slot === slot);
    if (missingThread(ctx, group, thread)) {
      await newSessionThread(ctx, slot);
      return;
    }
    if (targetMode) hideTargets();
    await focusSlot(ctx, slot);
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
          if (group.threads.some(t => t.slot === target.slot)) throw new Error(`Slot ${target.slot} is now in use; reopen the tree and choose again`);
          const branch = ctx.sessionManager.getBranch(target.boundary) as Entry[];
          const index = branch.findIndex(e => e.id === target.entry);
          const boundary = index < 0 ? undefined : safeBoundary(branch, index);
          if (!boundary || boundary !== target.boundary) throw new Error("The selected message is no longer available; select it again");
        } else {
          const slot = [...slots].find(s => !visibleThreads(group).some(t => t.slot === s));
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
  async function newSessionThread(ctx: ExtensionContext, requestedSlot?: string) {
    if (ctx.mode !== "tui" || replyBlocksSelection(ctx)) return;
    hideTargets();
    creating = true;
    let child = "";
    let registered = false;
    try {
      if (!groupFile) await registerMe(ctx, true, true);
      const slot = await locked(groupFile!, group => {
        if (!group) throw new Error("Thread registry disappeared");
        const existing = requestedSlot ? group.threads.find(t => t.slot === requestedSlot) : undefined;
        if (existing && !missingThread(ctx, group, existing)) return existing.slot;
        const slot = requestedSlot || [...slots].find(s => !visibleThreads(group).some(t => t.slot === s));
        if (!slot) throw new Error("All thread slots are in use");
        if (existing?.kickoff && existsSync(existing.kickoff)) throw new Error(`Thread ${slot} has an unsent reply; its missing session was not replaced`);
        const fresh = SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir());
        const path = fresh.getSessionFile();
        const header = fresh.getHeader();
        if (!path || !header) throw new Error("Could not create a new session");
        // Pi normally defers persistence until the first message; create only
        // the header so this empty session can be switched to immediately.
        writeFileSync(path, `${JSON.stringify(header)}\n`, { mode: 0o600, flag: "wx" });
        child = path;
        const model = ctx.model;
        const thread: Thread = { slot, session: child, title: "New session", ...(model ? { initialModel: { provider: model.provider, id: model.id, thinking: pi.getThinkingLevel() } } : {}) };
        if (existing) group.threads.splice(group.threads.indexOf(existing), 1, thread);
        else group.threads.push(thread);
        writeGroup(groupFile!, group);
        registered = true;
        return slot;
      });
      await switchSlot(ctx, slot);
    } catch (e) {
      if (child && !registered) { try { unlinkSync(child); } catch {} }
      notifyThreadFailure(ctx, e, "Could not open thread");
    } finally { creating = false; }
  }
  async function settings(ctx: ExtensionContext) {
    const choices = ["Open thread tree shortcut", "Thread modifier prefix", "Previous thread shortcut", "Next thread shortcut", "New thread shortcut", "Thread 1 shortcut", "Restore defaults"];
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

  pi.on("session_before_switch", (event, ctx) => {
    if (!childSocket || !groupFile || event.reason !== "resume" || !event.targetSessionFile) return;
    const found = findGroup(event.targetSessionFile);
    if (!found || event.targetSessionFile === ctx.sessionManager.getSessionFile()) return;
    if (found.path !== groupFile) {
      ctx.ui.notify("That session belongs to another thread group. Resume it from the main session instead.", "warning");
      return { cancel: true };
    }
    const thread = found.group.threads.find(t => t.session === event.targetSessionFile);
    if (thread?.closed && thread.session === found.group.root) {
      if (bridge) void bridge.switch("reopen-host").catch(e => ctx.ui.notify(`Could not reopen thread: ${errorText(e)}`, "error"));
      else ctx.ui.notify("The thread manager is not connected yet", "warning");
      return { cancel: true };
    }
    if (thread) {
      ctx.ui.notify(`That session is already thread ${thread.slot}. Switch with ${config.prefix}+${thread.slot}.`, "warning");
      return { cancel: true };
    }
  });
  pi.on("before_agent_start", event => {
    event.systemPromptOptions.sections.pi_threads = "Pi Threads plugin may have threads work concurrently in the same working directory, this is by design. Use pi logs to understand any unexpected code changes and work around it. You're working with pretty smart agents, you'll all figure it out.";
  });
  pi.on("agent_start", (_event, ctx) => updateActivity(ctx, true));
  pi.on("agent_settled", (_event, ctx) => updateActivity(ctx, false));
  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    context = ctx;
    localWorking = !ctx.isIdle();
    selectedSession = (!childSocket && mux?.active?.session) || ctx.sessionManager.getSessionFile();
    ctx.ui.setWidget("threads-hook", (tui) => {
      ui = tui;
      refreshFooterSlots();
      patchFooter(ctx);
      return { render: () => [], invalidate() {} };
    });
    // Pi's fullscreen viewport consumes focus reports before extension input
    // listeners run, so observe them at the TUI entry point instead.
    if (typeof ui?.handleTerminalInput === "function") {
      const tui = ui, original = tui.handleTerminalInput;
      const replacement = function (this: any, data: string) {
        if (data === "\x1b[I") setTerminalFocus(true);
        else if (data === "\x1b[O") setTerminalFocus(false);
        return original.call(this, data);
      };
      tui.handleTerminalInput = replacement;
      focusPatch = { tui, original, replacement };
      // Fullscreen usually enables this itself, but regular mode and fullscreen
      // with mouse reporting disabled need it for focus-aware modifier handling.
      tui.terminal.write("\x1b[?1004h");
    }
    const enableKeyboard = () => {
      if (!ui?.terminal?.kittyProtocolActive) { keyboardEnabled = false; return; }
      if (!keyboardEnabled) { ui.terminal.write("\x1b[=24;2u"); keyboardEnabled = true; }
    };
    const tick = () => { enableKeyboard(); refreshFooterSlots(); };
    tick();
    keyboardTimer = setInterval(tick, 250);
    keyboardTimer.unref();
    unsubscribeInput = ctx.ui.onTerminalInput(raw => {
      // Fullscreen consumes these itself; regular mode must not pass them to the editor.
      if (raw === "\x1b[I" || raw === "\x1b[O") return { consume: true };
      const key = parseKeyboardEvent(raw);
      const data = key?.normalized || raw;
      if (key?.modifierKey) {
        // Ghostty can send modifier-only events to background tabs.
        if (!terminalFocused) return { consume: true };
        const active = (key.modifiers & prefixMask) === prefixMask;
        inheritedPrefixHeld = active;
        setSelectorHeld(active);
        if (!prefixHeld && active && key.event === 1) {
          setPrefixHeld(true);
          const onlyPrefix = (key.modifiers & (1 | 2 | 4 | 8 | 16 | 32)) === prefixMask;
          prefixTapStartedAt = onlyPrefix && !targetMode && !pending && !creating && editorFocused() ? performance.now() : undefined;
        } else if (prefixHeld && !active) {
          const tapped = prefixTapStartedAt !== undefined && key.event === 3 && performance.now() - prefixTapStartedAt <= tapDurationMs;
          setPrefixHeld(false); prefixTapStartedAt = undefined;
          if (tapped && terminalFocused && editorFocused() && !targetMode && !pending && !creating) void showTargets(ctx);
        } else if (prefixHeld && key.event === 1) {
          // An additional modifier makes this a chord, not a bare tap.
          prefixTapStartedAt = undefined;
        }
        return { consume: true };
      }
      // Any other key while the modifier is held makes it a shortcut, not a tap.
      if (prefixHeld) prefixTapStartedAt = undefined;
      if (isKeyRelease(data)) return data !== raw ? { data } : undefined;
      if (isCloseShortcut(raw)) {
        if (bridge && childToken) {
          void bridge.switch(`close:${childToken}`).catch(e => ctx.ui.notify(`Could not close thread: ${errorText(e)}`, "error"));
        } else if (childSocket) ctx.ui.notify("The thread manager is not connected yet", "info");
        else void closeHost(ctx);
        return { consume: true };
      }
      if (matchesKey(data, "escape") && pending && !targetMode) {
        if (creating) { ctx.ui.notify("The new thread is starting", "warning"); return { consume: true }; }
        pending = undefined; refreshMode();
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
      // Some terminals report the held modifier separately but send a bare digit.
      for (const slot of slots) {
        if (matchesKey(data, `${config.prefix}+${slot}` as any) || ((prefixHeld || inheritedPrefixHeld) && matchesKey(data, slot as any))) {
          if (targetMode && !pickerCapturesInput?.()) return data !== raw ? { data } : undefined;
          if (!key || key.event === 1) void switchOrCreate(ctx, slot);
          return { consume: true };
        }
      }
      if (targetMode && pickerCapturesInput?.()) {
        for (const slot of slots) {
          // Bare digits choose a visible row or thread. A separate modified
          // digit enters text into Pi's native search instead.
          if (matchesKey(data, `${searchPrefix}+${slot}` as any)) return { data: slot };
          if (matchesKey(data, slot as any)) {
            void choose(ctx, slot);
            return { consume: true };
          }
        }
      }
      if (matchesKey(data, config.previous as any)) { void cycle(ctx, -1); return { consume: true }; }
      if (matchesKey(data, config.next as any)) { void cycle(ctx, 1); return { consume: true }; }
      if (matchesKey(data, config.mainThread as any)) { void switchOrCreate(ctx, "1"); return { consume: true }; }
      // Ctrl+N also filters Pi's session picker. Handle this shortcut only
      // in the editor instead of registering a conflicting global shortcut.
      if (matchesKey(data, config.newThread as any) && editorFocused()) {
        if (!key || key.event === 1) void newSessionThread(ctx);
        return { consume: true };
      }
      if (key && (key.text !== undefined || data !== raw)) return { data: key.text ?? data };
    });
    const session = ctx.sessionManager.getSessionFile();
    const registered = session && findGroup(session);
    const replacing = !!(childSocket && event.previousSessionFile && session && event.previousSessionFile !== session && ["new", "resume", "fork"].includes(event.reason));
    // Reconnect a session that /new disconnected before this version was loaded.
    const recovering = !!(childSocket && session && event.reason === "reload" && !registered);
    const rebinding = replacing || recovering;
    if (session && !rebinding && registered) {
      try { await registerMe(ctx, false, !!childSocket); } catch (e) { notifyThreadFailure(ctx, e, "Pi Threads", "warning"); }
    }
    if (session && childSocket && childToken) {
      const model = ctx.model;
      const waitForPaint = event.reason === "startup" && typeof ui?.renderNow === "function";
      bridge = connectThread({ path: childSocket, token: childToken, session, waitForPaint,
        previousSession: replacing ? event.previousSessionFile : undefined, reason: recovering ? "recover" : event.reason,
        header: rebinding ? ctx.sessionManager.getHeader() : undefined,
        initialModel: rebinding && model ? { provider: model.provider, id: model.id, thinking: pi.getThinkingLevel() } : undefined,
        onActivate: (appearance: string, focused?: boolean, held?: boolean) => {
          if (typeof focused === "boolean") setTerminalFocus(focused);
          prefixHeld = false;
          inheritedPrefixHeld = held === true && terminalFocused;
          setSelectorHeld(inheritedPrefixHeld);
          hideTargets();
          // A background PTY cannot receive terminal palette replies. Re-query
          // on activation so Pi's native system theme matches the host terminal.
          ui?.handleTerminalInput?.(`\x1b[?997;${appearance === "light" ? "2" : "1"}n`);
          ui?.requestRender(true);
        }, onModifier: (held: boolean) => {
          inheritedPrefixHeld = held === true && terminalFocused;
          setSelectorHeld(inheritedPrefixHeld);
        } });
      if (waitForPaint) {
        const tui = ui, original = tui.renderNow, connection = bridge;
        const replacement = function (this: any, ...args: any[]) {
          if (tui.renderNow === replacement) tui.renderNow = original;
          if (startupPaintPatch?.replacement === replacement) startupPaintPatch = undefined;
          const result = original.apply(this, args);
          connection.painted();
          return result;
        };
        startupPaintPatch = { tui, original, replacement };
        tui.renderNow = replacement;
      }
      if (rebinding) {
        try { await bridge.ready; await registerMe(ctx, false, true); refreshFooterSlots(); }
        catch (e) { notifyThreadFailure(ctx, e, "Could not reconnect thread", "warning"); }
      }
    } else if (mux) getMux(ctx);
    const kickoff = process.env.PI_THREADS_KICKOFF || process.env.PI_CHATTHREADS_KICKOFF;
    if (session && kickoff && directories.includes(dirname(kickoff)) && basename(kickoff).startsWith("kickoff-") && kickoff.endsWith(".json")) {
      delete process.env.PI_THREADS_KICKOFF; delete process.env.PI_CHATTHREADS_KICKOFF;
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
    pending = undefined; hideTargets(); focusGeneration++; restoreFooter(); unsubscribeInput?.();
    if (!childSocket) mux?.screenTransition?.cancel();
    if (startupPaintPatch) {
      const { tui, original, replacement } = startupPaintPatch;
      if (tui.renderNow === replacement) tui.renderNow = original;
      startupPaintPatch = undefined;
    }
    bridge?.close(); bridge = undefined;
    if (keyboardTimer) clearInterval(keyboardTimer);
    if (keyboardEnabled && ui?.terminal?.kittyProtocolActive) ui.terminal.write("\x1b[=24;3u");
    if (focusPatch) {
      const { tui, original, replacement } = focusPatch;
      if (tui.handleTerminalInput === replacement) tui.handleTerminalInput = original;
      if (tui.mode !== "fullscreen" || tui.mouseEnabled === false) tui.terminal.write("\x1b[?1004l");
      focusPatch = undefined;
    }
    const session = ctx.sessionManager.getSessionFile();
    const path = groupFile;
    await viewQueue;
    if (event.reason !== "reload") {
      if (!childSocket && mux) { mux.dispose(); delete shared[muxKey]; mux = undefined; }
      if (session && path) try {
        await locked(path, group => {
          const me = group?.threads.find(t => t.session === session && t.pid === process.pid);
          if (me && group) {
            if (me.working && group.viewing !== session) me.unread = true;
            delete me.pid; delete me.tty; delete me.working;
            if (!childSocket) delete group.viewing;
            writeGroup(path, group);
          }
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
    description: "Choose thread targets, switch threads, or configure shortcuts",
    getArgumentCompletions: (prefix) => {
      const group = groupFile && readGroup(groupFile);
      const options = [
        { value: "on", label: "on", description: "Open the thread target tree" },
        { value: "off", label: "off", description: "Cancel a pending thread reply" },
        { value: "show", label: "show", description: "Choose an existing thread" },
        { value: "keybinding", label: "keybinding", description: "Configure shortcuts" },
        ...visibleThreads(group).map(t => ({ value: t.slot, label: t.slot, description: `Switch to ${t.title}` })),
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
      } else if (/^[0-9]$/.test(command)) await switchOrCreate(ctx, command);
      else ctx.ui.notify(`Open tree: short tap ${config.prefix}, ${config.targets}, or /threads on. Switch or create: ${config.prefix}+number or /threads <number>. Also: /threads off, show, keybinding.`, command ? "warning" : "info");
    },
  });
  pi.registerShortcut(config.targets as any, { description: "Open the thread target tree", handler: toggleTargets });
  for (const slot of slots) pi.registerShortcut(`${config.prefix}+${slot}` as any, { description: `Switch to or create thread ${slot}`, handler: ctx => switchOrCreate(ctx, slot) });
  pi.registerShortcut(config.previous as any, { description: "Previous chat thread", handler: ctx => cycle(ctx, -1) });
  pi.registerShortcut(config.next as any, { description: "Next chat thread", handler: ctx => cycle(ctx, 1) });
  pi.registerShortcut(config.mainThread as any, { description: "Switch to or create thread 1", handler: ctx => switchOrCreate(ctx, "1") });
}
