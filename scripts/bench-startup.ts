#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 启动性能基准测试（NFR-1 / AC-24）
//
// 测量点严格对齐 SPEC NFR-1：从 spawn 子进程到客户端收到 initialize 响应。
// 参考机：Windows x64 / Node v22。

import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')
const serverEntry = resolve(rootDir, 'packages/mcp-server/dist/index.js')

const ITERATIONS = 20
const TIMEOUT_MS = 10000

/** 单次测量：spawn 服务端 → 送 initialize → 收到响应即停 */
function measureOnce(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = process.hrtime.bigint()

    const child = spawn(process.execPath, [serverEntry], {
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: rootDir,
    })

    const request =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'bench-startup', version: '0.1.0' },
        },
      }) + '\n'

    const finish = (elapsedMs: number | null, error?: Error) => {
      clearTimeout(timer)
      child.stdout?.removeAllListeners()
      child.kill()
      error ? rejectPromise(error) : resolvePromise(elapsedMs as number)
    }

    const timer = setTimeout(
      () => finish(null, new Error('超时：10 秒内未收到 initialize 响应')),
      TIMEOUT_MS
    )

    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      // JSON-RPC 逐行分隔，遇到含 id=1 的响应即判定就绪
      for (const line of buffer.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        try {
          const message = JSON.parse(trimmed)
          if (message.id === 1 && message.result) {
            const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
            finish(elapsedMs)
            return
          }
        } catch {
          // 半行或不完整 JSON，等下一批数据
        }
      }
    })

    child.on('error', (err) => finish(null, err as Error))
    child.on('exit', (code) => {
      finish(null, new Error(`服务端提前退出，exit code=${code}，输出：${buffer.slice(0, 300)}`))
    })

    child.stdin?.write(request)
  })
}

async function main() {
  console.log('ProxyBridge MCP Server 冷启动性能测试（NFR-1）')
  console.log('=========================================')
  console.log(`入口：${serverEntry}`)
  console.log(`Node：${process.version}  平台：${process.platform}/${process.arch}`)
  console.log(`测量点：spawn 子进程 → 客户端收到 initialize 响应`)
  console.log(`迭代次数：${ITERATIONS}`)
  console.log('')

  const samples: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    try {
      const elapsed = await measureOnce()
      samples.push(elapsed)
      console.log(`第 ${String(i + 1).padStart(2)} 次: ${elapsed.toFixed(1)}ms`)
    } catch (err) {
      console.log(`第 ${String(i + 1).padStart(2)} 次: 失败 — ${(err as Error).message}`)
    }
  }

  if (samples.length === 0) {
    console.error('\n❌ 所有迭代均失败，无有效样本')
    process.exit(1)
  }

  const sorted = [...samples].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length

  console.log('\n=========================================')
  console.log('性能统计:')
  console.log(`  样本数：${samples.length} / ${ITERATIONS}`)
  console.log(`  P50：  ${p50.toFixed(1)}ms`)
  console.log(`  P95：  ${p95.toFixed(1)}ms`)
  console.log(`  最小： ${sorted[0].toFixed(1)}ms`)
  console.log(`  最大： ${sorted[sorted.length - 1].toFixed(1)}ms`)
  console.log(`  平均： ${avg.toFixed(1)}ms`)
  console.log('')

  if (samples.length < ITERATIONS) {
    console.log(`⚠️  ${ITERATIONS - samples.length} 次迭代失败，统计值基于 ${samples.length} 个样本`)
  }

  if (p50 >= 2000) {
    console.log('⚠️  P50 ≥ 2000ms，已达到已知偏差阈值')
    console.log('按 AC-24 记录为已知偏差，并在 README 环境备注段说明原因')
    process.exit(0)
  }

  console.log('✅ P50 < 2000ms，符合 NFR-1 要求')
  console.log('按 AC-24 将该数值记入 README 环境备注段')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})