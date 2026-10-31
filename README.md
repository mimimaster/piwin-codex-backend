# piwin Codex backend

Independent `sessionBackend` for a user-owned `codex` binary via `app-server` stdio.

Missing platform binaries (ENOENT) are reported as unavailable. This repository does not install or repair Codex.

Pinned toolchain: `pnpm@9.15.0`, Node `>=22.23.4`. Do not solve esbuild with a blanket script-approval file.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```
