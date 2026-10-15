// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 写路径安全校验（NFR-6）

/**
 * 写盘工具只接受纯文件名：含路径分隔符、`..` 或绝对路径一律拒绝。
 * 与基准目录的解引用交给调用方（index.ts 的 resolve），此处只做字符串级门禁，
 * 保证 `..\x.pbprofile`、`a/b.pbprofile`、`C:\x.pbprofile` 三类穿越输入被拦下（AC-22）。
 */
export function isSafeFilename(filename: string): boolean {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..') || filename.startsWith('/')) {
    return false
  }
  return true
}