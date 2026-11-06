import { DynamicBorder, getAgentDir, getSettingsListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const settingsDir = join(getAgentDir(), "pi-threads");
const settingsPath = join(settingsDir, "settings.json");

export function autoThreadingEnabled() {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8")).autoThreading === true;
  } catch {
    return false;
  }
}

function saveAutoThreading(enabled: boolean) {
  let settings: Record<string, unknown> = {};
  try {
    const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (saved && typeof saved === "object" && !Array.isArray(saved)) settings = saved;
  } catch { /* Start with the defaults. */ }
  settings.autoThreading = enabled;
  mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
  const temporary = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, settingsPath);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

export async function showThreadSettings(ctx: ExtensionContext) {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Thread settings require interactive mode", "error");
    return;
  }
  await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder());
    const list = new SettingsList([{
      id: "auto-threading",
      label: "Auto-threading",
      description: "Allow agents to delegate work to numbered threads",
      currentValue: String(autoThreadingEnabled()),
      values: ["true", "false"],
    }], 10, getSettingsListTheme(), (_id, value) => {
      try { saveAutoThreading(value === "true"); }
      catch (error) {
        list.updateValue("auto-threading", String(autoThreadingEnabled()));
        ctx.ui.notify(`Could not save thread settings: ${String(error)}`, "error");
      }
    }, () => done(), { enableSearch: true });
    container.addChild(list);
    container.addChild(new DynamicBorder());
    return {
      capturesViewportInput: list.capturesViewportInput,
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
      handleMouse(event: Parameters<SettingsList["handleMouse"]>[0]) { return list.handleMouse(event); },
    };
  });
}
