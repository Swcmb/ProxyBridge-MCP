// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — Profile 校验逻辑（FR-5, FR-7, FR-8, FR-9, FR-10）

import {
  type ProfileRequest,
  type RuleRequest,
  type ProxyConfigRequest,
} from '../types.js'
import {
  type ValidationResult,
  type ValidationError,
  type WarningResult,
  validationError,
  warningResult,
} from '../errors.js'

// ============ FR-5 基础校验 ============

export function validateProfile(profile: ProfileRequest): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: WarningResult[] = []

  // FR-5: Version 校验
  if (profile.version !== '1.0') {
    errors.push(validationError(
      'PROFILE_VERSION_UNSUPPORTED',
      `Version 只支持 "1.0"，收到 "${profile.version}"`,
      'Version'
    ))
  }

  // FR-5: Proxies 校验
  const proxyResult = validateProxies(profile.proxies)
  errors.push(...proxyResult.errors)
  warnings.push(...proxyResult.warnings)

  // FR-5: Rules 校验
  const ruleResult = validateRules(profile.rules, profile.proxies)
  errors.push(...ruleResult.errors)
  warnings.push(...ruleResult.warnings)

  // FR-8: 规则遮蔽检测
  const shadowWarnings = detectShadowedRules(profile.rules)
  warnings.push(...shadowWarnings)

  // FR-9: 强制直连预警
  const forcedDirectWarnings = detectForcedDirectOverrides(profile.rules)
  warnings.push(...forcedDirectWarnings)

  // FR-10: UDP 组合预警
  const udpWarnings = detectUdpWarnings(profile.rules, profile.proxies)
  warnings.push(...udpWarnings)

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

// ============ FR-5 代理配置校验 ============

interface ValidationSubResult {
  errors: ValidationError[]
  warnings: WarningResult[]
}

function validateProxies(proxies: ProxyConfigRequest[]): ValidationSubResult {
  const errors: ValidationError[] = []
  const warnings: WarningResult[] = []

  // PROXY_LIST_EMPTY
  if (proxies.length === 0) {
    errors.push(validationError('PROXY_LIST_EMPTY', 'ProxyConfigs 为空', 'ProxyConfigs'))
    return { errors, warnings }
  }

  // PROXY_LIMIT_EXCEEDED
  if (proxies.length > 16) {
    errors.push(validationError('PROXY_LIMIT_EXCEEDED', `代理配置数 ${proxies.length} 超过上限 16`, 'ProxyConfigs'))
  }

  const ids = new Set<string>()

  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i]

    // PROXY_ID_DUPLICATE
    if (ids.has(proxy.id)) {
      const duplicateIndex = proxies.findIndex((p, idx) => idx !== i && p.id === proxy.id)
      errors.push(validationError(
        'PROXY_ID_DUPLICATE',
        `proxies[${i}].id=${proxy.id} 与第 ${duplicateIndex} 项重复`,
        `ProxyConfigs[${i}].Id`
      ))
    }
    ids.add(proxy.id)

    // PROXY_TYPE_INVALID
    if (proxy.type !== 'socks5' && proxy.type !== 'http') {
      errors.push(validationError(
        'PROXY_TYPE_INVALID',
        `proxies[${i}].type="${proxy.type}" 非法`,
        `ProxyConfigs[${i}].Type`
      ))
    }

    // PROXY_PORT_INVALID
    const portNum = typeof proxy.port === 'number' ? proxy.port : parseInt(proxy.port as string, 10)
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      errors.push(validationError(
        'PROXY_PORT_INVALID',
        `proxies[${i}].port=${proxy.port} 非法`,
        `ProxyConfigs[${i}].Port`
      ))
    }
  }

  return { errors, warnings }
}

// ============ FR-5 规则校验 ============

function validateRules(rules: RuleRequest[], proxies: ProxyConfigRequest[]): ValidationSubResult {
  const errors: ValidationError[] = []
  const warnings: WarningResult[] = []

  // RULE_LIMIT_EXCEEDED
  if (rules.length > 200) {
    errors.push(validationError('RULE_LIMIT_EXCEEDED', `规则数 ${rules.length} 超过上限 200`, 'ProxyRules'))
  }

  const proxyIds = new Set(proxies.map(p => p.id))

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]

    // RULE_PROCESS_EMPTY
    if (!rule.processName || rule.processName.trim() === '') {
      errors.push(validationError(
        'RULE_PROCESS_EMPTY',
        `rules[${i}].processName 为空`,
        `ProxyRules[${i}].ProcessName`
      ))
    }

    // RULE_ACTION_INVALID
    if (rule.action !== 'DIRECT' && rule.action !== 'BLOCK' && rule.action !== 'PROXY') {
      errors.push(validationError(
        'RULE_ACTION_INVALID',
        `rules[${i}].action="${rule.action}" 非法`,
        `ProxyRules[${i}].Action`
      ))
    }

    // RULE_PROTOCOL_INVALID
    if (rule.protocol !== 'TCP' && rule.protocol !== 'UDP' && rule.protocol !== 'BOTH') {
      errors.push(validationError(
        'RULE_PROTOCOL_INVALID',
        `rules[${i}].protocol="${rule.protocol}" 非法`,
        `ProxyRules[${i}].Protocol`
      ))
    }

    // RULE_PROXY_REF_MISSING
    if (rule.action === 'PROXY') {
      if (rule.proxyConfigId === undefined || rule.proxyConfigId === null) {
        errors.push(validationError(
          'RULE_PROXY_REF_MISSING',
          `rules[${i}].action=PROXY 但 ProxyConfigId 未设置`,
          `ProxyRules[${i}].ProxyConfigId`
        ))
      } else if (!proxyIds.has(rule.proxyConfigId)) {
        errors.push(validationError(
          'RULE_PROXY_REF_MISSING',
          `rules[${i}].action=PROXY 但 ProxyConfigId=${rule.proxyConfigId} 未命中任何代理`,
          `ProxyRules[${i}].ProxyConfigId`
        ))
      }
    } else {
      // RULE_PROXY_REF_ON_NON_PROXY（降级为警告）
      if (rule.proxyConfigId !== undefined && rule.proxyConfigId !== null) {
        warnings.push(warningResult(
          'RULE_PROXY_REF_ON_NON_PROXY',
          `rules[${i}].action=${rule.action} 但携带 ProxyConfigId=${rule.proxyConfigId}`,
          `ProxyRules[${i}].ProxyConfigId`
        ))
      }
    }

    // FR-5.2 TargetHosts 格式校验
    if (rule.targetHosts && rule.targetHosts.trim() !== '' && rule.targetHosts !== '*') {
      const hostSegments = rule.targetHosts.split(';').map(s => s.trim())
      for (const seg of hostSegments) {
        if (!validateHostSegment(seg)) {
          errors.push(validationError(
            'PROFILE_HOST_PATTERN_INVALID',
            `rules[${i}].targetHosts 片段 "${seg}" 无法解析`,
            `ProxyRules[${i}].TargetHosts`
          ))
          break
        }
      }
    }

    // FR-5.3 TargetPorts 格式校验
    if (rule.targetPorts && rule.targetPorts.trim() !== '' && rule.targetPorts !== '*') {
      const portSegments = rule.targetPorts.split(';').map(s => s.trim())
      for (const seg of portSegments) {
        if (!validatePortSegment(seg)) {
          errors.push(validationError(
            'PROFILE_PORT_PATTERN_INVALID',
            `rules[${i}].targetPorts 片段 "${seg}" 无法解析`,
            `ProxyRules[${i}].TargetPorts`
          ))
          break
        }
      }
    }
  }

  return { errors, warnings }
}

function validateHostSegment(segment: string): boolean {
  if (!segment || segment === '*') return true

  // IPv4 精确地址
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(segment)) {
    const parts = segment.split('.').map(Number)
    return parts.every(p => p >= 0 && p <= 255)
  }

  // IPv4 通配段
  if (/^\d{1,3}\.\d{1,3}\.\*\.\d{1,3}$/.test(segment)) return true
  if (/^\d{1,3}\.\*\.\d{1,3}\.\d{1,3}$/.test(segment)) return true

  // IPv4 区间
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}-\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(segment)) return true

  // IPv4 CIDR（宽容接受）
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(segment)) return true

  // IPv6 精确地址
  if (/^[0-9a-fA-F:]+$/.test(segment) && segment.includes(':')) {
    return (segment.match(/:/g) || []).length >= 2
  }

  // IPv6 CIDR
  if (/^[0-9a-fA-F:]+\/\d{1,3}$/.test(segment)) return true

  // IPv6 区间
  if (/^[0-9a-fA-F:]+-[0-9a-fA-F:]+$/.test(segment)) return true

  // 域名通配
  if (/^[a-zA-Z0-9*._-]+$/.test(segment)) return true

  return false
}

function validatePortSegment(segment: string): boolean {
  if (!segment) return true

  // 单个端口
  if (/^\d+$/.test(segment)) {
    const port = parseInt(segment, 10)
    return port >= 0 && port <= 65535
  }

  // 区间
  if (/^\d+-\d+$/.test(segment)) {
    const [start, end] = segment.split('-').map(Number)
    return start >= 0 && start <= 65535 && end >= 0 && end <= 65535 && start <= end
  }

  return false
}

// ============ FR-8 规则遮蔽检测 ============

function detectShadowedRules(rules: RuleRequest[]): WarningResult[] {
  const warnings: WarningResult[] = []

  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      // 任一方禁用则不报
      if (rules[i].isEnabled === false) continue
      if (rules[j].isEnabled === false) continue

      if (isRuleShadows(rules[i], rules[j])) {
        warnings.push(warningResult(
          'RULE_SHADOWED',
          `rules[${j}] 被 rules[${i}] 完全遮蔽，永远不会被求值`,
          `ProxyRules[${j}].ProcessName`
        ))
      }
    }
  }

  return warnings
}

function isRuleShadows(a: RuleRequest, b: RuleRequest): boolean {
  const processNameResult = compareField('processName', a.processName, b.processName)
  const targetHostsResult = compareField('targetHosts', a.targetHosts, b.targetHosts)
  const targetPortsResult = compareField('targetPorts', a.targetPorts, b.targetPorts)
  const protocolResult = compareProtocol(a.protocol, b.protocol)

  const allValid = [
    processNameResult === 'SUPERSET' || processNameResult === 'SAME',
    targetHostsResult === 'SUPERSET' || targetHostsResult === 'SAME',
    targetPortsResult === 'SUPERSET' || targetPortsResult === 'SAME',
    protocolResult === 'SUPERSET' || protocolResult === 'SAME',
  ].every(Boolean)

  if (!allValid) return false

  const strictSuperset = [
    processNameResult === 'SUPERSET',
    targetHostsResult === 'SUPERSET',
    targetPortsResult === 'SUPERSET',
    protocolResult === 'SUPERSET',
  ].some(Boolean)

  return strictSuperset
}

type FieldComparison = 'SUPERSET' | 'SAME' | 'UNCOMPARABLE' | 'INCOMPARABLE'

function compareField(name: string, a: string | undefined, b: string | undefined): FieldComparison {
  const aVal = (a || '*').trim().toLowerCase()
  const bVal = (b || '*').trim().toLowerCase()

  if (aVal === '*' || aVal === '') return 'SUPERSET'
  if (bVal === '*' || bVal === '') return name === 'processName' ? 'UNCOMPARABLE' : 'INCOMPARABLE'
  if (aVal === bVal) return 'SAME'
  if (aVal.includes('*')) return 'SUPERSET'
  return 'UNCOMPARABLE'
}

function compareProtocol(a: string, b: string): FieldComparison {
  const protocolMap: Record<string, Set<string>> = {
    'TCP': new Set(['TCP']),
    'UDP': new Set(['UDP']),
    'BOTH': new Set(['TCP', 'UDP']),
  }

  const aSet = protocolMap[a] || new Set()
  const bSet = protocolMap[b] || new Set()

  if (aSet.size === 0 || bSet.size === 0) return 'INCOMPARABLE'
  if (aSet.has('TCP') && aSet.has('UDP')) return 'SUPERSET'
  if (bSet.has('TCP') && bSet.has('UDP')) return 'UNCOMPARABLE'
  // Manual set equality check since Set.prototype.equals doesn't exist
  if (aSet.size === bSet.size && [...aSet].every(v => bSet.has(v))) return 'SAME'

  if (aSet.size === 1 && bSet.size === 1 && aSet.has([...bSet][0])) return 'SUPERSET'

  return 'UNCOMPARABLE'
}

// ============ FR-9 强制直连预警 ============

function detectForcedDirectOverrides(rules: RuleRequest[]): WarningResult[] {
  const warnings: WarningResult[] = []

  for (const rule of rules) {
    if (rule.action !== 'PROXY') continue
    if (rule.isEnabled === false) continue

    const hits = checkForcedDirectTargets(rule)
    for (const hit of hits) {
      warnings.push(warningResult(
        'RULE_OVERRIDDEN_BY_FORCED_DIRECT',
        `规则 PROXY 动作将命中强制直连目标: ${hit}`,
        null
      ))
    }
  }

  return warnings
}

function checkForcedDirectTargets(rule: RuleRequest): string[] {
  const hits: string[] = []
  const hosts = rule.targetHosts || '*'
  const ports = rule.targetPorts || '*'
  const protocol = rule.protocol

  if (hosts === '*' || hosts.includes('255.255.255.255') || hosts.includes('*.255')) {
    hits.push('IPv4 广播地址')
  }

  if (hosts === '*' || matchesMulticastRange(hosts)) {
    hits.push('IPv4 组播地址')
  }

  if (hosts === '*' || hosts.includes('169.254')) {
    hits.push('IPv4 APIPA/链路本地地址')
  }

  if ((protocol === 'UDP' || protocol === 'BOTH') && (ports === '*' || ports.includes('67') || ports.includes('68'))) {
    hits.push('IPv4 DHCP 端口')
  }

  if (hosts === '*' || hosts.toLowerCase().includes('ff')) {
    hits.push('IPv6 组播地址')
  }

  if (hosts === '*' || hosts.toLowerCase().includes('fe80')) {
    hits.push('IPv6 链路本地地址')
  }

  if (hosts === '*' || hosts.includes('::')) {
    hits.push('IPv6 未指定地址')
  }

  if ((protocol === 'UDP' || protocol === 'BOTH') && (ports === '*' || ports.includes('546') || ports.includes('547'))) {
    hits.push('IPv6 DHCPv6 端口')
  }

  return hits
}

function matchesMulticastRange(hosts: string): boolean {
  return hosts.includes('224.') || hosts.includes('225.') ||
         hosts.includes('226.') || hosts.includes('227.') ||
         hosts.includes('228.') || hosts.includes('229.') ||
         hosts.includes('230.') || hosts.includes('231.') ||
         hosts.includes('232.') || hosts.includes('233.') ||
         hosts.includes('234.') || hosts.includes('235.') ||
         hosts.includes('236.') || hosts.includes('237.') ||
         hosts.includes('238.') || hosts.includes('239.')
}

// ============ FR-10 UDP 组合预警 ============

function detectUdpWarnings(rules: RuleRequest[], proxies: ProxyConfigRequest[]): WarningResult[] {
  const warnings: WarningResult[] = []
  const proxyMap = new Map(proxies.map(p => [p.id, p]))

  for (const rule of rules) {
    if (rule.action !== 'PROXY') continue
    if (rule.protocol !== 'UDP' && rule.protocol !== 'BOTH') continue

    const proxy = proxyMap.get(rule.proxyConfigId!)
    if (!proxy) continue

    if (proxy.type === 'http') {
      warnings.push(warningResult(
        'RULE_UDP_REQUIRES_SOCKS5',
        'HTTP 代理不支持 UDP，此类流量会直连而非报错，容易被误认为规则未生效',
        null
      ))
    } else if (proxy.type === 'socks5') {
      warnings.push(warningResult(
        'RULE_UDP_REQUIRES_SOCKS5',
        'SOCKS5 只是 UDP 转发的必要条件，还需代理服务器实现 UDP ASSOCIATE；否则 UDP 流量直连或被丢弃',
        null
      ))
    }
  }

  return warnings
}
