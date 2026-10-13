#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 启动脚本

import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')

const args = process.argv.slice(2)
const nodeArgs = ['--loader', 'tsx', 'src/index.ts']

const child = spawn(process.execPath, [...nodeArgs, ...args], {
  cwd: resolve(rootDir, 'packages', 'mcp-server'),
  stdio: 'inherit',
  shell: false,
})

child.on('exit', (code) => process.exit(code || 0))
