// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 进程生命周期管理（FR-12~FR-17）

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'
import { ringBuffer } from './logbuffer.js'
import { type ManagedProcess, type LogLine } from '../types.js'
import { toolError } from '../errors.js'

// 包装 execSync 以绕过 TypeScript 严格的 shell 选项类型检查
function runExecSync(cmd: string, args: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execSync(cmd, [...args] as any)
}

export interface SupervisorState {
  process: ManagedProcess | null
  child: ChildProcess | null
}

class Supervisor {
  private state: SupervisorState = {
    process: null,
    child: null,
  }

  getCliPath(): string | null {
    return null
  }

  setCliPath(_path: string): void {
    return
  }

  /**
   * FR-12 启动 CLI 进程
   */
  start(cliPath: string, profilePath: string, verbose: number = 1, readyTimeoutMs: number = 3000): Promise<{ started: boolean; pid?: number; readyMs?: number; error?: string }> {
    return this.enqueueCommand(async () => {
      // FR-13 重复启动检查
      if (this.state.process) {
        throw toolError('ALREADY_RUNNING', `已有实例在运行（pid=${this.state.process.pid}，profile=${this.state.process.profilePath}）`, '先调用 proxybridge_stop', null)
      }

      const startTime = Date.now()
      const args = ['--profile', profilePath, '--verbose', String(verbose)]

      this.state.child = spawn(cliPath, args, {
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: dirname(cliPath),
      })

      this.setupProcessListeners()

      // 就绪窗口
      return new Promise<{ started: boolean; pid?: number; readyMs?: number; error?: string }>((resolve) => {
        const timeout = setTimeout(() => {
          // 窗口结束，进程仍存活 → 启动成功
          if (this.state.child && !this.state.child.killed) {
            this.state.process = {
              pid: this.state.child.pid!,
              profilePath,
              verbose,
              startedAt: new Date(startTime),
            }
            resolve({ started: true, pid: this.state.child.pid!, readyMs: Date.now() - startTime })
          } else {
            resolve({ started: false, error: 'CLI_START_FAILED' })
          }
        }, readyTimeoutMs)

        // 如果进程在就绪窗口内退出
        if (this.state.child) {
          this.state.child.once('exit', () => {
            clearTimeout(timeout)
            if (!this.state.process) {
              resolve({ started: false, error: 'CLI_START_FAILED' })
            }
          })
        }
      })
    })
  }

  /**
   * FR-14 状态查询
   */
  getStatus(): {
    running: boolean
    pid?: number
    startedAt?: string
    uptimeMs?: number
    profilePath?: string
    verbose?: number
    logLines?: number
    errorLines?: number
    lastExit?: ManagedProcess['lastExit']
    note?: string
  } {
    if (!this.state.process) {
      return {
        running: false,
        note: '运行状态不跨 MCP 重启保留',
      }
    }

    const uptimeMs = Date.now() - this.state.process.startedAt.getTime()

    return {
      running: true,
      pid: this.state.process.pid,
      startedAt: this.state.process.startedAt.toISOString(),
      uptimeMs,
      profilePath: this.state.process.profilePath,
      verbose: this.state.process.verbose,
      logLines: ringBuffer.countByStream('out'),
      errorLines: ringBuffer.countByStream('err'),
      lastExit: this.state.process.lastExit,
    }
  }

  /**
   * FR-15 日志读取
   */
  getLogs(lines: number = 100): { lines: LogLine[]; dropped: number; totalLines: number } {
    const allLines = ringBuffer.getAll()
    const totalLines = allLines.length
    const clamped = Math.min(lines, 5000)
    const result = allLines.slice(-clamped)
    const dropped = totalLines > clamped ? totalLines - clamped : 0

    return {
      lines: result,
      dropped,
      totalLines,
    }
  }

  /**
   * FR-16 停止进程
   */
  stop(timeoutMs: number = 5000): Promise<{ stopped: boolean; exitCode?: number; durationMs?: number; method: string; note?: string }> {
    return this.enqueueCommand(async () => {
      if (!this.state.process) {
        return { stopped: false, method: 'taskkill-tree', note: 'NOT_RUNNING' }
      }

      const startTime = Date.now()
      const pid = this.state.process.pid

      // FR-16: taskkill /PID <pid> /T /F
      try {
        runExecSync('taskkill', ['/PID', String(pid), '/T', '/F'])
      } catch {
        // taskkill 失败，尝试直接 kill
        if (this.state.child && !this.state.child.killed) {
          try {
            this.state.child.kill('SIGTERM')
          } catch {
            // ignore
          }
        }
      }

      // 等待进程退出
      return new Promise<{ stopped: boolean; exitCode?: number; durationMs?: number; method: string; note?: string }>((resolve) => {
        const checkInterval = setInterval(() => {
          const elapsed = Date.now() - startTime
          if (elapsed >= timeoutMs) {
            clearInterval(checkInterval)
            resolve({ stopped: false, durationMs: elapsed, method: 'taskkill-tree', note: 'TIMEOUT' })
          } else if (!this.state.child || this.state.child.killed) {
            clearInterval(checkInterval)
            const exitCode = this.state.process?.lastExit?.exitCode ?? undefined
            resolve({ stopped: true, exitCode, durationMs: elapsed, method: 'taskkill-tree' })
          }
        }, 100)
      })
    })
  }

  /**
   * FR-17 更新最后退出记录
   */
  updateLastExit(exitInfo: { pid?: number; exitCode: number | null; terminatedAt: Date; reason: string }): void {
    if (this.state.process && exitInfo.pid === this.state.process.pid) {
      this.state.process.lastExit = {
        pid: this.state.process.pid,
        exitCode: exitInfo.exitCode,
        terminatedAt: exitInfo.terminatedAt,
        reason: exitInfo.reason,
      }
    }
  }

  /**
   * FR-17 清除进程状态
   */
  clearProcess(): void {
    this.state.process = null
    this.state.child = null
  }

  /**
   * FR-17 设置进程状态
   */
  setProcess(proc: ManagedProcess): void {
    this.state.process = proc
  }

  /**
   * FR-17 获取当前进程
   */
  getProcess(): ManagedProcess | null {
    return this.state.process
  }

  /**
   * FR-15 添加日志
   */
  addLog(stream: 'out' | 'err', text: string): void {
    ringBuffer.add(stream, text)
  }

  private enqueueCommand<T>(fn: () => Promise<T>): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.commandQueue = this.commandQueue.then(fn as any).catch(() => fn() as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return fn() as any
  }

  private setupProcessListeners() {
    if (!this.state.child) return

    // FR-15 日志缓冲
    this.state.child.stdout?.on('data', (data: Buffer) => {
      ringBuffer.add('out', data.toString('utf-8'))
    })

    this.state.child.stderr?.on('data', (data: Buffer) => {
      ringBuffer.add('err', data.toString('utf-8'))
    })

    // FR-17 子进程异常退出（事件驱动路径）
    this.state.child.on('close', () => {
      if (this.state.process) {
        this.state.process.lastExit = {
          pid: this.state.process.pid,
          exitCode: null,
          terminatedAt: new Date(),
          reason: 'closed',
        }
        this.state.process = null
      }
      this.state.child = null
    })
  }

  private commandQueue: Promise<void> = Promise.resolve()
}

// 单例
export const supervisor = new Supervisor()
