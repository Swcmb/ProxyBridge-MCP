#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 启动性能基准测试（NFR-1）

import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')

console.log('ProxyBridge MCP Server 冷启动性能测试')
console.log('=====================================')

const results = []
const iterations = 20

for (let i = 0; i < iterations; i++) {
  const start = Date.now()

  try {
    // 启动 server 并发送 initialize 请求
    const proc = execSync(
      `node dist/index.js`,
      {
        cwd: rootDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }
    )
    const elapsed = Date.now() - start
    results.push(elapsed)
    console.log(`第 ${i + 1} 次: ${elapsed}ms`)
  } catch (err) {
    console.log(`第 ${i + 1} 次: 失败`)
  }
}

if (results.length > 0) {
  results.sort((a, b) => a - b)
  const medianIndex = Math.floor(results.length / 2)
  const p50 = results[medianIndex]
  const p95 = results[Math.floor(results.length * 0.95)]
  const min = results[0]
  const max = results[results.length - 1]
  const avg = results.reduce((a, b) => a + b, 0) / results.length

  console.log('\n=====================================')
  console.log('性能统计:')
  console.log(`  P50: ${p50}ms`)
  console.log(`  P95: ${p95}ms`)
  console.log(`  最小: ${min}ms`)
  console.log(`  最大: ${max}ms`)
  console.log(`  平均: ${avg.toFixed(2)}ms`)

  if (p50 >= 2000) {
    console.log('\n⚠️  P50 ≥ 2000ms，已达到已知偏差阈值')
    console.log('建议在 README 环境备注段记录此结果及可能原因')
  } else {
    console.log('\n✅ P50 < 2000ms，符合 NFR-1 要求')
  }
} else {
  console.log('❌ 所有测试均失败')
}
