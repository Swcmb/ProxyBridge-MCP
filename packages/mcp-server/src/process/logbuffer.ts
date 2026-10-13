// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 日志环形缓冲（FR-15）

import { type LogLine } from '../types.js'

const MAX_LINES = 5000

interface BufferedLine {
  n: number
  stream: 'out' | 'err'
  text: string
  timestamp: number
}

export class RingBuffer {
  private buffer: BufferedLine[] = []
  private sequence = 0

  add(stream: 'out' | 'err', text: string): void {
    const lines = text.split('\n').filter(l => l.length > 0)
    for (const line of lines) {
      this.buffer.push({
        n: ++this.sequence,
        stream,
        text: line,
        timestamp: Date.now(),
      })
    }

    // 环形缓冲：超出上限时丢弃最旧的
    if (this.buffer.length > MAX_LINES) {
      this.buffer = this.buffer.slice(this.buffer.length - MAX_LINES)
    }
  }

  getAll(): LogLine[] {
    return this.buffer.map(({ n, stream, text }) => ({ n, stream, text }))
  }

  getTail(count: number): LogLine[] {
    const all = this.getAll()
    return all.slice(-count)
  }

  countByStream(stream: 'out' | 'err'): number {
    return this.buffer.filter(l => l.stream === stream).length
  }

  clear(): void {
    this.buffer = []
    this.sequence = 0
  }
}

export const ringBuffer = new RingBuffer()
