import { createRequire } from "node:module";
import { createServer, createConnection } from "node:net";
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);

function preparePty() {
  if (process.platform !== "win32") {
    const root = dirname(require.resolve("node-pty/package.json"));
    for (const helper of [join(root, "build/Release/spawn-helper"), join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")]) {
      if (!existsSync(helper)) continue;
      try { accessSync(helper, constants.X_OK); }
      catch {
        try { chmodSync(helper, statSync(helper).mode | 0o111); }
        catch { throw new Error(`node-pty spawn helper is not executable: ${helper}`); }
      }
    }
  }
  return require("node-pty");
}

// Each child is a real interactive Pi in its own PTY. Only the selected PTY
// owns the physical terminal; background Pi instances continue rendering into
// their own PTYs and are asked for a complete repaint when selected again.
export class TerminalMux {
  constructor({ ui, onSwitch, onExit, onRebind, getAppearance, isFocused, onChildInput, isPrefixHeld }) {
    this.ui = ui;
    this.onSwitch = onSwitch;
    this.onExit = onExit;
    this.onRebind = onRebind;
    this.getAppearance = getAppearance;
    this.isFocused = isFocused;
    this.onChildInput = onChildInput;
    this.isPrefixHeld = isPrefixHeld;
    this.children = new Map();
    this.active = undefined;
    this.dir = mkdtempSync(join(tmpdir(), "pi-threads-"));
    this.path = process.platform === "win32"
      ? `\\\\.\\pipe\\pi-chatthreads-${process.pid}-${randomBytes(12).toString("hex")}`
      : join(this.dir, "s");
    this.server = createServer(socket => this.accept(socket));
    this.ready = new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, () => { this.server.off("error", reject); resolve(); });
    });
    this.server.unref();
    this.output = process.stdout.write;
    this.owner = this;
    const mux = this;
    this.outputWrapper = function (chunk, encoding, callback) {
      if (!mux.active) return mux.output.apply(this, arguments);
      const done = typeof encoding === "function" ? encoding : callback;
      if (done) process.nextTick(done);
      return true;
    };
    process.stdout.write = this.outputWrapper;
    this.onResize = () => {
      const cols = Math.max(1, this.ui.terminal.columns), rows = Math.max(1, this.ui.terminal.rows);
      for (const child of this.children.values()) {
        try { child.pty.resize(cols, rows); } catch {}
      }
    };
    process.stdout.on("resize", this.onResize);
  }
  bind(ui, onSwitch, onExit, getAppearance, isFocused, onChildInput, isPrefixHeld, onRebind) {
    this.ui = ui; this.onSwitch = onSwitch; this.onExit = onExit; this.onRebind = onRebind; this.getAppearance = getAppearance; this.isFocused = isFocused;
    this.onChildInput = onChildInput; this.isPrefixHeld = isPrefixHeld;
  }
  write(data) { this.output.call(process.stdout, data); }
  accept(socket) {
    socket.setEncoding("utf8");
    let buffer = "", child, handshake = Promise.resolve();
    socket.on("data", data => {
      buffer += data;
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      for (;;) {
        const i = buffer.indexOf("\n");
        if (i < 0) break;
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        let message; try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!child) {
          child = [...this.children.values()].find(c => c.token === message.token);
          if (!child || message.type !== "hello" || typeof message.session !== "string" || !message.session) { socket.destroy(); return; }
          const previous = child.session;
          const attach = () => {
            if (socket.destroyed) throw new Error("Thread connection closed");
            child.socket?.destroy(); child.socket = socket;
            child.resolveReady();
            this.send(child, { type: "ready" });
            if (this.active === child) this.activate(child);
          };
          if (message.session === previous) attach();
          else {
            // A child disconnected by an older version can recover on reload:
            // its private token still identifies the manager's original slot.
            const recovering = message.reason === "recover" && message.previousSession === undefined;
            if ((!recovering && message.previousSession !== previous) || !this.onRebind || this.children.has(message.session)) { socket.destroy(); return; }
            const current = () => !socket.destroyed && this.children.get(previous) === child;
            handshake = Promise.resolve().then(() => this.onRebind(previous, message.session, child, message, current)).then(() => {
              if (!current() || this.children.has(message.session)) throw new Error("Thread changed during session replacement");
              this.children.delete(previous);
              child.session = message.session;
              child.unpersistedHeader = message.header?.type === "session" && typeof message.header.id === "string" ? message.header : undefined;
              this.children.set(child.session, child);
              // A child started before a host reload has the old exit handler,
              // which only knew its original session path.
              if (!child.dynamicExit) {
                child.dynamicExit = true;
                child.pty.onExit(event => this.handleExit(child, event));
              }
              attach();
            }).catch(error => {
              if (!socket.destroyed) socket.end(`${JSON.stringify({ type: "ready", error: error instanceof Error ? error.message : String(error) })}\n`);
              throw error;
            });
            handshake.catch(() => {});
          }
        } else if (message.type === "switch" && typeof message.slot === "string") {
          handshake.then(() => this.onSwitch(message.slot)).then(
            () => this.send(child, { type: "response", id: message.id }),
            e => this.send(child, { type: "response", id: message.id, error: e instanceof Error ? e.message : String(e) }),
          );
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => { if (child?.socket === socket) child.socket = undefined; });
  }
  send(child, message) { if (child.socket && !child.socket.destroyed) child.socket.write(`${JSON.stringify(message)}\n`); }
  async start({ session, executable, args, cwd, env }) {
    await this.ready;
    const old = this.children.get(session);
    if (old) { await old.ready; return old; }
    const token = randomBytes(24).toString("hex");
    const childEnv = { ...env, PI_CHATTHREADS_SOCKET: this.path, PI_CHATTHREADS_TOKEN: token };
    const pty = preparePty().spawn(executable, args, {
      cwd, env: childEnv, name: process.env.TERM || "xterm-256color",
      cols: Math.max(1, this.ui.terminal.columns), rows: Math.max(1, this.ui.terminal.rows),
    });
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => {});
    const child = { session, token, pty, ready, resolveReady, rejectReady, socket: undefined, startup: "", negotiated: false, pendingInput: [], dynamicExit: true };
    this.children.set(session, child);
    pty.onData(data => {
      if (!child.negotiated) {
        const startup = child.startup + data;
        if (startup.includes("\x1b[?u")) {
          child.negotiated = true;
          child.startup = "";
          // Pi enters raw mode before issuing this query. Until then, the PTY
          // echoes input (including Ghostty's key-release escape sequences).
          // Reply to the query first, then deliver any input received during startup.
          const response = this.ui.terminal.kittyProtocolActive ? "\x1b[?7u\x1b[?1;2c" : "\x1b[?1;2c";
          pty.write(response);
          for (const input of child.pendingInput) pty.write(input);
          child.pendingInput = [];
        } else {
          // Retain only a possible split query prefix; check the full chunk above.
          child.startup = startup.slice(-4);
        }
      }
      if (this.active === child) this.write(data);
    });
    pty.onExit(event => this.handleExit(child, event));
    return child;
  }
  handleExit(child, event) {
    const currentSession = child.session;
    if (this.children.get(currentSession) !== child) return;
    this.children.delete(currentSession); child.socket?.destroy();
    child.rejectReady(new Error(`Pi thread exited (${event.signal || event.exitCode})`));
    const wasActive = this.active === child;
    if (wasActive) this.showMain();
    this.onExit?.(currentSession, child.pty.pid, wasActive, child.unpersistedHeader);
  }
  async show(child) {
    if (!this.inputWrapper) {
      const terminal = this.ui.terminal;
      if (typeof terminal.inputHandler !== "function") throw new Error("Pi terminal input is not ready");
      this.terminal = terminal;
      this.input = terminal.inputHandler;
      this.inputWrapper = data => {
        const child = this.active;
        if (!child) this.input(data);
        else {
          // The host tracks physical focus and the held modifier while the
          // child owns input, so a newly activated thread inherits that state.
          if (this.onChildInput?.(data)) this.send(child, { type: "modifier", prefixHeld: this.isPrefixHeld?.() === true });
          if (data === "\x1b[I" || data === "\x1b[O") this.input(data);
          if (child.negotiated) child.pty.write(data);
          else child.pendingInput.push(data);
        }
      };
      terminal.inputHandler = this.inputWrapper;
    }
    this.active = child;
    this.onResize();
    // Ensure both applications see the same physical screen and key mode.
    this.write(`\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h${this.ui.terminal.kittyProtocolActive ? "\x1b[=31u" : ""}\x1b[2J\x1b[H`);
    if (child.socket) this.activate(child);
    let timer;
    try {
      await Promise.race([child.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Pi thread did not start within 2 minutes")), 120000); })]);
    } finally { clearTimeout(timer); }
  }
  activate(child) { this.send(child, { type: "activate", appearance: this.getAppearance?.(), focused: this.isFocused?.() !== false, prefixHeld: this.isPrefixHeld?.() === true }); }
  showMain() {
    this.active = undefined;
    this.write(`\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h${this.ui.terminal.kittyProtocolActive ? "\x1b[=31u" : ""}\x1b[2J\x1b[H`);
    this.ui.requestRender(true);
  }
  stop(session) {
    const child = this.children.get(session);
    if (child) child.pty.kill();
  }
  detachInput() {
    if (this.terminal && this.terminal.inputHandler === this.inputWrapper) this.terminal.inputHandler = this.input;
    this.terminal = undefined; this.input = undefined; this.inputWrapper = undefined;
  }
  dispose() {
    this.active = undefined;
    for (const child of this.children.values()) { try { child.pty.kill(); } catch {} child.socket?.destroy(); }
    this.children.clear();
    this.detachInput();
    if (process.stdout.write === this.outputWrapper) process.stdout.write = this.output;
    process.stdout.off("resize", this.onResize);
    this.server.close();
    try { rmSync(this.dir, { recursive: true, force: true }); } catch {}
  }
}

export function connectThread({ path, token, session, previousSession, reason, header, initialModel, onActivate, onModifier }) {
  const socket = createConnection(path);
  socket.setEncoding("utf8");
  let buffer = "", nextId = 0, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const pending = new Map();
  socket.on("data", data => {
    buffer += data;
    for (;;) {
      const i = buffer.indexOf("\n"); if (i < 0) break;
      let message; try { message = JSON.parse(buffer.slice(0, i)); } catch { socket.destroy(); return; }
      buffer = buffer.slice(i + 1);
      if (message.type === "ready") message.error ? rejectReady(new Error(message.error)) : resolveReady();
      else if (message.type === "activate") onActivate(message.appearance, message.focused, message.prefixHeld);
      else if (message.type === "modifier") onModifier?.(message.prefixHeld);
      else if (message.type === "response") {
        const request = pending.get(message.id);
        if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(); }
      }
    }
  });
  const fail = error => { rejectReady(error); for (const request of pending.values()) request.reject(error); pending.clear(); };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Thread manager disconnected")));
  // Queue the handshake before a shortcut can enqueue a switch on a socket
  // that is still connecting; the server requires hello to arrive first.
  socket.write(`${JSON.stringify({ type: "hello", token, session, previousSession, reason, header, initialModel })}\n`);
  return {
    ready,
    switch(slot) {
      if (socket.destroyed) return Promise.reject(new Error("Thread manager disconnected"));
      const id = ++nextId;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.write(`${JSON.stringify({ type: "switch", id, slot })}\n`); });
    },
    close() { socket.destroy(); },
  };
}
