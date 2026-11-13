import { DynamicBorder, getAgentDir, getSettingsListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, SettingsList, Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const settingsDir = join(getAgentDir(), "pi-threads");
const settingsPath = join(settingsDir, "settings.json");

export function threadsEnabled() {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8")).enabled !== false;
  } catch {
    return true;
  }
}

export function autoThreadingEnabled() {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8")).autoThreading === true;
  } catch {
    return false;
  }
}

export function autoThreadingTime() {
  try {
    const time = JSON.parse(readFileSync(settingsPath, "utf8")).time;
    return typeof time === "string" ? time : "5 minutes";
  } catch {
    return "5 minutes";
  }
}

function saveThreadSetting(key: "enabled" | "autoThreading" | "time", value: boolean | string) {
  let settings: Record<string, unknown> = {};
  try {
    const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (saved && typeof saved === "object" && !Array.isArray(saved)) settings = saved;
  } catch { /* Start with the defaults. */ }
  settings[key] = value;
  mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
  const temporary = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, settingsPath);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

export async function showThreadSettings(ctx: ExtensionContext, actions: {
  enabledChanged(): void;
  keybindings(): Promise<void>;
  threads(): Promise<void>;
}) {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Thread settings require interactive mode", "error");
    return;
  }
  const open = () => ctx.ui.custom<"keybindings" | "threads" | undefined>((tui, theme, _keys, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder());
    container.addChild(new Text(theme.fg("accent", "  Thread settings"), 0, 0));
    const list = new SettingsList([{
      id: "enabled",
      label: "Enabled",
      description: "Enable thread shortcuts and automatic delegation; existing threads keep running",
      currentValue: String(threadsEnabled()),
      values: ["true", "false"],
    }, {
      id: "auto-threading",
      label: "Auto-threading",
      description: "Allow agents to delegate work to numbered threads",
      currentValue: String(autoThreadingEnabled()),
      values: ["true", "false"],
    }, {
      id: "time",
      label: "Time threshold",
      description: "The time threshold before the agent will start delegating tasks to other threads",
      currentValue: autoThreadingTime(),
      submenu: (value, close) => {
        const input = new Input();
        input.setValue(value);
        input.focused = true;
        input.onSubmit = close;
        input.onEscape = () => close();
        const content = new Container();
        content.addChild(new Text(theme.fg("accent", "  Time threshold"), 0, 0));
        content.addChild(input);
        content.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
        return {
          render: (width: number) => content.render(width),
          invalidate: () => content.invalidate(),
          handleInput: (data: string) => input.handleInput(data),
          handleMouse: (event: Parameters<Container["handleMouse"]>[0]) => content.handleMouse(event),
        };
      },
    }, {
      id: "keybindings",
      label: "Keybindings",
      description: "Configure thread shortcuts",
      currentValue: "Configure",
      values: ["Configure"],
    }, {
      id: "threads",
      label: "Threads",
      description: "Choose an existing thread",
      currentValue: "Show",
      values: ["Show"],
    }], 10, getSettingsListTheme(), (id, value) => {
      if (id === "keybindings" || id === "threads") { done(id); return; }
      try {
        if (id === "enabled") { saveThreadSetting("enabled", value === "true"); actions.enabledChanged(); }
        else if (id === "auto-threading") saveThreadSetting("autoThreading", value === "true");
        else if (id === "time") saveThreadSetting("time", value);
      } catch (error) {
        const current = id === "enabled" ? String(threadsEnabled()) : id === "auto-threading" ? String(autoThreadingEnabled()) : autoThreadingTime();
        list.updateValue(id, current);
        ctx.ui.notify(`Could not save thread settings: ${String(error)}`, "error");
      }
    }, () => done(undefined), { enableSearch: true });
    container.addChild(list);
    container.addChild(new DynamicBorder());
    return {
      capturesViewportInput: list.capturesViewportInput,
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
      handleMouse(event: Parameters<Container["handleMouse"]>[0]) { return container.handleMouse(event); },
    };
  });
  for (;;) {
    const action = await open();
    if (!action) return;
    if (action === "threads") { await actions.threads(); return; }
    await actions.keybindings();
  }
}
