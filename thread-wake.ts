import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

export type ThreadWakeup = {
  id: string;
  requester: string;
  requesterPid: number;
  target: string;
  targetPid: number;
  slot: string;
  after: number;
  note?: string;
};

type WakeThread = {
  session: string;
  slot: string;
  pid?: number;
  working?: boolean;
  closed?: boolean;
  settledTurns?: number;
  lastSettledPid?: number;
  lastTurnAborted?: boolean;
};
type WakeGroup = { threads: WakeThread[]; wakeups?: ThreadWakeup[] };
type Helpers<G extends WakeGroup> = {
  groupPath(): string | undefined;
  ensureGroup(ctx: ExtensionContext): Promise<string>;
  readGroup(path: string): G | undefined;
  locked<T>(path: string, fn: (group: G | undefined) => T): Promise<T>;
  writeGroup(path: string, group: G): void;
  pidAlive(pid?: number): boolean;
};
type Monitor = {
  path: string;
  session: string;
  ctx: ExtensionContext;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setInterval>;
  stopped: boolean;
  running: boolean;
  again: boolean;
};
type Delivery = { wake: ThreadWakeup; outcome: "settled" | "aborted" | "unavailable"; working: boolean };

const count = (thread: WakeThread) => Number.isSafeInteger(thread.settledTurns) && thread.settledTurns! >= 0 ? thread.settledTurns! : 0;

export function registerThreadWake<G extends WakeGroup>(pi: ExtensionAPI, helpers: Helpers<G>) {
  let active: { session: string; path?: string; ctx: ExtensionContext } | undefined;
  let monitor: Monitor | undefined;

  function stopMonitoring(state: Monitor) {
    state.stopped = true;
    state.watcher?.close();
    if (state.timer) clearInterval(state.timer);
    if (monitor === state) monitor = undefined;
  }

  function startMonitoring(path: string, session: string, ctx: ExtensionContext) {
    if (monitor && !monitor.stopped && monitor.path === path && monitor.session === session) return monitor;
    if (monitor) stopMonitoring(monitor);
    const state: Monitor = { path, session, ctx, stopped: false, running: false, again: false };
    monitor = state;
    try {
      // Registries are atomically replaced, so watch their directory rather than the old inode.
      state.watcher = watch(dirname(path), { persistent: false }, (_event, name) => {
        if (!name || name.toString() === basename(path)) schedule(state);
      });
      state.watcher.on("error", () => { state.watcher?.close(); state.watcher = undefined; });
    } catch { /* The timer below also covers unsupported or failed filesystem watches. */ }
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
    })().catch(() => { /* A later file event or timer will retry a busy registry. */ }).finally(() => {
      state.running = false;
      if (!state.stopped && state.again) schedule(state);
    });
  }

  function deliver({ wake, outcome, working }: Delivery) {
    const status = outcome === "unavailable"
      ? "stopped or closed before its turn was observed to settle"
      : outcome === "aborted" ? "settled after being aborted" : "settled";
    const current = working ? " It is already working on another turn." : "";
    const note = wake.note ? `\nYour requested follow-up: ${wake.note}` : "";
    pi.sendMessage({
      customType: "pi-threads-wake",
      content: `Thread ${wake.slot} ${status}.${current}\nSession log: ${wake.target}\nInspect the outcome before taking any previously authorized follow-up action.${note}`,
      display: true,
      details: { id: wake.id, slot: wake.slot, session: wake.target, outcome },
    }, { triggerTurn: true, deliverAs: "followUp" });
  }

  async function reconcile(state: Monitor) {
    let pending = false;
    await helpers.locked(state.path, group => {
      if (!group || state.stopped || active?.session !== state.session || active.path !== state.path) return;
      const keep: ThreadWakeup[] = [], ready: Delivery[] = [];
      let changed = false;
      for (const wake of group.wakeups || []) {
        const requester = group.threads.find(t => t.session === wake.requester);
        if (!requester || requester.closed || requester.pid !== wake.requesterPid || !helpers.pidAlive(wake.requesterPid)) { changed = true; continue; }
        if (wake.requester !== state.session || wake.requesterPid !== process.pid) { keep.push(wake); continue; }
        const target = group.threads.find(t => t.session === wake.target);
        let outcome: Delivery["outcome"] | undefined;
        if (target && count(target) > wake.after && (target.lastSettledPid === wake.targetPid || (target.lastSettledPid === undefined && target.pid === wake.targetPid))) {
          outcome = count(target) === wake.after + 1 && target.lastTurnAborted ? "aborted" : "settled";
        } else if (!target || target.closed || target.pid !== wake.targetPid || !helpers.pidAlive(wake.targetPid)) {
          outcome = "unavailable";
        } else if (!target.working) {
          // An older running extension may not yet record a settled-turn counter.
          outcome = "settled";
        }
        if (outcome) { ready.push({ wake, outcome, working: target?.working === true }); changed = true; }
        else { keep.push(wake); pending = true; }
      }
      if (changed) {
        if (keep.length) group.wakeups = keep; else delete group.wakeups;
        helpers.writeGroup(state.path, group);
      }
      // Claim and enqueue without yielding, so reload cannot drop a claimed wake-up.
      for (const delivery of ready) deliver(delivery);
    });
    if (state.stopped || active?.session !== state.session || active.path !== state.path) return;
    if (!pending) {
      stopMonitoring(state);
      // A concurrent tool call may have registered a new wait while this scan ran.
      const group = helpers.readGroup(state.path);
      if (active?.session === state.session && active.path === state.path && group?.wakeups?.some(w => w.requester === state.session && w.requesterPid === process.pid)) {
        startMonitoring(state.path, state.session, state.ctx);
      }
    }
  }

  async function clearWatches(path: string, session: string) {
    await helpers.locked(path, group => {
      if (!group?.wakeups) return;
      const keep = group.wakeups.filter(w => w.requester !== session || w.requesterPid !== process.pid);
      if (keep.length === group.wakeups.length) return;
      if (keep.length) group.wakeups = keep; else delete group.wakeups;
      helpers.writeGroup(path, group);
    });
  }

  pi.registerTool({
    name: "pi_threads_wake",
    label: "Wake on Thread Completion",
    exposure: "deferred",
    description: "Request a one-time wake-up when another thread in this group finishes its current agent turn, without keeping the tool call open. Use only for previously authorized follow-up work. The wake-up is queued if this agent is busy; the target may have failed or been aborted, so inspect its session log. An already idle target returns immediately instead of subscribing. Watches survive /reload but end when the requesting thread closes, switches sessions, or navigates its session tree.",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("watch"), Type.Literal("cancel"), Type.Literal("list")], { description: "Watch by default, cancel a slot, or list this agent's pending watches" })),
      slot: Type.Optional(Type.String({ pattern: "^[0-9]$", description: "Thread number for watch or cancel" })),
      note: Type.Optional(Type.String({ maxLength: 1000, description: "Optional reminder of the already-authorized follow-up" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") throw new Error("Thread wake-ups require an interactive Pi Threads session");
      if (signal?.aborted) throw new Error("Cancelled");
      const session = ctx.sessionManager.getSessionFile();
      if (!session) throw new Error("Thread wake-ups require a saved session");
      const action = params.action || "watch";
      if (action !== "list" && !params.slot) throw new Error("A thread slot is required");
      const path = await helpers.ensureGroup(ctx);
      if (signal?.aborted) throw new Error("Cancelled");
      if (!active || active.session !== session) throw new Error("The requesting session changed");
      active.path = path;
      const result = await helpers.locked(path, group => {
        if (!group) throw new Error("Thread group is unavailable");
        const requester = group.threads.find(t => t.session === session);
        if (!requester || requester.closed || requester.pid !== process.pid) throw new Error("The requesting thread is not active");
        const own = (group.wakeups || []).filter(w => w.requester === session && w.requesterPid === process.pid);
        if (action === "list") return { status: "list", watches: own.map(w => ({ id: w.id, slot: w.slot, session: w.target, note: w.note })) };
        if (action === "cancel") {
          const matches = own.filter(w => w.slot === params.slot);
          if (matches.length) {
            group.wakeups = (group.wakeups || []).filter(w => !matches.includes(w));
            if (!group.wakeups.length) delete group.wakeups;
            helpers.writeGroup(path, group);
          }
          return { status: matches.length ? "cancelled" : "not_found", slot: params.slot };
        }
        const target = group.threads.find(t => !t.closed && t.slot === params.slot);
        if (!target) throw new Error(`Thread ${params.slot} does not exist`);
        if (target.session === session) throw new Error("A thread cannot wait for its own turn");
        const existing = own.find(w => w.target === target.session);
        if (existing) return { status: "waiting", id: existing.id, slot: existing.slot, session: existing.target, alreadyWatching: true };
        if (!target.pid || !helpers.pidAlive(target.pid)) throw new Error(`Thread ${params.slot} is not running`);
        if (!target.working) return { status: "already_idle", slot: params.slot, session: target.session };
        const wake: ThreadWakeup = { id: randomUUID(), requester: session, requesterPid: process.pid, target: target.session, targetPid: target.pid, slot: target.slot, after: count(target), ...(params.note ? { note: params.note } : {}) };
        (group.wakeups ||= []).push(wake);
        helpers.writeGroup(path, group);
        return { status: "waiting", id: wake.id, slot: wake.slot, session: wake.target, alreadyWatching: false };
      });
      if (result.status === "waiting") {
        const state = startMonitoring(path, session, ctx);
        schedule(state);
      } else if (monitor?.session === session) schedule(monitor);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const session = ctx.sessionManager.getSessionFile();
    if (!session) return;
    const path = helpers.groupPath();
    active = { session, path, ctx };
    const group = path && helpers.readGroup(path);
    if (path && group?.wakeups?.some(w => w.requester === session && w.requesterPid === process.pid)) startMonitoring(path, session, ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    const current = active;
    if (!current?.path || ctx.sessionManager.getSessionFile() !== current.session) return;
    if (monitor) stopMonitoring(monitor);
    try { await clearWatches(current.path, current.session); } catch { /* A tree change must not be blocked by notification cleanup. */ }
  });

  pi.on("session_shutdown", async (event) => {
    const previous = active;
    active = undefined;
    if (monitor) stopMonitoring(monitor);
    if (!previous?.path || event.reason === "reload") return;
    try { await clearWatches(previous.path, previous.session); } catch { /* Shutdown must not be blocked by notification cleanup. */ }
  });
}
