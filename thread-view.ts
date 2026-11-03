import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, SelectList, matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ThreadClient } from "./thread-client.mjs";

type Dialog = { id: string; method: string; title?: string; message?: string; options?: string[]; placeholder?: string; prefill?: string };

// A Pi overlay, not a second terminal or a terminal window. The RPC agent keeps
// running when this component is closed or another thread is selected.
export function openThreadView(ctx: ExtensionContext, client: ThreadClient, title: string, legend: () => string, back: () => void, switchTo: (slot: string) => void) {
  let closeComponent: (() => void) | undefined;
  let rerender: (() => void) | undefined;
  let preview = false;
  let closeRequested = false;
  const promise = ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let closed = false;
    let scroll = 0;
    let currentDialog: Dialog | undefined;
    let select: SelectList | undefined;
    let dialogEditor: Editor | undefined;
    const editorTheme = {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (s: string) => theme.fg("accent", s),
        selectedText: (s: string) => theme.fg("accent", s),
        description: (s: string) => theme.fg("muted", s),
        scrollInfo: (s: string) => theme.fg("dim", s),
        noMatch: (s: string) => theme.fg("warning", s),
      },
    };
    const editor = new Editor(tui, editorTheme);
    editor.setText((client as any).draft || "");
    editor.onChange = text => { (client as any).draft = text; };
    editor.onSubmit = text => {
      if (!text.trim()) return;
      const switchCommand = /^\/(?:threads|chatthread)\s+([0-9])\s*$/i.exec(text);
      if (switchCommand) { switchTo(switchCommand[1]); return; }
      if (client.state !== "ready") { editor.setText(text); return; }
      void client.prompt(text).then(() => tui.requestRender(), error => {
        if (!editor.getText()) editor.setText(text);
        ctx.ui.notify(`Thread: ${error.message}`, "error");
        tui.requestRender();
      });
    };
    function answer(response: Record<string, unknown>) {
      if (!currentDialog) return;
      try { client.respond(currentDialog.id, response); }
      catch (error) { ctx.ui.notify(`Thread: ${error instanceof Error ? error.message : String(error)}`, "error"); }
      currentDialog = undefined; select = undefined; dialogEditor = undefined;
      tui.requestRender();
    }
    function updateDialog() {
      const next = client.dialogs[0] as Dialog | undefined;
      if (next?.id === currentDialog?.id) return;
      currentDialog = next; select = undefined; dialogEditor = undefined;
      if (!next) return;
      if (next.method === "select" || next.method === "confirm") {
        const choices = next.method === "confirm" ? ["No", "Yes"] : next.options || [];
        select = new SelectList(choices.map(value => ({ value, label: value })), 8, editorTheme.selectList);
        select.onSelect = item => answer(next.method === "confirm" ? { confirmed: item.value === "Yes" } : { value: item.value });
        select.onCancel = () => answer({ cancelled: true });
      } else {
        dialogEditor = new Editor(tui, editorTheme);
        dialogEditor.focused = editor.focused;
        dialogEditor.setText(next.prefill || "");
        dialogEditor.onSubmit = text => answer({ value: text });
      }
    }
    const unsubscribe = client.onChange(() => { updateDialog(); tui.requestRender(); });
    function close() { if (!closed) { closed = true; unsubscribe(); done(); } }
    closeComponent = close;
    rerender = () => tui.requestRender();
    updateDialog();
    if (closeRequested) queueMicrotask(close);
    return {
      get focused() { return editor.focused; },
      set focused(value: boolean) { editor.focused = value; if (dialogEditor) dialogEditor.focused = value; },
      invalidate() { editor.invalidate(); select?.invalidate(); dialogEditor?.invalidate(); },
      dispose() { closed = true; unsubscribe(); },
      handleInput(data: string) {
        if (currentDialog) {
          if (select) select.handleInput(data);
          else if (matchesKey(data, "escape")) answer({ cancelled: true });
          else dialogEditor?.handleInput(data);
        } else if (matchesKey(data, "escape")) { back(); }
        else if (matchesKey(data, "pageUp")) { scroll += Math.max(1, tui.terminal.rows - 8); }
        else if (matchesKey(data, "pageDown")) { scroll = Math.max(0, scroll - Math.max(1, tui.terminal.rows - 8)); }
        else if (matchesKey(data, "ctrl+c") && client.busy) { void client.request("abort").catch(error => ctx.ui.notify(error.message, "error")); }
        else editor.handleInput(data);
        tui.requestRender();
      },
      render(width: number) {
        const w = Math.max(1, width);
        const rows = Math.max(4, tui.terminal.rows);
        const lines: string[] = [];
        const append = (text: string) => lines.push(...wrapTextWithAnsi(stripTerminalSequences(text), w));
        for (const message of client.messages.slice(-200)) {
          const role = message.role;
          if (!["user", "assistant", "toolResult", "custom"].includes(role)) continue;
          const body = typeof message.content === "string" ? message.content : (message.content || []).map((block: any) =>
            block.type === "text" ? block.text : block.type === "image" ? "[image]" : block.type === "toolCall" ? `[${block.name}]` : "").filter(Boolean).join("\n");
          const content = [body, message.errorMessage ? `Error: ${message.errorMessage}` : ""].filter(Boolean).join("\n");
          if (!content) continue;
          append(`${role === "user" ? "You" : role === "assistant" ? "Pi" : message.toolName || role}: ${content}`);
          lines.push("");
        }
        if (client.partial?.length) append(`Pi: ${client.partial.join("")}`);
        const bottom = currentDialog
          ? [theme.fg("warning", `${currentDialog.title || "Thread request"}${currentDialog.message ? `: ${currentDialog.message}` : ""}`), ...(select?.render(w) || dialogEditor?.render(w) || [])]
          : editor.render(w);
        const header = truncateToWidth(theme.fg("accent", `↳ ${title} ${client.busy ? "· working" : client.state === "closed" ? `· stopped: ${client.error?.message || "process exited"}` : ""}${client.notice ? ` · ${client.notice.text}` : ""}`), w);
        const hint = truncateToWidth(theme.fg("dim", "Esc: main · /threads N: switch · PgUp/PgDn: scroll · Ctrl+C: abort"), w);
        const available = Math.max(0, rows - bottom.length - (preview ? 3 : 2));
        const end = Math.max(0, lines.length - scroll);
        const visible = lines.slice(Math.max(0, end - available), end);
        while (visible.length < available) visible.unshift("");
        return [header, ...(preview ? [theme.fg("accent", legend())] : []), ...visible, ...bottom, hint].slice(0, rows).map(line => truncateToWidth(line, w));
      },
    };
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });
  return { close: () => { closeRequested = true; closeComponent?.(); }, setPreview: (value: boolean) => { preview = value; rerender?.(); }, promise };
}
