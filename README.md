# pi-threads
Threaded side conversations that fork the existing chat at any point you choose that operates async.
1. Hold down Ctrl + number to fork at that point
2. Close thread with Ctrl + Esc
3. Enjoy.

## Installation
Ask your clanker, or
```sh
pi install https://github.com/D3MZ/pi-threads
```

## Commands
- `/threads` — show command usage. Type `/threads ` to see available options.
- `/threads on` — show message target numbers in the current thread.
- `/threads off` — hide target numbers and cancel a pending reply. Keyboard shortcuts remain enabled.
- `/threads show` — choose a registered session from a list.
- `/threads 2` — open a registered session by number; this also works from a fork view.
- `/threads keybinding` — configure the target shortcut, modifier prefix, and previous/next shortcuts. Run `/reload` to apply changes.