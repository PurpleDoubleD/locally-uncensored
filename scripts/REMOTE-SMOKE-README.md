# Remote Smoke Harness

Self-contained Node.js harness for reproducing and verifying Remote Access
bugs without needing a phone. Talks to the same `/remote-api/agent-tool`
endpoint the mobile page uses.

## When to use

Use this whenever a Remote bug is reported (file_list wrong path,
agent hanging, shell command failing) — saves a full round-trip through
the user's phone.

## One-time bootstrap

1. Build & launch the LU desktop exe:
   ```
   npm run tauri:build
   target\release\locally-uncensored.exe
   ```
2. Open Remote drawer (right side) → click **LAN** → click **Dispatch**
   on a chat → pick a folder.
3. The drawer will display:
   - `URL`: e.g. `http://192.168.1.42:8765`
   - `Code`: 6-digit (lasts 5 minutes; refresh if expired).

## Running the harness

```
node scripts/remote-smoke.mjs \
  --base http://192.168.1.42:8765 \
  --code 123456 \
  --chat-id remote-smoke
```

Output:
- 12 assertions covering: auth, file_write, file_list, file_read,
  shell cwd default, error response shape.
- Exit code 0 = green, 1 = at least one fail.

The harness writes a file at `<your-folder>/remote-smoke/hello.txt`,
lists the folder, reads back, runs `pwd` (or `$pwd.Path` on Windows),
and asserts none of the paths leak through to
`~/agent-workspace/__remote__/`.

## What to assert next time

Bug 1 (path resolution) — the `path is NOT ~/agent-workspace/__remote__`
checks fail when the override map isn't honored.

Bug 2 (echo / consecutive errors) — exercise via a multi-step agent
prompt that fails 5+ times. The new guard should bail with a clean
"too many consecutive tool errors" step instead of leaking the system
prompt back to the chat.

## Adding more checks

`agentTool(base, token, chatId, tool, args)` is the wrapper. Stack more
calls inside `main()`. Use `check(label, ok, detail)` to record an
assertion.
