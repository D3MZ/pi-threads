import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

const maxTextBytes = 8000;
const maxPending = 16;
const slotPattern = /^[0-9]$/;

export type ThreadFollowUp = {
  id: string;
  senderSlot: string;
  targetSession: string;
  targetPid: number;
  text: string;
};

type Thread = { slot: string; session: string; pid?: number; closed?: boolean; followUpPid?: number };
type Group = { threads: Thread[]; followUps?: ThreadFollowUp[] };
type Helpers<G> = {
  groupPath(): string | undefined;
  readGroup(path: string): G | undefined;
  locked<T>(path: string, fn: (group: G | undefined) => T): Promise<T>;
  writeGroup(path: string, group: G): void;
  pidAlive(pid?: number): boolean;
};

type Inbox = {
  path: string;
  session: string;
  ctx: ExtensionContext;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setInterval>;
  reading?: boolean;
};

export function pruneThreadFollowUps(group: Group) {
  if (!group.followUps) return;
  const keep = group.followUps.filter(message => group.threads.some(thread =>
    !thread.closed && thread.session === message.targetSession && thread.pid === message.targetPid));
  if (keep.length) group.followUps = keep;
  else delete group.followUps;
}

export function registerThreadFollowUp<G extends Group>(pi: ExtensionAPI, helpers: Helpers<G>) {
  let inbox: Inbox | undefined;

  function stop() {
    const old = inbox;
    inbox = undefined;
    old?.watcher?.close();
    if (old?.timer) clearInterval(old.timer);
  }

  function receive(state: Inbox) {
    const { path, session, ctx } = state;
    const canReceive = () => inbox === state && helpers.groupPath() === path
      && ctx.sessionManager.getSessionFile() === session && ctx.isIdle() && !ctx.hasPendingMessages();
    if (state.reading || !canReceive()) return;
    const addressedHere = (message: ThreadFollowUp) => message.targetSession === session && message.targetPid === process.pid;
    if (!helpers.readGroup(path)?.followUps?.some(addressedHere)) return;
    state.reading = true;
    void helpers.locked(path, group => {
      if (!group || !canReceive() || !group.threads.some(thread =>
        !thread.closed && thread.session === session && thread.pid === process.pid && thread.followUpPid === process.pid)) return;
      const pending = group.followUps;
      const index = pending?.findIndex(addressedHere) ?? -1;
      if (!pending || index < 0) return;
      const [message] = pending.splice(index, 1);
      if (!pending.length) delete group.followUps;
      // Claim and submit in the same synchronous callback. The native agent
      // queue is only used if another input made Pi busy in the meantime.
      helpers.writeGroup(path, group);
      pi.sendMessage({
        customType: "pi-threads-follow-up",
        content: `User-approved follow-up from Pi thread ${message.senderSlot}:\n\n${message.text}`,
        display: true,
        details: { id: message.id, senderSlot: message.senderSlot },
      }, { triggerTurn: true, deliverAs: "followUp" });
    }).catch(error => {
      if (inbox === state) ctx.ui.notify(`Could not receive thread follow-up: ${String(error)}`, "warning");
    }).finally(() => { state.reading = false; });
  }

  function listen(path: string, ctx: ExtensionContext) {
    const session = ctx.sessionManager.getSessionFile();
    if (!session || (inbox?.path === path && inbox.session === session && inbox.ctx === ctx)) return;
    stop();
    const state: Inbox = { path, session, ctx };
    inbox = state;
    try {
      // The registry is atomically replaced; a watch on its inode goes stale.
      state.watcher = watch(dirname(path), { persistent: false }, (_event, name) => {
        if (!name || name.toString() === basename(path)) receive(state);
      });
      state.watcher.on("error", () => { state.watcher?.close(); state.watcher = undefined; });
    } catch { /* The timer also covers filesystems without change notification. */ }
    state.timer = setInterval(() => receive(state), 2500);
    state.timer.unref();
    setImmediate(() => receive(state)).unref();
  }

  function resolveRoute(group: G | undefined, session: string, slot: string) {
    const sender = group?.threads.find(thread => !thread.closed && thread.session === session && thread.pid === process.pid);
    if (!sender) throw new Error("The sending thread is no longer registered.");
    const target = group?.threads.find(thread => !thread.closed && thread.slot === slot);
    if (!target) throw new Error(`Thread ${slot} is not open in this group.`);
    if (target.session === sender.session) throw new Error("Enter the follow-up directly in the current thread.");
    if (!target.pid || !helpers.pidAlive(target.pid)) throw new Error(`Thread ${slot} is not running.`);
    if (target.followUpPid !== target.pid) throw new Error(`Thread ${slot} does not support follow-ups yet. Reload that thread and try again.`);
    return { senderSlot: sender.slot, targetSession: target.session, targetPid: target.pid };
  }

  async function relay(ctx: ExtensionContext, slot: string, text: string, confirm: boolean, signal?: AbortSignal) {
    if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Thread follow-ups require an interactive Pi Threads session.");
    if (!slotPattern.test(slot)) throw new Error("Expected a numbered thread slot.");
    if (signal?.aborted) throw new Error("The request was cancelled.");
    text = text.replace(/\r\n?/g, "\n").trim();
    if (!text || Buffer.byteLength(text, "utf8") > maxTextBytes || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) {
      throw new Error(`Enter a plain-text message of at most ${maxTextBytes} bytes.`);
    }
    const path = helpers.groupPath(), session = ctx.sessionManager.getSessionFile();
    if (!path || !session) throw new Error("No other open threads are registered in this session.");
    const route = resolveRoute(helpers.readGroup(path), session, slot);
    if (confirm && !await ctx.ui.confirm(`Send a follow-up to thread ${slot}?`, text, { signal })) return undefined;
    return helpers.locked(path, group => {
      if (signal?.aborted || helpers.groupPath() !== path || ctx.sessionManager.getSessionFile() !== session) {
        throw new Error("The sending session changed or the request was cancelled.");
      }
      if (!group) throw new Error("Thread group is unavailable.");
      const current = resolveRoute(group, session, slot);
      if (current.targetSession !== route.targetSession || current.targetPid !== route.targetPid) {
        throw new Error(`Thread ${slot} changed before the message could be sent.`);
      }
      if ((group.followUps?.length ?? 0) >= maxPending) throw new Error("The thread group's follow-up queue is full.");
      const id = randomUUID();
      (group.followUps ||= []).push({ id, ...current, text });
      helpers.writeGroup(path, group);
      return { id, slot };
    });
  }

  pi.registerCommand("thread-send", {
    description: "Send a follow-up to an open thread: /thread-send <slot> <message>",
    handler: async (args, ctx) => {
      const match = /^([0-9])\s+([\s\S]+)$/.exec(args.trim());
      if (!match) { ctx.ui.notify("Usage: /thread-send <slot> <message>", "warning"); return; }
      try {
        const result = await relay(ctx, match[1], match[2], false);
        if (result) ctx.ui.notify(`Follow-up queued for thread ${result.slot}.`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });

  pi.registerTool({
    name: "pi_threads_send",
    label: "Send a thread follow-up",
    description: "Relay an explicitly requested user follow-up to an existing open Pi thread in this group. The user must approve the exact message. It starts on an idle thread or waits for its current work. Does not spawn or switch threads. Do not use for general agent-to-agent chat.",
    parameters: Type.Object({
      slot: Type.String({ pattern: slotPattern.source, description: "The destination thread's numbered slot." }),
      message: Type.String({ minLength: 1, maxLength: maxTextBytes, description: "The exact text to show the user for approval and relay." }),
    }, { additionalProperties: false }),
    async execute(_id, { slot, message }, signal, _update, ctx) {
      const result = await relay(ctx, slot, message, true, signal);
      return result
        ? { content: [{ type: "text", text: `Follow-up queued for thread ${slot}; it will run when that thread is idle.` }], details: { status: "queued", ...result } }
        : { content: [{ type: "text", text: "Not sent: the user did not approve the message." }], details: { status: "declined", slot } };
    },
  });

  pi.on("agent_settled", () => { if (inbox) receive(inbox); });
  return { listen, stop };
}
