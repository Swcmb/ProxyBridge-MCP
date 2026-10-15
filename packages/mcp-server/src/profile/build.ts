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

/**
 * 落盘 ProfileData（PascalCase）→ 校验入参 ProfileRequest（camelCase）
 * 供 proxybridge_validate_profile 的 path 分支使用（FR-11/AC-18）
 */
export function toProfileRequest(data: Partial<ProfileData>): ProfileRequest {
  const proxies = Array.isArray(data.ProxyConfigs) ? data.ProxyConfigs : []
  const rules = Array.isArray(data.ProxyRules) ? data.ProxyRules : []
  return {
    version: String((data as any).Version ?? ''),
    localhostViaProxy: data.LocalhostViaProxy,
    trafficLogging: data.IsTrafficLoggingEnabled,
    proxies: proxies.map(p => ({
      id: String((p as any).Id ?? ''),
      type: p.Type,
      host: p.Host,
      port: p.Port,
      username: p.Username,
      password: p.Password,
    })),
    rules: rules.map(r => ({
      processName: r.ProcessName,
      targetHosts: r.TargetHosts,
      targetPorts: r.TargetPorts,
      protocol: r.Protocol,
      action: r.Action,
      isEnabled: r.IsEnabled,
      proxyConfigId: r.ProxyConfigId !== undefined ? String(r.ProxyConfigId) : undefined,
    })),
  }
}
