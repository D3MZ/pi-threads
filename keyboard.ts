// Parse CSI-u events, including the optional associated text used by input methods.
export function parseKeyboardEvent(data: string) {
  // Kitty permits the default modifier field to be empty when associated
  // text follows it (for example Ghostty sends `CSI 97;;97u` for "a").
  const match = /^\x1b\[(\d+)((?::\d*){0,2})(?:;(\d*)(?::(\d+))?)?(?:;([\d:]+))?u$/.exec(data);
  if (!match) return undefined;
  const code = Number(match[1]);
  const modifiers = Number(match[3] || 1) - 1;
  const event = Number(match[4] || 1);
  const modifierKey = code >= 57441 && code <= 57454;
  const normalized = `\x1b[${match[1]}${match[2]}${match[3] ? `;${match[3]}${match[4] ? `:${match[4]}` : ""}` : ""}u`;
  let text: string | undefined;
  if (match[5] && event !== 3 && (code === 0 || (modifiers & (2 | 4 | 8 | 16 | 32)) === 0)) {
    const points = match[5].split(":").map(Number);
    if (points.every(p => Number.isInteger(p) && p >= 32 && !(p >= 127 && p <= 159) && p <= 0x10ffff && !(p >= 0xd800 && p <= 0xdfff))) {
      text = String.fromCodePoint(...points);
    }
  }
  return { code, modifiers, event, modifierKey, normalized, text };
}

// Modified Escape must be distinguishable from plain Escape, which cancels UI.
export function isCloseShortcut(data: string) {
  const key = parseKeyboardEvent(data);
  return !!key && key.code === 27 && key.modifiers === 4 && key.event === 1;
}
