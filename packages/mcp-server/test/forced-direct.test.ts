// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — FR-9 强制直连预警 + FR-10 UDP 组合预警单测（AC-6）
//
// FR-9 五组用例（SPEC AC-6）：命中 APIPA → 报；通配段覆盖组播 → 报；
// Protocol=BOTH 且 TargetPorts='*' 覆盖 DHCP 端口 → 报；域类 TargetHosts → 不报；
// Protocol=TCP 且 TargetPorts=67 → 不报。
// FR-10 两条正例：引用 http 与 socks5 各一条，断言 RULE_UDP_REQUIRES_SOCKS5 文案不同。
// 全部用例动作取 PROXY，使其进入强制直连 / UDP 检测分支。

import { describe, it, expect } from 'vitest'
import { validateProfile } from '../src/profile/validate.js'
import { type ProfileRequest, type RuleRequest, type ProxyConfigRequest } from '../src/types.js'

const httpProxy: ProxyConfigRequest = { id: 'p1', type: 'http', host: '127.0.0.1', port: 8080 }
const socksProxy: ProxyConfigRequest = { id: 'p1', type: 'socks5', host: '127.0.0.1', port: 1080 }

function profileOf(rule: RuleRequest, proxy: ProxyConfigRequest = httpProxy): ProfileRequest {
  return {
    version: '1.0',
    proxies: [proxy],
    rules: [rule],
  }
}

function proxyRule(over: Partial<RuleRequest>): RuleRequest {
  return {
    processName: 'app.exe',
    targetHosts: 'example.com',
    targetPorts: '443',
    protocol: 'TCP',
    action: 'PROXY',
    isEnabled: true,
    proxyConfigId: 'p1',
    ...over,
  }
}

function forcedDirectWarnings(p: ProfileRequest) {
  return validateProfile(p).warnings.filter(w => w.code === 'RULE_OVERRIDDEN_BY_FORCED_DIRECT')
}

describe('FR-9 强制直连预警', () => {
  it('用例1：命中 169.254.0.0/16（APIPA/链路本地）→ 报', () => {
    const p = profileOf(proxyRule({ targetHosts: '169.254.0.0/16' }))
    const warnings = forcedDirectWarnings(p)
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    expect(warnings.some(w => w.message.includes('APIPA'))).toBe(true)
  })

  it('用例2：通配段覆盖 IPv4 组播 → 报', () => {
    // '224.0.*.*' 是组播前缀通配段，与组播强制直连段 224.0.0.0–239.255.255.255 构成 SUPERSET
    const p = profileOf(proxyRule({ targetHosts: '224.0.*.*', protocol: 'TCP' }))
    const warnings = forcedDirectWarnings(p)
    expect(warnings.some(w => w.message.includes('组播'))).toBe(true)
  })

  it('用例3：Protocol=BOTH 且 TargetPorts="*" 覆盖 DHCP 端口 → 报', () => {
    // 目标为域类（不命中任何 IP 强制直连段），仅端口维度因 BOTH + '*' 命中 DHCP
    const p = profileOf(proxyRule({ protocol: 'BOTH', targetPorts: '*' }))
    const warnings = forcedDirectWarnings(p)
    expect(warnings.some(w => w.message.includes('DHCP'))).toBe(true)
  })

  it('用例4：TargetHosts 为域类 example.com → 不报', () => {
    // 域类 token 与任何 IP 类强制直连段不可比，静态分析不报
    const p = profileOf(proxyRule({ targetHosts: 'example.com', protocol: 'TCP', targetPorts: '443' }))
    expect(forcedDirectWarnings(p)).toHaveLength(0)
  })

  it('用例5：Protocol=TCP 且 TargetPorts=67 → 不报', () => {
    // DHCP 是 UDP 专属，TCP 规则不触发端口维度预警
    const p = profileOf(proxyRule({ protocol: 'TCP', targetPorts: '67' }))
    expect(forcedDirectWarnings(p)).toHaveLength(0)
  })
})

describe('FR-10 UDP 组合预警', () => {
  it('引用 http 代理的 UDP 规则：警告文案点名 HTTP 不支持 UDP', () => {
    const p = profileOf(proxyRule({ protocol: 'UDP', targetPorts: '443' }), httpProxy)
    const warnings = validateProfile(p).warnings.filter(w => w.code === 'RULE_UDP_REQUIRES_SOCKS5')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('HTTP')
    expect(warnings[0].message).toContain('不支持 UDP')
  })

  it('引用 socks5 代理的 BOTH 规则：警告文案指向 UDP ASSOCIATE，且与 http 文案不同', () => {
    const httpP = profileOf(proxyRule({ protocol: 'UDP', targetPorts: '443' }), httpProxy)
    const socksP = profileOf(proxyRule({ protocol: 'BOTH', targetPorts: '443' }), socksProxy)

    const httpMsg = validateProfile(httpP).warnings
      .filter(w => w.code === 'RULE_UDP_REQUIRES_SOCKS5')[0].message
    const socksWarnings = validateProfile(socksP).warnings
      .filter(w => w.code === 'RULE_UDP_REQUIRES_SOCKS5')
    const socksMsg = socksWarnings[0].message

    expect(socksWarnings).toHaveLength(1)
    expect(socksMsg).toContain('SOCKS5')
    expect(socksMsg).toContain('UDP ASSOCIATE')
    // 两条文案必须不同，否则 FR-10 按类型分支的意义丢失
    expect(socksMsg).not.toBe(httpMsg)
  })
})