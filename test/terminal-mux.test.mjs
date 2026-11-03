import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalMux } from "../terminal-mux.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await sleep(10);
  }
}

// Model Pi's startup: the slave initially echoes input in canonical mode,
// then Pi enables raw mode and sends its keyboard-protocol query.
const delayedTerminal = String.raw`
const net = require("node:net");
process.stdout.write("STARTING");
setTimeout(() => {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", data => process.stdout.write("INPUT:" + Buffer.from(data).toString("hex") + ":END"));
  process.stdin.resume();
  process.stdout.write("PARTIAL:\x1b[?");
  setTimeout(() => {
    process.stdout.write("u");
    const socket = net.createConnection(process.env.PI_CHATTHREADS_SOCKET);
    socket.on("connect", () => socket.write(JSON.stringify({ type: "hello", token: process.env.PI_CHATTHREADS_TOKEN, session: "test-session" }) + "\n"));
    socket.on("error", () => {});
  }, 200);
}, 600);
`;

for (const kitty of [true, false]) test(`buffers early input until the child PTY is in raw mode (Kitty ${kitty ? "on" : "off"})`, async t => {
  let visible = "", mainInput = "";
  const terminal = { columns: 80, rows: 24, kittyProtocolActive: kitty, inputHandler: data => { mainInput += data; } };
  const mux = new TerminalMux({ ui: { terminal, requestRender() {} }, onSwitch() {} });
  // The mux normally suppresses host stdout while a thread is active; the
  // node:test reporter shares that stream, so leave it alone in this test.
  process.stdout.write = mux.output;
  mux.write = data => { visible += data; };

  const child = await mux.start({ session: "test-session", executable: process.execPath, args: ["-e", delayedTerminal], cwd: process.cwd(), env: process.env });
  const showing = mux.show(child);
  showing.catch(() => {});
  t.after(() => { child.rejectReady(new Error("test cleanup")); mux.dispose(); });
  await waitFor(() => visible.includes("STARTING"), "child startup");
  const early = ["\x1b[50;5:3u", "\x1b[57441;1:3u", "\x1b[200~hello 😸\x1b[201~"];
  for (const input of early) terminal.inputHandler(input);
  await sleep(100);
  assert.equal(child.negotiated, false);
  assert.doesNotMatch(visible, /\^\[|hello/, "the slave must not echo early input");
  await waitFor(() => visible.includes("PARTIAL:"), "partial keyboard query");
  assert.equal(child.negotiated, false, "a split query must not flush input early");

  await showing;
  const received = () => Buffer.from([...visible.matchAll(/INPUT:([0-9a-f]+):END/g)].map(match => match[1]).join(""), "hex");
  const response = kitty ? "\x1b[?7u\x1b[?1;2c" : "\x1b[?1;2c";
  const expected = Buffer.from(response + early.join(""));
  await waitFor(() => received().length >= expected.length, "buffered input to reach the child");
  assert.deepEqual(received().subarray(0, expected.length), expected, "respond before delivering buffered input in order");
  assert.doesNotMatch(visible, /\^\[/);
  terminal.inputHandler("later");
  await waitFor(() => received().includes(Buffer.from("later")), "subsequent input");
  mux.showMain();
  terminal.inputHandler("main");
  assert.equal(mainInput, "main");
});
