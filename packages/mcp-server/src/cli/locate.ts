// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — CLI 定位（FR-1~FR-3）

import { execSync, execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

// 执行 Windows 系统 .cmd 命令（where 等）——硬编码命令名，无注入面
function runSystemCmd(cmd: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return String(execSync(cmd, { shell: true } as any))
}

// 执行外部 CLI 可执行文件（--version）——不经 shell，防命令注入（NFR-14）
function runCliCmd(cliPath: string, ...args: string[]): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return String(execFileSync(cliPath, args, { stdio: ['ignore', 'pipe', 'ignore'] } as any))
}

export interface CliLocation {
  found: boolean
  cliPath: string | null
  version: string | null
  coreDllPresent: boolean
  candidatesTried: string[]
}

// 常见安装路径（按优先级排序）
const DEFAULT_PATHS = [
  'E:\\Program Files\\ProxyBridge\\ProxyBridge_CLI.exe',
  'C:\\Program Files\\ProxyBridge\\ProxyBridge_CLI.exe',
  'C:\\Program Files (x86)\\ProxyBridge\\ProxyBridge_CLI.exe',
]

/**
 * FR-1 定位 CLI 可执行文件
 */
export function locateCli(cliPathOverride?: string): CliLocation {
  const candidates: string[] = []
  let resolvedPath: string | null = null

  // 1. 显式路径
  if (cliPathOverride) {
    candidates.push(cliPathOverride)
    if (isExecutable(cliPathOverride)) {
      resolvedPath = cliPathOverride
    }
  }

  // 2. 环境变量
  const envPath = process.env.PROXYBRIDGE_CLI_PATH
  if (envPath && !resolvedPath) {
    candidates.push(envPath)
    if (isExecutable(envPath)) {
      resolvedPath = envPath
    }
  }

  // 3. 常见路径
  if (!resolvedPath) {
    for (const p of DEFAULT_PATHS) {
      candidates.push(p)
      if (isExecutable(p)) {
        resolvedPath = p
        break
      }
    }
  }

  // 4. PATH
  if (!resolvedPath) {
    try {
      const output = runSystemCmd('where ProxyBridge_CLI.exe')
      const trimmed = output.trim()
      if (trimmed) {
        const first = trimmed.split('\n')[0].trim()
        candidates.push(first)
        if (isExecutable(first)) {
          resolvedPath = first
        }
      }
    } catch {
      // where 命令失败，PATH 中未找到
    }
  }

  if (!resolvedPath) {
    throw {
      code: 'ENV_CLI_NOT_FOUND',
      message: `未找到 ProxyBridge_CLI.exe，已尝试：${candidates.join('、')}`,
      fieldPath: null,
      hint: '设置 PROXYBRIDGE_CLI_PATH 或在工具入参中给出 cliPath',
    }
  }

  // FR-2 版本探测
  let version: string | null = null
  try {
    version = runCliCmd(resolvedPath, '--version').trim()
  } catch (err) {
    throw {
      code: 'ENV_CLI_NOT_EXECUTABLE',
      message: `找到 ${resolvedPath} 但无法执行：${(err as Error).message}`,
      fieldPath: null,
      hint: '检查文件权限与 Windows 兼容性',
    }
  }

  // FR-3 依赖完整性检查
  const cliDir = dirname(resolvedPath)
  const dllPath = join(cliDir, 'ProxyBridgeCore.dll')
  const coreDllPresent = existsSync(dllPath)
  if (!coreDllPresent) {
    throw {
      code: 'ENV_CORE_DLL_MISSING',
      message: `缺少 ${cliDir}\\ProxyBridgeCore.dll，CLI 无法启动`,
      fieldPath: null,
      hint: 'CLI 与 DLL 必须同目录，请完整安装',
    }
  }

  return {
    found: true,
    cliPath: resolvedPath,
    version,
    coreDllPresent,
    candidatesTried: candidates,
  }
}

function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile()
  } catch {
    return false
  }
}
