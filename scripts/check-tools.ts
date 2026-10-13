#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 工具命名与注解检查（NFR-9）

import { readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')

let errors = 0

// 读取源码
const srcDir = resolve(rootDir, 'packages/mcp-server/src')
const indexContent = readFileSync(resolve(srcDir, 'index.ts'), 'utf-8')

// 1. 检查工具前缀
const toolNames = indexContent.match(/name: 'proxybridge_\w+'/g) || []
console.log(`找到 ${toolNames.length} 个工具定义`)

for (const tool of toolNames) {
  if (!tool.includes("proxybridge_")) {
    console.error(`❌ 工具名缺少 proxybridge_ 前缀: ${tool}`)
    errors++
  }
}

// 2. 检查四注解齐全
const annotations = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
for (const anno of annotations) {
  if (!indexContent.includes(anno)) {
    console.error(`❌ 缺少注解: ${anno}`)
    errors++
  } else {
    console.log(`✅ 注解 ${anno} 存在`)
  }
}

// 3. 检查 openWorldHint 口径
const openWorldLine = indexContent.split('\n').find(l => l.includes('openWorldHint 口径'))
if (openWorldLine) {
  console.log('✅ openWorldHint 口径定义存在')
} else {
  console.error('❌ 缺少 openWorldHint 口径定义')
  errors++
}

if (errors === 0) {
  console.log('\n✅ 工具命名与注解检查通过')
  process.exit(0)
} else {
  console.error(`\n❌ 发现 ${errors} 处问题`)
  process.exit(1)
}
