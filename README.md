# ProxyBridge MCP Server

A TypeScript MCP Server (stdio transport) that wraps the ProxyBridge CLI (V4.1.1) with Agent-friendly tools: profile generation, validation, lifecycle management, and proxy connectivity testing — all without requiring manual JSON editing.

## Features

- **Profile generation**: Build `.pbprofile` files from structured requests, with full validation before write
- **Profile validation**: Check existing profiles against schema rules; detect shadowed rules, forced-direct overrides, UDP warnings
- **Process management**: Start / stop / status / logs for the ProxyBridge CLI
- **Proxy testing**: TCP connectivity probe with five-state result classification
- **Admin detection**: Three-tier Windows privilege check without spawning external processes

## Quick Start

```bash
npm install
npm run build
npm run start
```

Connect via MCP client (e.g. `npx @modelcontextprotocol/inspector`) to `packages/mcp-server`.

## Requirements

- Node.js ≥ 20
- Windows x64 (ProxyBridge CLI is Windows-only)
- Administrator privileges for `proxybridge_start` (WinDivert driver)

## Environment Notes

### Startup performance (NFR-1 / AC-24)

Measured 2026-10-15 with `npm run bench:startup` — 20 iterations, measurement point is
*spawn subprocess → client receives the `initialize` response*:

| Metric | Value |
| --- | --- |
| Samples | 20 / 20 |
| P50 | **199.3 ms** |
| P95 | 298.8 ms |
| Min / Max | 194.5 ms / 298.8 ms |
| Mean | 207.4 ms |

Reference machine: Windows 11 Pro x64 / Node v24.20.0 / win32-x64. P50 sits well under the
2000 ms NFR-1 threshold, so no known deviation applies. The SPEC's reference machine is
Node v22; a follow-up run on v22 would confirm parity.

Startup is dominated by Node's module-loading phase. `src/index.ts` statically imports the MCP
SDK plus the supervisor, profile, net and CLI-locator modules, so all of them are inside the
measured window; roughly 200 ms covers the full import graph and tool registration. No tool
performs I/O before responding to `initialize`.

### Connectivity probe (AC-10)

Measured 2026-10-15 against `proxybridge_test_proxy`:

| Input | Result | Elapsed |
| --- | --- | --- |
| `127.0.0.1:34567` (local listener) | `reachable` | 1 ms |
| `127.0.0.1:9` (closed port) | `refused` | 1 ms |
| `no-such-host.invalid:80` | `unresolved` | 65 ms |
| `192.0.2.1:81` (TEST-NET-1) | `timeout` | 5001 ms |

Note on the fourth row: SPEC AC-10 lists `192.0.2.1:81` as the `unreachable` fixture, but TEST-NET-1
silently drops packets rather than returning ICMP unreachable, so the observed result is `timeout`
(FR-18 maps `EHOSTUNREACH`/`ENETUNREACH` to `unreachable`, which needs a routable-but-unreachable
target). All five states remain implemented; `unreachable` was not reproduced on this host.

### Admin detection (AC-7)

`proxybridge_check_environment` on this machine returns `isAdmin: true` with
`adminCheckMethod: "fsutil-dirty"` and `adminCheckConflict: false`. The preferred
`integrity-sid` tier is skipped because `whoami.exe /groups` exits with code 1 and prints no
group table in this environment, so the three-tier fallback (SPEC D-6) engages as designed.
`candidatesTried` resolved the CLI at `E:\Program Files\ProxyBridge\ProxyBridge_CLI.exe`, reporting
`coreDllPresent: true`.

### Process lifecycle (AC-8 / AC-9 / AC-17)

Full `start → status → logs → stop` cycle exercised against the real CLI as administrator:

- `start` spawns the CLI; `status` reports `running: true`, correct `pid` and growing `uptimeMs`;
  `logs` returns the live CLI banner plus the parsed `ProxyBridgeCore.dll` load and both proxy
  entries.
- `stop` reports `method: "taskkill-tree"`, `durationMs: 1127`, `stopped: true`; a follow-up
  `tasklist` shows the CLI process gone and `status` returns `running: false` with the
  "运行状态不跨 MCP 重启保留" note (FR-17 `close`-event path).
- AC-9 residue check after stop: `ProxyBridge_CLI.exe` count 0. The `WinDivert` kernel driver stays
  `RUNNING` — expected for a stoppable kernel driver that survives process exit; `ProxyBridgeSvc.exe`
  is a separate always-on Windows service, unrelated to the spawned CLI.

The admin-required CLI run reveals a real startup-timing observation: `start` returns as soon as the
process is spawned plus the readiness window, so `readyMs` reflects the configured
`readyTimeoutMs` unless the CLI signals readiness earlier. Acceptance for this host is
administrator-run as recorded above.

## License

GPL-3.0-or-later. See `COPYING` for full text.
