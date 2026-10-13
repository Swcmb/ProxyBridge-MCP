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

## License

GPL-3.0-or-later. See `COPYING` for full text.
