// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — Profile 生成逻辑（FR-5, FR-6）

import { type ProfileRequest, type ProfileData } from '../types.js'
import { validateProfile } from './validate.js'

/**
 * FR-6 生成 profile
 */
export function buildProfile(request: ProfileRequest): ProfileData {
  // 先跑校验
  const validation = validateProfile(request)
  if (!validation.valid) {
    throw new Error(`Profile validation failed: ${validation.errors.map(e => e.code).join(', ')}`)
  }

  // 转换请求到落盘格式
  const data: ProfileData = {
    Version: request.version,
    LocalhostViaProxy: request.localhostViaProxy ?? false,
    IsTrafficLoggingEnabled: request.trafficLogging ?? true,
    ProxyConfigs: request.proxies.map(p => ({
      Id: p.id,
      Type: p.type,
      Host: p.host,
      Port: String(p.port),
      Username: p.username || undefined,
      Password: p.password || undefined,
    })),
    ProxyRules: request.rules.map(r => ({
      ProcessName: r.processName,
      TargetHosts: r.targetHosts || undefined,
      TargetPorts: r.targetPorts || undefined,
      Protocol: r.protocol,
      Action: r.action,
      IsEnabled: r.isEnabled ?? true,
      ProxyConfigId: r.action === 'PROXY' ? r.proxyConfigId : undefined,
    })),
  }

  return data
}
