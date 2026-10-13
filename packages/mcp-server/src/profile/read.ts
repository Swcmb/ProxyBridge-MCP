// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — Profile 读取（FR-11）

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ProfileData } from '../types.js'
import { toolError } from '../errors.js'

/**
 * FR-11 读取单个 profile
 */
export function readProfile(path: string): ProfileData {
  let content: string

  try {
    content = readFileSync(path, 'utf-8')
  } catch (err) {
    throw toolError('PROFILE_NOT_FOUND', `文件不存在：${path}`, '用 proxybridge_list_profiles 查看现有 profile', null)
  }

  let parsed: any
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    throw toolError('PROFILE_PARSE_ERROR', `解析失败：${(err as Error).message}`, '检查文件编码与 JSON 结构', null)
  }

  // 密码遮蔽
  if (parsed.ProxyConfigs) {
    for (const config of parsed.ProxyConfigs) {
      if (config.Password) {
        config.Password = '***'
      }
    }
  }

  return parsed
}

/**
 * FR-11 列举目录下的 .pbprofile 文件
 */
export function listProfiles(dir: string): { name: string; sizeBytes: number; modifiedAt: string }[] {
  // 这里先用简单实现，实际需要用 readdir + stat
  // 由于 fs 模块在后续实现，这里暂留空
  return []
}
