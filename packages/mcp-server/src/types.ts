// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 类型定义

// Profile 数据模型（请求层）
// 真实 GUI 导出的代理 Id 为字符串（如 "p1"），见 AC-18 校准
export interface ProxyConfigRequest {
  id: string
  type: 'socks5' | 'http'
  host: string
  port: number | string
  username?: string
  password?: string
}

export interface RuleRequest {
  processName: string
  targetHosts?: string
  targetPorts?: string
  protocol: 'TCP' | 'UDP' | 'BOTH'
  action: 'DIRECT' | 'BLOCK' | 'PROXY'
  isEnabled?: boolean
  proxyConfigId?: string
}

export interface ProfileRequest {
  version: string
  localhostViaProxy?: boolean
  trafficLogging?: boolean
  proxies: ProxyConfigRequest[]
  rules: RuleRequest[]
}

// Profile 数据模型（落盘 JSON）
// Id 为字符串（如 "p1"），见 AC-18 校准
export interface ProxyConfig {
  Id: string
  Type: 'socks5' | 'http'
  Host: string
  Port: string
  Username?: string
  Password?: string
}

export interface ProxyRule {
  ProcessName: string
  TargetHosts?: string
  TargetPorts?: string
  Protocol: 'TCP' | 'UDP' | 'BOTH'
  Action: 'DIRECT' | 'BLOCK' | 'PROXY'
  IsEnabled?: boolean
  ProxyConfigId?: string
}

export interface ProfileData {
  Version: string
  LocalhostViaProxy?: boolean
  IsTrafficLoggingEnabled?: boolean
  ProxyConfigs: ProxyConfig[]
  ProxyRules: ProxyRule[]
}

// CLI 定位结果
export interface CliLocation {
  found: boolean
  cliPath: string | null
  version: string | null
  coreDllPresent: boolean
  candidatesTried: string[]
}

// 管理员检测结果
export interface AdminCheckResult {
  isAdmin: boolean
  adminCheckMethod: 'integrity-sid' | 'fsutil-dirty' | 'net-session'
  adminCheckConflict?: boolean
}

// 受管进程状态
export interface ManagedProcess {
  pid: number
  profilePath: string
  verbose: number
  startedAt: Date
  lastExit?: {
    pid: number
    exitCode: number | null
    terminatedAt: Date
    reason: string
  }
}

// 日志行
export interface LogLine {
  n: number
  stream: 'out' | 'err'
  text: string
}

// 环境检查结果
export interface EnvironmentCheckResult {
  found: boolean
  cliPath: string | null
  version: string | null
  coreDllPresent: boolean
  isAdmin: boolean
  adminCheckMethod: string
  adminCheckConflict?: boolean
  candidatesTried: string[]
}
