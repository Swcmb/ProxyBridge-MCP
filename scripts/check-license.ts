#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 许可证合规检查（NFR-12）

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')

let errors = 0

// 1. 检查 COPYING 文件
const copyingPath = resolve(rootDir, 'COPYING')
if (!existsSync(copyingPath)) {
  console.error('❌ 缺少 COPYING 文件')
  errors++
} else {
  const content = readFileSync(copyingPath, 'utf-8')
  if (!content.includes('GNU GENERAL PUBLIC LICENSE')) {
    console.error('❌ COPYING 文件内容不符合 GPLv3')
    errors++
  } else {
    console.log('✅ COPYING 文件存在且有效')
  }
}

// 2. 检查 package.json license 字段
const pkgJsonPath = resolve(rootDir, 'package.json')
if (existsSync(pkgJsonPath)) {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
  if (pkg.license !== 'GPL-3.0-or-later') {
    console.error('❌ package.json license 字段应为 GPL-3.0-or-later')
    errors++
  } else {
    console.log('✅ package.json license 字段正确')
  }
}

// 3. 检查源文件 SPDX 标识
const srcDir = resolve(rootDir, 'packages/mcp-server/src')
const tsFiles = readdirSync(srcDir, { recursive: true })
  .filter(f => f.endsWith('.ts'))
  .map(f => resolve(srcDir, f))

for (const file of tsFiles) {
  const content = readFileSync(file, 'utf-8')
  if (!content.includes('SPDX-License-Identifier: GPL-3.0-or-later')) {
    console.error(`❌ ${file} 缺少 SPDX 标识`)
    errors++
  }
}

console.log(`\n共检查 ${tsFiles.length} 个 TypeScript 文件`)

if (errors === 0) {
  console.log('✅ 许可证合规检查通过')
  process.exit(0)
} else {
  console.error(`\n❌ 发现 ${errors} 处许可证问题`)
  process.exit(1)
}
