import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ThreadIndicator = { slot: string; current: boolean; working: boolean; unread: boolean };

export function heartbeatBrightness(now: number): number {
  const phase = now % 2000;
  const beat = (center: number, width: number) => Math.exp(-Math.pow((phase - center) / width, 2));
  const pulse = Math.max(beat(280, 150), 0.7 * beat(610, 125));
  return Math.round(125 + 120 * pulse);
}

export function renderThreadIndicators(indicators: ThreadIndicator[], theme: ExtensionContext["ui"]["theme"], now: number): string {
  const workingBrightness = heartbeatBrightness(now);
  return indicators.map(indicator => {
    const brightness = indicator.working ? workingBrightness : indicator.unread ? 245 : 125;
    const digit = theme.style(indicator.slot, { fg: { kind: "rgb", r: brightness, g: brightness, b: brightness } });
    return indicator.current ? theme.fg("dim", "[") + digit + theme.fg("dim", "]") : digit;
  }).join(" ");
}
