// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 写路径安全校验（NFR-6）

/**
 * 盘符相对路径形如 `C:foo`（盘符 + 冒号 + 相对路径），不含路径分隔符。
 * Node 的 win32.resolve 按「该盘符的当前工作目录」解释它，落到哪里取决于进程 CWD：
 * 实测 `C:foo.pbprofile` 恰好留在基准目录内，而 `c:x.pbprofile` 却逃到 C 盘根。
 * 同一输入在不同 CWD 下结论相反，属不可预测行为，只能在门禁处整类拒绝。
 */
const DRIVE_LETTER = /^[A-Za-z]:/

/**
 * 写盘工具只接受纯文件名：含路径分隔符、`..`、盘符前缀或绝对路径一律拒绝。
 * 与基准目录的解引用交给调用方（index.ts 的 resolve），此处只做字符串级门禁，
 * 保证 `..\x.pbprofile`、`a/b.pbprofile`、`C:\x.pbprofile`、`C:x.pbprofile`
 * 四类穿越输入被拦下（AC-22）。
 */
export function isSafeFilename(filename: string): boolean {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..') || filename.startsWith('/')) {
    return false
  }
  if (DRIVE_LETTER.test(filename)) {
    return false
  }
  return true
}
