import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// A thread owns its session file. No two clients may open the same file for writing.
export class ThreadClient {
  constructor({ executable = "pi", args = [], cwd, env = process.env, spawnProcess = spawn }) {
    this.process = spawnProcess(executable, ["--mode", "rpc", ...args], {
      cwd, env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.messages = [];
    this.partial = undefined;
    this.busy = false;
    this.dialogs = [];
    this.dialogTimers = new Map();
    this.stderr = "";
    this.state = "starting";
    this.listeners = new Set();
    this.pending = new Map();
    this.nextId = 0;
    this.stdoutBuffer = "";
    const decoder = new StringDecoder("utf8");
    this.process.stdin.on("error", error => this.closed(error));
    this.process.stdout.on("data", chunk => this.consume(decoder.write(chunk)));
    this.process.stdout.on("end", () => {
      this.consume(decoder.end());
      if (this.stdoutBuffer) this.line(this.stdoutBuffer);
      this.stdoutBuffer = "";
    });
    this.process.stderr.on("data", chunk => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-16384);
    });
    this.process.on("error", error => this.closed(error));
    this.process.on("close", (code, signal) => this.closed(new Error(`Thread process exited (${signal || code})${this.stderr ? `: ${this.stderr.trim()}` : ""}`)));
  }
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed() { for (const listener of this.listeners) listener(); }
  consume(text) {
    this.stdoutBuffer += text;
    for (;;) {
      const index = this.stdoutBuffer.indexOf("\n");
      if (index < 0) break;
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      this.line(line);
    }
  }
  line(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "response" && event.id) {
      const pending = this.pending.get(event.id);
      if (pending) {
        this.pending.delete(event.id);
        if (event.success) pending.resolve(event.data);
        else pending.reject(new Error(event.error || `${event.command} failed`));
      }
    } else if (event.type === "agent_start") {
      this.busy = true;
    } else if (event.type === "agent_settled") {
      this.busy = false;
    } else if (event.type === "message_start" && event.message?.role === "assistant") {
      this.partial = [];
    } else if (event.type === "message_update" && this.partial) {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_delta") this.partial[update.contentIndex] = (this.partial[update.contentIndex] || "") + update.delta;
      if (update?.type === "text_end") this.partial[update.contentIndex] = update.content;
    } else if (event.type === "message_end") {
      if (event.message?.role === "assistant") this.partial = undefined;
      if (event.message) this.messages.push(event.message);
    } else if (event.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(event.method)) {
        this.dialogs.push(event);
        if (Number.isFinite(event.timeout) && event.timeout > 0) {
          const timer = setTimeout(() => {
            this.dialogTimers.delete(event.id);
            this.dialogs = this.dialogs.filter(dialog => dialog.id !== event.id);
            this.changed();
          }, event.timeout);
          timer.unref();
          this.dialogTimers.set(event.id, timer);
        }
      } else if (event.method === "notify") this.notice = { text: event.message, type: event.notifyType };
    } else if (event.type === "extension_error") {
      this.notice = { text: event.error || "Extension error", type: "error" };
    }
    this.changed();
  }
  closed(error) {
    if (this.state === "closed") return;
    this.state = "closed";
    this.busy = false;
    this.error = error;
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    this.dialogTimers.clear();
    this.dialogs = [];
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.changed();
  }
  send(record) {
    if (this.state === "closed" || !this.process.stdin.writable) throw this.error || new Error("Thread process is not running");
    this.process.stdin.write(`${JSON.stringify(record)}\n`);
  }
  request(type, fields = {}) {
    const id = `thread-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ id, type, ...fields }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async start() {
    const [state, history] = await Promise.all([this.request("get_state"), this.request("get_messages")]);
    this.messages = history?.messages || [];
    this.busy = !!state?.isStreaming || !!state?.isCompacting;
    this.state = "ready";
    this.changed();
    return state;
  }
  prompt(message, images) {
    return this.request("prompt", { message, ...(images?.length ? { images } : {}), ...(this.busy ? { streamingBehavior: "followUp" } : {}) });
  }
  respond(id, response) {
    this.send({ type: "extension_ui_response", id, ...response });
    const timer = this.dialogTimers.get(id);
    if (timer) clearTimeout(timer);
    this.dialogTimers.delete(id);
    this.dialogs = this.dialogs.filter(dialog => dialog.id !== id);
    this.changed();
  }
  stop() { if (this.state !== "closed") this.process.stdin.end(); }
}
