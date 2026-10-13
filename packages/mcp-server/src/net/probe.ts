// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 网络连通性探测（FR-18）

import net from 'node:net'

export type ProbeResult = 'reachable' | 'refused' | 'timeout' | 'unresolved' | 'unreachable'

interface ProbeNote {
  result: ProbeResult
  elapsedMs: number
  note: string
}

/**
 * FR-18 连通性探测
 * 返回五态结果
 */
export function probeProxy(
  host: string,
  port: number,
  timeoutMs: number = 5000
): Promise<ProbeNote> {
  return new Promise((resolve) => {
    const startTime = Date.now()
    const socket = new net.Socket()

    let settled = false

    const settle = (result: ProbeResult, errorMessage?: string) => {
      if (settled) return
      settled = true
      socket.destroy()
      const elapsedMs = Date.now() - startTime
      resolve({
        result,
        elapsedMs,
        note: buildNote(result, errorMessage),
      })
    }

    // 连接成功
    socket.once('connect', () => {
      settle('reachable')
    })

    // 连接被拒绝
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code
      if (code === 'ECONNREFUSED') {
        settle('refused')
      } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') {
        settle('unresolved')
      } else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN' || code === 'EACCES' || code === 'ECONNRESET') {
        settle('unreachable')
      } else if (code === 'ETIMEDOUT' || code === 'ERR_SOCKET_CONNECTION_TIMEOUT') {
        settle('timeout')
      } else {
        settle('unreachable')
      }
    })

    // 超时
    const timer = setTimeout(() => {
      settle('timeout')
    }, timeoutMs)

    socket.connect(port, host)
  })
}

function buildNote(result: ProbeResult, errorMessage?: string): string {
  const baseNote = 'TCP 连接测试完成，端口可达不代表代理协议可用。'

  switch (result) {
    case 'reachable':
      return `${baseNote} 端口可连，建议使用专业工具进一步测试代理协议。`
    case 'refused':
      return `${baseNote} 端点存在但未监听，或被防火墙 RST 拒绝。`
    case 'timeout':
      return `${baseNote} 连接超时，目标可能被静默丢弃或不可路由。`
    case 'unresolved':
      return `${baseNote} 域名无法解析，请检查主机名是否正确。`
    case 'unreachable':
      return `${baseNote} 路由不可达、被本地策略拒绝或连接被中途重置。`
    default:
      return baseNote
  }
}
