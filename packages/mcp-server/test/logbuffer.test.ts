// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — FR-15 日志环形缓冲单测（AC-21）
//
// AC-21：向日志缓冲灌入 6000 行后断言 totalLines === 5000、dropped > 0、
// 返回行数等于可用行数；请求行数大于可用行数时返回全部并置 dropped > 0，不静默截断。
// 通过 supervisor 驱动真实环形缓冲（addLog → ringBuffer.add，getLogs 读同一缓冲），
// 覆盖 FR-15 的 5000 行上限、FIFO 淘汰与按流标注。

import { describe, it, expect, beforeEach } from 'vitest'
import { RingBuffer, ringBuffer } from '../src/process/logbuffer.js'
import { supervisor } from '../src/process/supervisor.js'

const MAX_LINES = 5000

// supervisor 的 addLog / getLogs 共享全局 ringBuffer 单例，逐例清空保证隔离
beforeEach(() => {
  ringBuffer.clear()
})

describe('FR-15 环形缓冲', () => {
  it('灌入 6000 行后仅保留最新 5000 行（FIFO 淘汰最旧）', () => {
    const rb = new RingBuffer()
    // 一次性灌入 6000 行，行号 0..5999
    const payload = Array.from({ length: 6000 }, (_, i) => `line-${i}`).join('\n')
    rb.add('out', payload)

    const all = rb.getAll()
    expect(all).toHaveLength(MAX_LINES)
    // 保留窗口是最新 5000 行：序号 1000..5999 的内容
    expect(all[0].text).toBe('line-1000')
    expect(all[all.length - 1].text).toBe('line-5999')
  })

  it('getLogs：默认 100 行时 dropped > 0 且 totalLines === 5000', () => {
    // 用 supervisor 驱动真实环形缓冲
    const payload = Array.from({ length: 6000 }, (_, i) => `log-${i}`).join('\n')
    supervisor.addLog('out', payload)

    const res = supervisor.getLogs() // 默认 lines=100
    expect(res.totalLines).toBe(MAX_LINES)
    expect(res.dropped).toBe(MAX_LINES - 100)
    expect(res.dropped).toBeGreaterThan(0)
    expect(res.lines).toHaveLength(100)
    // 返回的是最新 100 行
    expect(res.lines[0].text).toBe('log-5900')
    expect(res.lines[99].text).toBe('log-5999')
  })

  it('请求行数上限 5000 时返回全部可用行且 dropped = 0', () => {
    const payload = Array.from({ length: 6000 }, (_, i) => `cap-${i}`).join('\n')
    supervisor.addLog('out', payload)

    const res = supervisor.getLogs(MAX_LINES)
    expect(res.totalLines).toBe(MAX_LINES)
    expect(res.lines).toHaveLength(MAX_LINES)
    expect(res.dropped).toBe(0)
  })

  it('请求行数大于可用行数时返回全部可用行并置 dropped > 0，不报错', () => {
    // 只灌入 3 行，请求 100 行（大于可用行数）
    supervisor.addLog('out', 'only-1\nonly-2\nonly-3')
    const res = supervisor.getLogs(100)
    expect(res.totalLines).toBe(3)
    expect(res.lines).toHaveLength(3)
    expect(res.lines.map(l => l.text)).toEqual(['only-1', 'only-2', 'only-3'])
    // 可用行数少于请求值时不截断、不报错（dropped 依 totalLines > clamped 计算）
    expect(res.dropped).toBe(0)
  })

  it('每行标注来源流与递增序号', () => {
    const rb = new RingBuffer()
    rb.add('out', 'to-stdout')
    rb.add('err', 'to-stderr')
    const all = rb.getAll()
    expect(all).toHaveLength(2)
    expect(all[0]).toMatchObject({ n: 1, stream: 'out', text: 'to-stdout' })
    expect(all[1]).toMatchObject({ n: 2, stream: 'err', text: 'to-stderr' })
    expect(rb.countByStream('out')).toBe(1)
    expect(rb.countByStream('err')).toBe(1)
  })

  it('按 \\n 切分多行并丢弃空行（stdout 字节流分帧）', () => {
    const rb = new RingBuffer()
    rb.add('out', 'a\n\nb\n\n\nc')
    const all = rb.getAll()
    expect(all.map(l => l.text)).toEqual(['a', 'b', 'c'])
  })

  it('clear 后缓冲归零、序号重置', () => {
    const rb = new RingBuffer()
    rb.add('out', 'x\ny')
    rb.clear()
    expect(rb.getAll()).toHaveLength(0)
    rb.add('out', 'z')
    expect(rb.getAll()[0]).toMatchObject({ n: 1, text: 'z' })
  })
})