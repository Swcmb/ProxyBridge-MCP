// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 管理员身份检测（FR-4）

import { execFileSync } from 'node:child_process'

/**
 * FR-4 管理员身份检测（三级交叉校验）
 * 三条命令均为 Windows 自带的 .exe，用 execFileSync 直接调用，不经 shell，无注入面（NFR-14）。
 */
export function checkAdmin(): AdminCheckResult {
  // 一级：whoami /groups 解析完整性等级 SID
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = String(execFileSync('whoami.exe', ['/groups'], { stdio: ['ignore', 'pipe', 'ignore'] } as any))
    const result = parseWhoamiGroups(output)
    if (result !== null) {
      // 二级：交叉校验
      let conflict = false
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execFileSync('fsutil.exe', ['dirty', 'query', 'C:'], { stdio: ['ignore', 'pipe', 'ignore'] } as any)
        // 退出码 0 = 管理员
        const fsutilIsAdmin = true
        if (fsutilIsAdmin !== result.isAdmin) {
          conflict = true
        }
      } catch {
        // fsutil 失败（含非管理员拒绝），忽略，以一级为准
      }
      return {
        isAdmin: result.isAdmin,
        adminCheckMethod: 'integrity-sid',
        adminCheckConflict: conflict,
      }
    }
  } catch {
    // whoami 失败，尝试二级
  }

  // 二级：fsutil dirty query C:
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execFileSync('fsutil.exe', ['dirty', 'query', 'C:'], { stdio: ['ignore', 'pipe', 'ignore'] } as any)
    return {
      isAdmin: true,
      adminCheckMethod: 'fsutil-dirty',
    }
  } catch {
    // 非管理员（Error 5）或命令失败
  }

  // 三级：net session
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execFileSync('net.exe', ['session'], { stdio: ['ignore', 'pipe', 'ignore'] } as any)
    return {
      isAdmin: true,
      adminCheckMethod: 'net-session',
    }
  } catch {
    // 非管理员
  }

  // 三级均失败
  throw {
    code: 'ENV_ADMIN_CHECK_FAILED',
    message: '无法判定管理员身份',
    fieldPath: null,
    hint: '手动以管理员身份运行 MCP 宿主后重试',
  }
}

interface AdminCheckResult {
  isAdmin: boolean
  adminCheckMethod: 'integrity-sid' | 'fsutil-dirty' | 'net-session'
  adminCheckConflict?: boolean
}

function parseWhoamiGroups(output: string): { isAdmin: boolean } | null {
  const lines = output.split('\n')
  let hasHighOrSystem = false
  let hasOnlyMediumOrLower = true

  for (const line of lines) {
    // 匹配完整性等级 SID（二进制标识，不受系统语言影响）
    if (line.includes('S-1-16-12288')) {
      // High integrity (管理员)
      hasHighOrSystem = true
      hasOnlyMediumOrLower = false
    } else if (line.includes('S-1-16-16384')) {
      // System integrity
      hasHighOrSystem = true
      hasOnlyMediumOrLower = false
    } else if (line.includes('S-1-16-8192')) {
      // Medium integrity (非管理员)
      hasOnlyMediumOrLower = true
    }
  }

  if (!hasHighOrSystem && !hasOnlyMediumOrLower) {
    // 未找到明确标识
    return null
  }

  return { isAdmin: hasHighOrSystem }
}
