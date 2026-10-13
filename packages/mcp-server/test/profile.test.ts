// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 单元测试

import { describe, it, expect } from 'vitest'
import { validateProfile } from '../src/profile/validate.js'
import { buildProfile } from '../src/profile/build.js'
import { type ProfileRequest } from '../src/types.js'

const validProfile: ProfileRequest = {
  version: '1.0',
  localhostViaProxy: false,
  trafficLogging: true,
  proxies: [
    {
      id: 1,
      type: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: '',
      password: '',
    },
  ],
  rules: [
    {
      processName: 'chrome.exe',
      targetHosts: '*',
      targetPorts: '*',
      protocol: 'TCP',
      action: 'PROXY',
      isEnabled: true,
      proxyConfigId: 1,
    },
  ],
}

describe('Profile Validation', () => {
  it('should validate a correct profile', () => {
    const result = validateProfile(validProfile)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should reject invalid version', () => {
    const invalid = { ...validProfile, version: '2.0' }
    const result = validateProfile(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.code === 'PROFILE_VERSION_UNSUPPORTED')).toBe(true)
  })

  it('should reject empty proxies', () => {
    const invalid = { ...validProfile, proxies: [] }
    const result = validateProfile(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.code === 'PROXY_LIST_EMPTY')).toBe(true)
  })

  it('should reject duplicate proxy IDs', () => {
    const invalid = {
      ...validProfile,
      proxies: [
        { id: 1, type: 'socks5', host: '127.0.0.1', port: 1080 },
        { id: 1, type: 'http', host: '127.0.0.1', port: 8080 },
      ],
    }
    const result = validateProfile(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.code === 'PROXY_ID_DUPLICATE')).toBe(true)
  })
})

describe('Profile Building', () => {
  it('should build a valid profile', () => {
    const result = buildProfile(validProfile)
    expect(result.Version).toBe('1.0')
    expect(result.ProxyConfigs).toHaveLength(1)
    expect(result.ProxyRules).toHaveLength(1)
  })

  it('should convert port to string', () => {
    const result = buildProfile(validProfile)
    expect(typeof result.ProxyConfigs[0].Port).toBe('string')
  })
})
