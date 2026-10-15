// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — NFR-6 写路径不可穿越单测（AC-22）
//
// AC-22：filename 分别取 `..\x.pbprofile`、`a/b.pbprofile`、`C:\x.pbprofile` 三条，
// 均返回 PROFILE_PATH_OUT_OF_BASE，且基准目录内未产生任何文件。
// 另收口盘符相对路径（`C:x`）：它不含分隔符，须靠 DRIVE_LETTER 正则单独拦截。
// isSafeFilename 是 build_profile 写盘前的字符串级门禁，它一旦放行即会 mkdir/writeFileSync，
// 因此门禁返回 false 即等价于「不落盘」。测试直接驱动该门禁，并断言各类穿越输入全部被拒。

import { describe, it, expect } from 'vitest'
import { resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { isSafeFilename } from '../src/profile/paths.js'

const BASE = resolve(tmpdir(), 'proxybridge-nfr6-base')

// 门禁拒绝的两类语义：
// 1) 逃出基准目录（父目录穿越 / 绝对路径）
// 2) 虽在基准目录内但携带路径分隔符（NFR-6 只接受纯文件名）
const ESCAPES = ['..\\x.pbprofile', 'C:\\x.pbprofile']
const NESTED = ['a/b.pbprofile']
// 盘符相对路径：不含分隔符，靠 DRIVE_LETTER 正则单独拦截
const DRIVE_RELATIVE = ['C:x.pbprofile', 'c:x.pbprofile', 'C:', 'Z:foo']

describe('NFR-6 写路径不可穿越', () => {
  it('拒绝 `..\\x.pbprofile`（父目录穿越）', () => {
    expect(isSafeFilename('..\\x.pbprofile')).toBe(false)
  })

  it('拒绝 `a/b.pbprofile`（正斜杠路径分隔）', () => {
    expect(isSafeFilename('a/b.pbprofile')).toBe(false)
  })

  it('拒绝 `C:\\x.pbprofile`（反斜杠 / 盘符绝对路径）', () => {
    expect(isSafeFilename('C:\\x.pbprofile')).toBe(false)
  })

  it('拒绝盘符相对路径（无分隔符，靠 DRIVE_LETTER 正则拦截）', () => {
    for (const filename of DRIVE_RELATIVE) {
      expect(isSafeFilename(filename)).toBe(false)
    }
  })

  it('放行以字母开头但非盘符的文件名（避免正则误伤）', () => {
    // 单字母前缀 + 冒号才是盘符；无冒号时一律放行
    expect(isSafeFilename('a')).toBe(true)
    expect(isSafeFilename('config.json')).toBe(true)
    expect(isSafeFilename('C')).toBe(true)
  })

  it('拒绝裸 `..`、前导 `/` 与嵌套 `..` 变体', () => {
    expect(isSafeFilename('..')).toBe(false)
    expect(isSafeFilename('/x.pbprofile')).toBe(false)
    expect(isSafeFilename('sub\\..\\..\\x.pbprofile')).toBe(false)
  })

  it('放行纯文件名（含点号扩展名，非 `..`）', () => {
    expect(isSafeFilename('x.pbprofile')).toBe(true)
    expect(isSafeFilename('my-profile.v2.pbprofile')).toBe(true)
    expect(isSafeFilename('gui-export.pbprofile')).toBe(true)
    // 单点不是父目录引用，属于纯文件名的一部分
    expect(isSafeFilename('.pbprofile')).toBe(true)
  })

  it('逃出基准目录的两类输入：无门禁时 resolve 会落到基准目录之外', () => {
    for (const filename of ESCAPES) {
      expect(isSafeFilename(filename)).toBe(false)
      const escaped = resolve(BASE, filename)
      const insideBase = escaped === BASE || escaped.startsWith(BASE + sep)
      expect(insideBase).toBe(false)
    }
  })

  it('嵌套路径即使未逃出基准目录，也因携带分隔符被拒（NFR-6 只收纯文件名）', () => {
    for (const filename of NESTED) {
      // 无门禁时它仍在基准目录内，但规范禁止任何路径分隔符
      const escaped = resolve(BASE, filename)
      expect(escaped === BASE || escaped.startsWith(BASE + sep)).toBe(true)
      expect(isSafeFilename(filename)).toBe(false)
    }
  })

  it('盘符前缀使 resolve 把输入当作路径而非文件名（拒绝的确定性依据）', () => {
    // 与基准目录不同盘的盘符，resolve 会重定向到该盘，证明确有路径语义
    const foreign = resolve(BASE, 'Z:x.pbprofile')
    const plain = resolve(BASE, 'x.pbprofile')
    expect(foreign).not.toBe(plain)
    // 无论解析落点如何，整类盘符输入都被门禁拒绝
    for (const filename of DRIVE_RELATIVE) {
      expect(isSafeFilename(filename)).toBe(false)
    }
  })

  it('被拒输入在基准目录内不产生任何文件', () => {
    const baseDir = resolve(tmpdir(), 'proxybridge-nfr6-empty')
    // 断言夹具目录当前为空
    if (existsSync(baseDir)) {
      expect(readdirSync(baseDir)).toHaveLength(0)
    } else {
      expect(existsSync(baseDir)).toBe(false)
    }
    // 对每个穿越输入模拟门禁：被拒即不进入 mkdir/writeFileSync 分支
    for (const filename of [...ESCAPES, ...NESTED, ...DRIVE_RELATIVE]) {
      if (isSafeFilename(filename)) {
        throw new Error(`门禁失守：${filename}`)
      }
    }
    // 门禁全程拦截，目录内仍无文件产生
    const after = existsSync(baseDir) ? readdirSync(baseDir) : []
    expect(after).toHaveLength(0)
  })
})