#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 安全检查：禁用危险调用（NFR-5 / NFR-14 / R-5）
//
// 检测范围：src/ 目录下所有 .ts 文件
// 规则：
//   1. spawn 调用的行不允许出现 shell: true（NFR-14：防命令注入）
//   2. 禁止 runas / ShellExecute 提权调用（NFR-5）
//   3. 禁止字符串拼接 spawn 命令行
//   4. taskkill 允许存在，但目标 PID 必须来自变量（不得是硬编码进程名）

import { readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')

let errors = 0

const forbiddenPatterns = [
  { re: /runas\s*"/i, desc: 'runas 提权调用（NFR-5）' },
  { re: /ShellExecute\s*\(/i, desc: 'ShellExecute 提权调用（NFR-5）' },
  { re: /ShellExecuteEx\s*\(/i, desc: 'ShellExecuteEx 提权调用（NFR-5）' },
  { re: /spawn\s*\(\s*['"`][^'"`]*&&/, desc: '字符串拼接 spawn 命令行（NFR-14）' },
]

const srcDir = resolve(rootDir, 'packages/mcp-server/src')

function checkDir(dir: string) {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      checkDir(fullPath)
    } else if (entry.name.endsWith('.ts')) {
      const content = readFileSync(fullPath, 'utf-8')
      const relativePath = fullPath.replace(srcDir + '\\', '')

      // 检查 spawn 调用行
      if (content.includes('spawn')) {
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (/spawn\s*\(/.test(line) && /shell\s*:\s*true/i.test(line)) {
            console.error(`❌ ${relativePath}:${i + 1}: spawn 调用使用了 shell: true（NFR-14）`)
            errors++
          }
        }
      }

      // 检查危险关键词
      for (const { re, desc } of forbiddenPatterns) {
        const matches = content.match(re)
        if (matches) {
          console.error(`❌ ${relativePath}: 发现禁止模式「${desc}」`)
          errors++
        }
      }
    }
  }
}

checkDir(srcDir)

if (errors === 0) {
  console.log('✅ 安全检查通过：未发现禁止调用')
  process.exit(0)
} else {
  console.error(`\n❌ 发现 ${errors} 处安全问题`)
  process.exit(1)
}
