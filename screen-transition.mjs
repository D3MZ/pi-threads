import { stripVTControlCharacters } from "node:util";

const beginSync = "\x1b[?2026h";
const endSync = "\x1b[?2026l";
export const maxStartupChars = 8 * 1024 * 1024;

// PTY reads can split a synchronized redraw at any byte. Ignore incremental
// frames until the requested full redraw has arrived in its entirety.
class ScreenFrame {
  constructor(requireClear) {
    this.requireClear = requireClear;
    this.pending = "";
    this.prefix = "";
  }
  append(data) {
    this.pending += data;
    for (;;) {
      const start = this.pending.indexOf(beginSync);
      if (start < 0) return;
      const end = this.pending.indexOf(endSync, start + beginSync.length);
      if (end < 0) return;
      const frameEnd = end + endSync.length;
      const frame = this.pending.slice(start, frameEnd);
      // The capture can begin in the middle of an older frame. Do not let
      // its trailing sync marker expose that partial frame before the redraw.
      this.prefix += this.pending.slice(0, start).replaceAll(endSync, "");
      this.pending = this.pending.slice(frameEnd);
      if (!this.requireClear || frame.includes("\x1b[2J")) return this.prefix + frame + this.pending;
    }
  }
  get size() { return this.prefix.length + this.pending.length; }
}

function hasVisibleOutput(data) {
  return /[^\s\x00-\x1f\x7f]/u.test(stripVTControlCharacters(data));
}

export class ScreenTransition {
  constructor(mux) { this.mux = mux; this.pending = undefined; }
  modes() {
    return `\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h${this.mux.ui.terminal.kittyProtocolActive ? "\x1b[=31u" : ""}`;
  }
  inputTarget() { return this.pending ? this.pending.child : this.mux.active; }
  cancel() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.fallbackTimer); clearTimeout(pending.deadlineTimer);
    pending.dataListener?.dispose(); pending.exitListener?.dispose();
    pending.resolve?.(false);
  }
  show(child) {
    this.cancel();
    if (this.mux.active === child) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const pending = { child, resolve, frame: undefined, fallback: false };
      this.pending = pending;
      const finish = (data, fullFrame) => {
        if (this.pending !== pending) return;
        this.pending = undefined;
        clearTimeout(pending.fallbackTimer); clearTimeout(pending.deadlineTimer);
        pending.dataListener?.dispose(); pending.exitListener?.dispose();
        this.mux.active = child;
        child.screenStartup = undefined;
        // The forced frame already clears the screen inside its synchronized
        // update. Startup output may instead be a pre-session prompt.
        this.mux.write(`${beginSync}${this.modes()}${fullFrame ? "" : "\x1b[2J\x1b[H"}${data}${fullFrame ? "" : endSync}`);
        if (!fullFrame && child.socket) this.mux.activate(child);
        resolve(true);
      };
      const fail = error => {
        if (this.pending !== pending) return;
        this.pending = undefined;
        clearTimeout(pending.fallbackTimer); clearTimeout(pending.deadlineTimer);
        pending.dataListener?.dispose(); pending.exitListener?.dispose();
        reject(error);
      };
      const fallback = () => {
        if (this.pending !== pending) return;
        const startup = child.screenStartup;
        if (typeof startup !== "string" || !hasVisibleOutput(startup)) return;
        if (pending.fallback) finish(startup, false);
        else if (!pending.fallbackTimer) {
          // A process can take time to launch before it has anything to show.
          // Give its first screen time to finish, but expose blocking prompts.
          pending.fallbackTimer = setTimeout(() => { pending.fallback = true; fallback(); }, 1500);
        }
      };
      pending.dataListener = child.pty.onData(data => {
        if (this.pending !== pending) return;
        if (pending.frame) {
          const frame = pending.frame.append(data);
          if (frame !== undefined) { finish(frame, true); return; }
          if (pending.frame.size > maxStartupChars) pending.fallback = true;
        }
        fallback();
        if (this.pending === pending && pending.frame?.size > maxStartupChars * 8) fail(new Error("Thread redraw exceeded the transition buffer"));
      });
      pending.exitListener = child.pty.onExit(event => fail(new Error(`Pi thread exited (${event.signal || event.exitCode})`)));
      pending.deadlineTimer = setTimeout(() => fail(new Error("Pi thread did not start within 2 minutes")), 120000);
      fallback();
      child.ready.then(() => this.connected(child), fail);
    });
  }
  connected(child) {
    const pending = this.pending;
    if (!pending || pending.child !== child || !child.socket || child.screenReady === false || pending.frame) return;
    pending.frame = new ScreenFrame(true);
    this.mux.activate(child);
  }
  resize() {
    const pending = this.pending;
    if (!pending?.child || !pending.frame) return;
    pending.frame = undefined;
    this.connected(pending.child);
  }
  showMain() {
    this.cancel();
    if (!this.mux.active) { this.mux.ui.requestRender(true); return; }
    const pending = { child: undefined, frame: new ScreenFrame(false) };
    this.pending = pending;
    pending.fallbackTimer = setTimeout(() => {
      if (this.pending !== pending) return;
      this.pending = undefined;
      this.mux.active = undefined;
      this.mux.write(`${this.modes()}\x1b[2J\x1b[H`);
      this.mux.ui.requestRender(true);
    }, 1500);
    this.mux.ui.requestRender(true);
  }
  hostOutput(data) {
    const pending = this.pending;
    if (!pending || pending.child) return false;
    const frame = pending.frame.append(data);
    if (frame !== undefined) {
      this.pending = undefined;
      clearTimeout(pending.fallbackTimer);
      this.mux.active = undefined;
      this.mux.write(`${beginSync}${this.modes()}\x1b[2J\x1b[H${frame}`);
    }
    return true;
  }
}
