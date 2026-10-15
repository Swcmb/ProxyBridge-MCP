// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — FR-8 规则遮蔽检测单测（AC-5）
//
// 正例 4 条（报 RULE_SHADOWED）+ 反例 3 条（不报），覆盖 SPEC §4 FR-8
// 判定算法的「归一化 → 四态比较 → 规则级合并 → 保守不报」四步。
// 遮蔽用例统一用 DIRECT 动作，使 FR-9 / FR-10 不产生干扰警告。

import { describe, it, expect } from 'vitest'
import { validateProfile } from '../src/profile/validate.js'
import { type ProfileRequest, type RuleRequest } from '../src/types.js'

// 以规则列表拼一个最小合法 profile（至少一个代理，避免 PROXY_LIST_EMPTY）
function profileOf(rules: RuleRequest[]): ProfileRequest {
  return {
    version: '1.0',
    proxies: [{ id: 'p1', type: 'socks5', host: '127.0.0.1', port: 1080 }],
    rules,
  }
}

function rule(over: Partial<RuleRequest>): RuleRequest {
  return {
    processName: 'app.exe',
    targetHosts: 'example.com',
    targetPorts: '443',
    protocol: 'TCP',
    action: 'DIRECT',
    isEnabled: true,
    ...over,
  }
}

function shadowCount(p: ProfileRequest): number {
  return validateProfile(p).warnings.filter(w => w.code === 'RULE_SHADOWED').length
}

describe('FR-8 遮蔽检测 — 正例（报 RULE_SHADOWED）', () => {
  it('正例1：ALL(*) 遮蔽任意进程名', () => {
    // 前置规则 processName='*' 匹配一切，后置规则永不被求值
    const p = profileOf([
      rule({ processName: '*' }),
      rule({ processName: 'chrome.exe' }),
    ])
    expect(shadowCount(p)).toBe(1)
  })

  it('正例2：通配段遮蔽具体 IP', () => {
    // 前置 targetHosts='192.168.*.*' 覆盖后置的具体 IP
    const p = profileOf([
      rule({ targetHosts: '192.168.*.*' }),
      rule({ targetHosts: '192.168.1.10' }),
    ])
    expect(shadowCount(p)).toBe(1)
  })

  it('正例3：区间真包含（Protocol=BOTH 覆盖 TCP）', () => {
    // 其余字段全同，仅协议为严格超集 {TCP,UDP} ⊇ {TCP}
    const p = profileOf([
      rule({ protocol: 'BOTH' }),
      rule({ protocol: 'TCP' }),
    ])
    expect(shadowCount(p)).toBe(1)
  })

  it('正例4：非代理字段全同，仅一字段更宽（TargetPorts=*）', () => {
    // processName / targetHosts / protocol 全同，仅端口从 '443' 放宽为 '*'
    const p = profileOf([
      rule({ targetPorts: '*' }),
      rule({ targetPorts: '443' }),
    ])
    expect(shadowCount(p)).toBe(1)
  })
})

describe('FR-8 遮蔽检测 — 反例（不报）', () => {
  it('反例1：具体进程名在前、通配在后，不构成遮蔽', () => {
    // 前置 'chrome.exe' 无法覆盖后置 'ch*'（后者还匹配其它进程），判 UNCOMPARABLE 不报
    const p = profileOf([
      rule({ processName: 'chrome.exe' }),
      rule({ processName: 'ch*' }),
    ])
    expect(shadowCount(p)).toBe(0)
  })

  it('反例2：IP vs 区间不可比，不构成遮蔽', () => {
    // 精确 IP '10.1.1.1' 与 CIDR 区间 '10.0.0.0/8' 无序关系，判 UNCOMPARABLE 不报
    const p = profileOf([
      rule({ targetHosts: '10.1.1.1' }),
      rule({ targetHosts: '10.0.0.0/8' }),
    ])
    expect(shadowCount(p)).toBe(0)
  })

  it('反例3：前置或后置任一方禁用则不报', () => {
    const enabled = profileOf([
      rule({ processName: '*' }),
      rule({ processName: 'chrome.exe' }),
    ])
    // 对照组：双方启用时确实遮蔽，确保用例非空转
    expect(shadowCount(enabled)).toBe(1)

    // 前置禁用
    const frontDisabled = profileOf([
      rule({ processName: '*', isEnabled: false }),
      rule({ processName: 'chrome.exe' }),
    ])
    expect(shadowCount(frontDisabled)).toBe(0)

    // 后置禁用
    const backDisabled = profileOf([
      rule({ processName: '*' }),
      rule({ processName: 'chrome.exe', isEnabled: false }),
    ])
    expect(shadowCount(backDisabled)).toBe(0)
  })
})