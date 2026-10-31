# piwin Codex session backend

Independent plugin. Host never vendors this adapter.

- Speak `piwin-agent-stdio` to Host. Speak Codex app-server JSON-RPC over stdio (`codex app-server --listen stdio://`, which is the documented default). Never open a vendor network listener.
- Reply to server-initiated approvals with the original JSON-RPC request id and native result shape.
- Resume by original thread id. Missing platform binary is `not-installed`, never auto-repair.
- Questions are not permissions. Do not inject Pi tools or Host plans.
