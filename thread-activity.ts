import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ThreadIndicator = { slot: string; current: boolean; working: boolean; unread: boolean };

export function heartbeatBrightness(elapsedMs: number): number {
  const firstBeatMs = 280, firstBeatLeadMs = 50;
  const phase = (elapsedMs + firstBeatMs - firstBeatLeadMs) % 2000;
  const beat = (center: number, width: number) => Math.exp(-Math.pow((phase - center) / width, 2));
  const pulse = Math.max(beat(firstBeatMs, 150), 0.7 * beat(610, 125));
  return Math.round(125 + 120 * pulse);
}

export function renderThreadIndicators(indicators: ThreadIndicator[], theme: ExtensionContext["ui"]["theme"], elapsedMs: number): string {
  const workingBrightness = heartbeatBrightness(elapsedMs);
  return indicators.map(indicator => {
    const brightness = indicator.working ? workingBrightness : indicator.unread ? 245 : 125;
    const digit = theme.style(indicator.slot, { fg: { kind: "rgb", r: brightness, g: brightness, b: brightness } });
    return indicator.current ? theme.fg("dim", "[") + digit + theme.fg("dim", "]") : digit;
  }).join(" ");
}
