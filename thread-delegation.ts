import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { autoThreadingEnabled } from "./thread-settings.ts";

type Pointer = { sessionFile: string; messageId: string; contextLeafId?: string; start?: number; end?: number };
type Result = { id: string; slot: string; session: string; success: boolean; status: string; lastResponse: string; error?: string };
export type ThreadDelegation = {
  id: string;
  parent: string;
  parentPid: number;
  session: string;
  slot: string;
  leafId?: string;
  notifyOnCompletion?: boolean;
  returnLastResponse: boolean;
  state: "running" | "completed";
  notified?: boolean;
  cancelled?: boolean;
  settled?: Result;
  result?: Result;
};
type DelegatedThread = { slot: string; session: string; title: string; pid?: number; closed?: boolean; kickoff?: string; delegation?: string; initialModel?: { provider: string; id: string; thinking: string } };
type DelegationGroup = { threads: DelegatedThread[]; delegations?: ThreadDelegation[] };
type Helpers<G extends DelegationGroup> = {
  groupPath(): string | undefined;
  ensureGroup(ctx: ExtensionContext): Promise<string>;
  readGroup(path: string): G | undefined;
  locked<T>(path: string, fn: (group: G | undefined) => T): Promise<T>;
  writeGroup(path: string, group: G): void;
  start(ctx: ExtensionContext, id: string, session: string): Promise<void>;
  stop(ctx: ExtensionContext, id: string, session: string): Promise<void>;
};
type Callback = { origin: string; leafId?: string; notifyOnCompletion?: boolean; returnLastResponse: boolean; result?: Result; delivered: boolean };
type Monitor = { path: string; session: string; ctx: ExtensionContext; watcher?: FSWatcher; timer?: ReturnType<typeof setInterval>; running: boolean; again: boolean; stopped: boolean };

const slots = "1234567890";
const resultType = "pi-threads-delegate-result";

function messageText(content: any): string {
  return typeof content === "string" ? content : (Array.isArray(content) ? content : [])
    .filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("\n");
}

function resolvePointer(sessionFile: string | undefined, branch: any[], args: { messageId?: string; start?: number; end?: number }): Pointer {
  if (!sessionFile || !isAbsolute(sessionFile) || !existsSync(sessionFile)) throw new Error("Delegation requires a saved session.");
  const users = branch.filter(entry => entry.type === "message" && entry.message?.role === "user");
  const entry = args.messageId === undefined ? users.at(-1) : users.find(item => item.id === args.messageId);
  if (!entry) throw new Error("User message not found on the active branch. Omit messageId for the latest request, or use the top-level user-entry ID.");
  if (branch.some(item => item.type === "context_edit" && item.targetId === entry.id)) throw new Error("This message has context edits. Submit the intended request as a new message.");
  const pointer: Pointer = { sessionFile, messageId: entry.id, contextLeafId: branch.at(-1)?.id };
  if (args.start !== undefined || args.end !== undefined) {
    const length = Array.from(messageText(entry.message.content)).length;
    if (!Number.isSafeInteger(args.start) || !Number.isSafeInteger(args.end) || args.start! < 0 || args.end! <= args.start! || args.end! > length) {
      throw new Error(`Supply both start and end: 0 <= start < end <= ${length} Unicode code points.`);
    }
    pointer.start = args.start;
    pointer.end = args.end;
  }
  return pointer;
}

function assignment(pointer: Pointer) {
  return `Execute the user request identified by this Pi session pointer:\n${JSON.stringify(pointer)}\n\n` +
    "Read the referenced JSONL session log yourself; the request is not reproduced here. " +
    "Entry IDs are top-level id fields. Follow parentId from contextLeafId to reconstruct the active branch as it existed at delegation, including later reviews already on that branch. " +
    "Do not treat abandoned branches or later appended messages as assignments. Honor context_edit entries. " +
    "If start/end are present, only that zero-based, end-exclusive Unicode-code-point range of the selected message text (text blocks joined with a newline) is assigned; surrounding text is context. " +
    "Images attached here are copied from the source message; read other relevant image blocks on the captured branch. Do not repeatedly delegate the same assignment unchanged. " +
    "If blocked or the request is ambiguous, explain that rather than guessing. Do not modify the parent log. " +
    "End with a concise final response stating what was completed and verified, or the blocker; do not claim success without verification.";
}

function completionText(result: Result, include: boolean) {
  const outcome = `${result.id}:${result.success ? "Completed" : "Error"} (thread ${result.slot})`;
  const response = include ? ` last response: ${result.lastResponse || "(no assistant text response)"}` : "";
  const error = !result.success && result.error ? `\nError: ${result.error}` : "";
  return `${outcome}${response}${error}\nSession log: ${result.session}`;
}

// Called by the terminal owner after the delegated PTY exits, under the group lock.
export function finishDelegatedThread(group: DelegationGroup, thread: DelegatedThread, pid: number): boolean {
  if (!thread.delegation || (thread.pid && thread.pid !== pid)) return false;
  const task = group.delegations?.find(item => item.id === thread.delegation && item.session === thread.session);
  if (!task || task.state === "completed") return false;
  const result = task.settled;
  task.result = task.cancelled
    ? { id: task.id, slot: task.slot, session: task.session, success: false, status: "cancelled", lastResponse: result?.lastResponse || "", error: "Thread was cancelled." }
    : result || { id: task.id, slot: task.slot, session: task.session, success: false, status: "failed", lastResponse: "", error: "Thread stopped before completing its turn." };
  task.state = "completed";
  delete task.settled;
  if (thread.kickoff && basename(thread.kickoff).startsWith("kickoff-")) {
    try { unlinkSync(thread.kickoff); } catch {}
  }
  return true;
}

export function registerThreadDelegation<G extends DelegationGroup>(pi: ExtensionAPI, helpers: Helpers<G>) {
  let active: { session: string; ctx: ExtensionContext } | undefined;
  let shuttingDown = false;
  let monitor: Monitor | undefined;
  const callbacks = new Map<string, Callback>();
  const starting = new Set<Promise<unknown>>();

  function stopMonitor(state: Monitor) {
    state.stopped = true;
    state.watcher?.close();
    if (state.timer) clearInterval(state.timer);
    if (monitor === state) monitor = undefined;
  }

  function deliver(result: Result, callback: Callback) {
    const triggerTurn = callback.notifyOnCompletion ?? !result.success;
    pi.sendMessage({ customType: resultType, content: completionText(result, callback.returnLastResponse), display: true, details: result },
      triggerTurn ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false });
    callback.delivered = triggerTurn;
  }

  function startMonitor(path: string, session: string, ctx: ExtensionContext) {
    if (monitor && !monitor.stopped && monitor.path === path && monitor.session === session) return monitor;
    if (monitor) stopMonitor(monitor);
    const state: Monitor = { path, session, ctx, running: false, again: false, stopped: false };
    monitor = state;
    try {
      state.watcher = watch(dirname(path), { persistent: false }, (_event, name) => {
        if (!name || name.toString() === basename(path)) schedule(state);
      });
      state.watcher.on("error", () => { state.watcher?.close(); state.watcher = undefined; });
    } catch { /* The timer covers unsupported filesystem watches. */ }
    state.timer = setInterval(() => schedule(state), 2500);
    state.timer.unref();
    schedule(state);
    return state;
  }

  function schedule(state: Monitor) {
    if (state.stopped) return;
    if (state.running) { state.again = true; return; }
    state.running = true;
    void (async () => {
      do {
        state.again = false;
        await reconcile(state);
      } while (!state.stopped && state.again);
    })().catch(() => { /* Retry on the next event or timer. */ }).finally(() => {
      state.running = false;
      if (!state.stopped && state.again) schedule(state);
    });
  }

  async function reconcile(state: Monitor) {
    let pending = false;
    const completed = await helpers.locked(state.path, group => {
      if (!group || state.stopped) return [] as ThreadDelegation[];
      const ready: ThreadDelegation[] = [];
      for (const task of group.delegations || []) {
        if (task.parent !== state.session || task.parentPid !== process.pid) continue;
        if (task.state === "running") pending = true;
        else if (!task.notified && task.result) { task.notified = true; ready.push({ ...task }); }
      }
      if (ready.length) helpers.writeGroup(state.path, group);
      return ready;
    });
    if (state.stopped || shuttingDown || active?.session !== state.session) return;
    const branch = state.ctx.sessionManager.getBranch();
    for (const task of completed) {
      if (!task.result || (task.leafId && !branch.some(entry => entry.id === task.leafId))) continue;
      const callback = callbacks.get(task.id) || { origin: state.session, leafId: task.leafId, returnLastResponse: false, delivered: false };
      callback.notifyOnCompletion = task.notifyOnCompletion;
      callback.returnLastResponse = task.returnLastResponse;
      callback.result = task.result;
      callbacks.set(task.id, callback);
      deliver(task.result, callback);
    }
    if (!pending) {
      stopMonitor(state);
      const group = helpers.readGroup(state.path);
      if (active?.session === state.session && group?.delegations?.some(task => task.parent === state.session && task.parentPid === process.pid && (task.state === "running" || !task.notified))) {
        startMonitor(state.path, state.session, state.ctx);
      }
    }
  }

  async function cancelOwned(ctx: ExtensionContext) {
    const session = ctx.sessionManager.getSessionFile(), path = helpers.groupPath();
    if (!session || !path) return;
    const tasks = await helpers.locked(path, group => {
      if (!group) return [] as ThreadDelegation[];
      const running = (group.delegations || []).filter(task => task.parent === session && task.parentPid === process.pid && task.state === "running");
      for (const task of running) task.cancelled = true;
      if (running.length) helpers.writeGroup(path, group);
      return running.map(task => ({ ...task }));
    });
    await Promise.allSettled(tasks.map(task => helpers.stop(ctx, task.id, task.session)));
  }

  pi.on("before_agent_start", (event, ctx) => {
    // The old standalone extension may still be installed. Its hidden-worker policy
    // must not override the numbered-thread implementation.
    delete event.systemPromptOptions.sections.pi_delegate_policy;
    const legacy = new Set(pi.getAllTools().filter(tool => ["delegate", "delegate_callback"].includes(tool.name)
      && /(?:^|[/\\])pi-delegate(?:[/\\]|$)/.test(tool.sourceInfo.path)).map(tool => tool.name));
    if (legacy.size) pi.setActiveTools(pi.getActiveTools().filter(name => !legacy.has(name)));
    const enabled = ctx.mode === "tui" && autoThreadingEnabled();
    event.systemPromptOptions.sections.pi_threads_auto = enabled
      ? "Auto-threading is ON. For suitable independent execution work, you may call pi_threads_delegate using a pointer to the user's request; keep discussion here and avoid overlapping edits. " +
        "Omit messageId for the latest user message, or read the session log for an earlier top-level user-entry ID; optional start/end identify a Unicode range. " +
        `Session log: ${JSON.stringify(ctx.sessionManager.getSessionFile() ?? null)}. ` +
        "A delegated thread must not delegate its initial assignment unchanged, but may delegate distinct work and new user requests. " +
        "Results arrive without polling. Set notifyOnCompletion and returnLastResponse when an authorized next step needs them; pi_threads_delegate_callback can subscribe later. " +
        "If thread slots are full, do the work yourself. Do not delegate completion notifications as new assignments."
      : "Auto-threading is OFF or unavailable. Work directly; do not launch pi_threads_delegate.";
  });

  pi.on("session_start", (_event, ctx) => {
    shuttingDown = false;
    const session = ctx.sessionManager.getSessionFile();
    active = session ? { session, ctx } : undefined;
  });

  pi.registerTool({
    name: "pi_threads_delegate",
    label: "Delegate to Thread",
    description: "Start a numbered background thread from a pointer to a user message in this session. Returns immediately; the completion is displayed automatically. No task text, polling, or general agent-to-agent chat. Workers share the cwd; assign non-overlapping work. Use pi_threads_delegate_callback for an authorized follow-up.",
    parameters: Type.Object({
      messageId: Type.Optional(Type.String({ description: "Earlier top-level user-message entry ID; defaults to the latest user message." })),
      start: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based Unicode code point offset; requires end." })),
      end: Type.Optional(Type.Integer({ minimum: 1, description: "Exclusive Unicode code point offset; requires start." })),
      notifyOnCompletion: Type.Optional(Type.Boolean({ description: "Wake for authorized follow-up. By default only errors wake the parent." })),
      returnLastResponse: Type.Optional(Type.Boolean({ description: "Include the last assistant response in the completion. Default false." })),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, _update, ctx) {
      if (ctx.mode !== "tui" || !autoThreadingEnabled()) throw new Error("Auto-threading is off or unavailable.");
      if (shuttingDown || signal?.aborted) throw new Error("Delegation cancelled before launch.");
      const origin = ctx.sessionManager.getSessionFile();
      const branch = ctx.sessionManager.getBranch();
      const pointer = resolvePointer(origin, branch, args);
      const selected = branch.find(entry => entry.id === pointer.messageId);
      const content = selected?.type === "message" && selected.message.role === "user" ? selected.message.content : undefined;
      const images = Array.isArray(content) ? content.filter(block => block.type === "image").map(block => ({ type: "image" as const, data: block.data, mimeType: block.mimeType })) : [];
      const text = assignment(pointer);
      const message = images.length ? [{ type: "text" as const, text }, ...images] : text;
      const path = await helpers.ensureGroup(ctx);
      if (shuttingDown || signal?.aborted || ctx.sessionManager.getSessionFile() !== origin) throw new Error("Delegation cancelled before launch.");
      const id = randomUUID();
      let child = "", kickoff = "", slot = "", registered = false;
      try {
        await helpers.locked(path, group => {
          if (!group) throw new Error("Thread group is unavailable.");
          const parent = group.threads.find(thread => thread.session === origin && !thread.closed);
          if (!parent || parent.pid !== process.pid) throw new Error("The requesting thread is no longer active.");
          slot = [...slots].find(value => !group.threads.some(thread => !thread.closed && thread.slot === value)) || "";
          if (!slot) throw new Error("Error: thread slots currently full, do it yourself.");
          const fresh = SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir(), { id, parentSession: origin });
          const session = fresh.getSessionFile(), header = fresh.getHeader();
          if (!session || !header) throw new Error("Could not create a thread session.");
          child = session;
          writeFileSync(child, `${JSON.stringify(header)}\n`, { mode: 0o600, flag: "wx" });
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          kickoff = join(dirname(path), `kickoff-${randomUUID()}.json`);
          writeFileSync(kickoff, JSON.stringify({ session: child, message }), { mode: 0o600, flag: "wx" });
          const model = ctx.model;
          group.threads.push({ slot, session: child, title: "Delegated task", kickoff, delegation: id,
            ...(model ? { initialModel: { provider: model.provider, id: model.id, thinking: pi.getThinkingLevel() } } : {}) });
          (group.delegations ||= []).push({ id, parent: origin!, parentPid: process.pid, session: child, slot, leafId: pointer.contextLeafId,
            notifyOnCompletion: args.notifyOnCompletion, returnLastResponse: args.returnLastResponse ?? false, state: "running" });
          helpers.writeGroup(path, group);
          registered = true;
        });
        const callback: Callback = { origin: origin!, leafId: pointer.contextLeafId, notifyOnCompletion: args.notifyOnCompletion,
          returnLastResponse: args.returnLastResponse ?? false, delivered: false };
        callbacks.set(id, callback);
        startMonitor(path, origin!, ctx);
        const launch = helpers.start(ctx, id, child);
        starting.add(launch);
        try { await launch; } finally { starting.delete(launch); }
        if (shuttingDown || signal?.aborted) {
          await helpers.stop(ctx, id, child).catch(() => {});
          throw new Error("Delegation cancelled during launch.");
        }
        return { content: [{ type: "text", text: `Started worker ${id} in thread ${slot}. Session log: ${child}. Continue; do not wait or poll.` }], details: { id, slot, session: child, pointer } };
      } catch (error) {
        if (registered) {
          await helpers.locked(path, group => {
            if (!group) return;
            group.threads = group.threads.filter(thread => thread.delegation !== id);
            group.delegations = (group.delegations || []).filter(task => task.id !== id);
            helpers.writeGroup(path, group);
          }).catch(() => {});
          callbacks.delete(id);
        }
        if (kickoff) try { unlinkSync(kickoff); } catch {}
        // Once registered, the child may already be writing; retain its normal Pi session.
        if (child && !registered) try { unlinkSync(child); } catch {}
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "pi_threads_delegate_callback",
    label: "Thread Completion Callback",
    description: "Subscribe to a delegated thread's completion without spawning or polling. Works while running and after completion on this session branch. Use only for user-authorized follow-up work.",
    parameters: Type.Object({
      id: Type.String({ description: "Worker ID returned by pi_threads_delegate or its completion." }),
      notifyOnCompletion: Type.Optional(Type.Boolean({ description: "Wake on completion; default true. False disables wake-up." })),
      returnLastResponse: Type.Optional(Type.Boolean({ description: "Include the worker's last answer; default true." })),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, _update, ctx) {
      if (shuttingDown || signal?.aborted) throw new Error("Callback cancelled.");
      const origin = ctx.sessionManager.getSessionFile(), branch = ctx.sessionManager.getBranch();
      let callback = callbacks.get(args.id);
      if (callback && (callback.origin !== origin || (callback.leafId && !branch.some(entry => entry.id === callback!.leafId)))) callback = undefined;
      const saved = [...branch].reverse().find((entry: any) => entry.type === "custom_message" && entry.customType === resultType && entry.details?.id === args.id) as any;
      // A queued completion may not be persisted yet; only reject one saved on another branch.
      if (callback?.result && !saved && ctx.sessionManager.getEntries().some((entry: any) =>
        entry.type === "custom_message" && entry.customType === resultType && entry.details?.id === args.id)) callback = undefined;
      if (!callback && saved?.details) callback = { origin: origin!, result: saved.details as Result, returnLastResponse: false, delivered: false };
      const path = helpers.groupPath();
      if (!callback && path && origin) {
        const task = helpers.readGroup(path)?.delegations?.find(item => item.id === args.id && item.parent === origin && item.parentPid === process.pid && item.state === "running");
        if (task && (!task.leafId || branch.some(entry => entry.id === task.leafId))) callback = { origin, leafId: task.leafId, result: task.result, returnLastResponse: task.returnLastResponse, delivered: false };
      }
      if (!callback) throw new Error("Unknown worker on this session branch.");
      callback.notifyOnCompletion = args.notifyOnCompletion ?? true;
      callback.returnLastResponse = args.returnLastResponse ?? true;
      callbacks.set(args.id, callback);
      if (path) await helpers.locked(path, group => {
        const task = group?.delegations?.find(item => item.id === args.id && item.parent === origin && item.parentPid === process.pid);
        if (task && group) {
          task.notifyOnCompletion = callback!.notifyOnCompletion;
          task.returnLastResponse = callback!.returnLastResponse;
          helpers.writeGroup(path, group);
        }
      });
      if (callback.result && callback.notifyOnCompletion && !callback.delivered) deliver(callback.result, callback);
      return { content: [{ type: "text", text: callback.notifyOnCompletion ? `Completion callback registered for ${args.id}. Yield; do not poll.` : `Completion wake-up disabled for ${args.id}.` }],
        details: { id: args.id, notifyOnCompletion: callback.notifyOnCompletion, returnLastResponse: callback.returnLastResponse } };
    },
  });

  pi.on("agent_start", async (_event, ctx) => {
    const session = ctx.sessionManager.getSessionFile(), path = helpers.groupPath();
    if (!session || !path) return;
    await helpers.locked(path, group => {
      const thread = group?.threads.find(item => item.session === session && item.pid === process.pid && item.delegation);
      const task = thread && group?.delegations?.find(item => item.id === thread.delegation && item.state === "running");
      if (group && task?.settled) { delete task.settled; helpers.writeGroup(path, group); }
    });
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const session = ctx.sessionManager.getSessionFile(), path = helpers.groupPath();
    if (!session || !path) return;
    let delegated = false;
    await helpers.locked(path, group => {
      const thread = group?.threads.find(item => item.session === session && item.pid === process.pid && item.delegation);
      const task = thread && group?.delegations?.find(item => item.id === thread.delegation && item.state === "running");
      if (!group || !thread || !task) return;
      const assistants = ctx.sessionManager.getBranch().filter((entry: any) => entry.type === "message" && entry.message?.role === "assistant") as any[];
      const last = assistants.at(-1)?.message;
      const lastResponse = [...assistants].reverse().map(entry => messageText(entry.message.content)).find(text => text.trim()) || "";
      const success = !event.aborted && last?.stopReason === "stop" && !last.errorMessage;
      task.settled = { id: task.id, slot: task.slot, session, success, status: event.aborted ? "cancelled" : success ? "finished" : "failed", lastResponse,
        ...(!success ? { error: event.aborted ? "Thread was aborted." : last?.errorMessage || "Thread did not finish with a complete assistant response." } : {}) };
      helpers.writeGroup(path, group);
      delegated = true;
    });
    if (delegated) setTimeout(() => {
      if (active?.session === session && ctx.isIdle() && !ctx.hasPendingMessages()) ctx.shutdown();
    }, 0);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    if (monitor) stopMonitor(monitor);
    await Promise.allSettled([...starting]);
    await cancelOwned(ctx).catch(() => {});
    active = undefined;
  });

  return { cancelOwned };
}
