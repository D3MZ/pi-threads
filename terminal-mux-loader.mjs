// Keep the versioned import native so Pi's extension loader can reload the mux.
export function loadTerminalMux(url) {
  return import(url);
}
