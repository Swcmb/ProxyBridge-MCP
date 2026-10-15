// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — 入口与工具注册

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { supervisor } from './process/supervisor.js'
import { validateProfile } from './profile/validate.js'
import { buildProfile, toProfileRequest } from './profile/build.js'
import { readProfile } from './profile/read.js'
import { probeProxy } from './net/probe.js'
import { locateCli } from './cli/locate.js'
import { checkAdmin } from './cli/admin.js'
import { toolError } from './errors.js'
import { resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

// 横幅打印（NFR-13）
function printBanner() {
  const isTTY = process.stdin.isTTY || process.env.PROXYBRIDGE_MCP_BANNER === '1'
  if (isTTY) {
    const banner = `
╔══════════════════════════════════════════════════╗
║         ProxyBridge MCP Server v0.1.0            ║
║                    GPL-3.0                       ║
║          Agent-friendly ProxyBridge wrapper       ║
╚══════════════════════════════════════════════════╝
`
    process.stderr.write(banner)
  }
}

printBanner()

const server = new Server(
  {
    name: 'proxybridge-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// 工具定义
// openWorldHint 口径：凡工具会 spawn 外部进程或建立网络连接者，一律 ✓；仅读写 MCP 自身进程与本地文件系统边界内的对象者，为 ✗
const TOOLS = [
  {
    name: 'proxybridge_check_environment',
    description: '检查 ProxyBridge CLI 环境和管理员状态',
    inputSchema: {
      type: 'object',
      properties: {
        cliPath: { type: 'string', description: '可选，CLI 可执行文件路径' },
      },
    },
    readOnlyHint: '✓',
    destructiveHint: '✗',
    idempotentHint: '✓',
    openWorldHint: '✓',
  },
  {
    name: 'proxybridge_build_profile',
    description: '生成并写入 .pbprofile 文件',
    inputSchema: {
      type: 'object',
      required: ['filename', 'profile'],
      properties: {
        filename: { type: 'string', description: '纯文件名，不接受路径' },
        profile: { type: 'object', description: 'Profile 数据结构' },
        overwrite: { type: 'boolean', description: '是否覆盖已有文件' },
        dir: { type: 'string', description: '可选，指定输出目录' },
      },
    },
    readOnlyHint: '✗',
    destructiveHint: '✗',
    idempotentHint: '✓',
    openWorldHint: '✗',
  },
  {
    name: 'proxybridge_validate_profile',
    description: '校验 profile 合法性',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '可选，文件路径' },
        profile: { type: 'object', description: '可选，profile 对象' },
      },
    },
    readOnlyHint: '✓',
    destructiveHint: '✗',
    idempotentHint: '✓',
    openWorldHint: '✗',
  },
  {
    name: 'proxybridge_list_profiles',
    description: '列举目录下的 .pbprofile 文件',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '可选，目录路径' },
      },
    },
    readOnlyHint: '✓',
    destructiveHint: '✗',
    idempotentHint: '✓',
    openWorldHint: '✗',
  },
  {
    name: 'proxybridge_read_profile',
    description: '读取并解析单个 profile',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'profile 文件的绝对路径' },
      },
    },
    readOnlyHint: '✓',
    destructiveHint: '✗',
    idempotentHint: '✓',
    openWorldHint: '✗',
  },
  {
    name: 'proxybridge_start',
    description: '启动 ProxyBridge CLI 进程',
    inputSchema: {
      type: 'object',
      required: ['profilePath'],
      properties: {
        profilePath: { type: 'string', description: 'profile 文件绝对路径' },
        verbose: { type: 'number', enum: [0, 1, 2, 3], description: '日志级别' },
        cliPath: { type: 'string', description: '可选，覆盖 CLI 路径' },
        readyTimeoutMs: { type: 'number', description: '就绪窗口毫秒数' },
      },
    },
    readOnlyHint: '✗',
    destructiveHint: '✓',
    idempotentHint: '✓',
    openWorldHint: '✓',
  },
  {
    name: 'proxybridge_status',
    description: '查询 CLI 进程状态',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    readOnlyHint: '✓',
    destructiveHint: '✗',
    idempotentHint: '✓',
    openWorldHint: '✗',
  },
  {
    name: 'proxybridge_logs',
    description: '读取 CLI 进程日志',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: '返回行数上限' },
        tail: { type: 'number', description: '向后兼容别名' },
      },
    },
    readOnlyHint: '✓',
    destructiveHint: '✗',
    idempotentHint: '✓',
    openWorldHint: '✗',
  },
  {
    name: 'proxybridge_stop',
    description: '停止 CLI 进程',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMs: { type: 'number', description: '等待超时毫秒数' },
      },
    },
    readOnlyHint: '✗',
    destructiveHint: '✓',
    idempotentHint: '✓',
    openWorldHint: '✓',
  },
  {
    name: 'proxybridge_test_proxy',
    description: '测试代理端点连通性',
    inputSchema: {
      type: 'object',
      required: ['host', 'port'],
      properties: {
        host: { type: 'string', description: '主机地址' },
        port: { type: 'number', description: '端口号' },
        timeoutMs: { type: 'number', description: '超时毫秒数' },
      },
    },
    readOnlyHint: '✓',
    destructiveHint: '✗',
    idempotentHint: '✓',
    openWorldHint: '✓',
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const params = request.params as { name: string; arguments?: Record<string, unknown> }
  const { name } = params
  const args = params.arguments as Record<string, unknown> | undefined

  try {
    switch (name) {
      case 'proxybridge_check_environment': {
        const location = locateCli(args?.['cliPath'] as string | undefined)
        const adminResult = checkAdmin()
        return { content: [{ type: 'text', text: JSON.stringify({
          found: location.found,
          cliPath: location.cliPath,
          version: location.version,
          coreDllPresent: location.coreDllPresent,
          isAdmin: adminResult.isAdmin,
          adminCheckMethod: adminResult.adminCheckMethod,
          adminCheckConflict: adminResult.adminCheckConflict,
          candidatesTried: location.candidatesTried,
        }, null, 2) }] }
      }

      case 'proxybridge_build_profile': {
        const baseDir = getBaseDir(args?.['dir'] as string | undefined)
        const filename = args?.['filename'] as string
        const profile = args?.['profile'] as Record<string, unknown>
        const overwrite = args?.['overwrite'] as boolean || false

        const resolvedPath = resolve(baseDir, filename)

        // 路径安全校验
        if (!isSafeFilename(filename)) {
          throw toolError('PROFILE_PATH_OUT_OF_BASE', `非法输出路径：${filename}，必须落在 ${baseDir} 内`, '只传纯文件名；换目录请用 dir 入参或 PROXYBRIDGE_PROFILE_DIR', null)
        }

        if (existsSync(resolvedPath) && !overwrite) {
          throw toolError('PROFILE_FILE_EXISTS', `文件已存在：${resolvedPath}`, '传 overwrite: true 或换文件名', null)
        }

        // 校验并生成
        const validation = validateProfile(profile as any)
        if (!validation.valid) {
          throw { code: validation.errors[0].code, message: validation.errors[0].message, fieldPath: validation.errors[0].fieldPath, hint: validation.errors[0].fieldPath }
        }

        // 写盘
        try {
          const data = buildProfile(profile as any)
          const json = JSON.stringify(data, null, 2)
          mkdirSync(dirname(resolvedPath), { recursive: true })
          writeFileSync(resolvedPath, json, 'utf-8')

          // 统计动作分布
          const actionCounts: Record<string, number> = {}
          for (const rule of data.ProxyRules) {
            actionCounts[rule.Action] = (actionCounts[rule.Action] || 0) + 1
          }

          return { content: [{ type: 'text', text: JSON.stringify({
            path: resolvedPath,
            proxyCount: data.ProxyConfigs.length,
            ruleCount: data.ProxyRules.length,
            actionCounts,
            warnings: validation.warnings,
            credentialNotice: '该文件含明文凭据，请限制文件访问范围',
          }, null, 2) }] }
        } catch (err) {
          throw toolError('PROFILE_WRITE_FAILED', `写入失败：${resolvedPath}：${(err as Error).message}`, '检查磁盘空间、目录权限与目标路径', null)
        }
      }

      case 'proxybridge_validate_profile': {
        if (args?.['path']) {
          // 从文件读取：落盘 PascalCase → 校验入参 camelCase（AC-18）
          try {
            const content = readFileSync(args['path'] as string, 'utf-8')
            const parsed = JSON.parse(content)
            return { content: [{ type: 'text', text: JSON.stringify(validateProfile(toProfileRequest(parsed)), null, 2) }] }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              throw toolError('PROFILE_NOT_FOUND', `文件不存在：${args['path']}`, '用 proxybridge_list_profiles 查看现有 profile', null)
            }
            throw toolError('PROFILE_PARSE_ERROR', `解析失败：${(err as Error).message}`, '检查文件编码与 JSON 结构', null)
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(validateProfile(args?.['profile'] as any), null, 2) }] }
      }

      case 'proxybridge_list_profiles': {
        const baseDir = getBaseDir(args?.['dir'] as string | undefined)
        try {
          const files = readdirSync(baseDir)
            .filter(f => f.endsWith('.pbprofile'))
            .map(f => {
              const stat = statSync(resolve(baseDir, f))
              return {
                name: f,
                sizeBytes: stat.size,
                modifiedAt: stat.mtime.toISOString(),
              }
            })
          return { content: [{ type: 'text', text: JSON.stringify({ dir: baseDir, files }, null, 2) }] }
        } catch (err) {
          throw toolError('PROFILE_DIR_UNREADABLE', `无法读取目录 ${baseDir}：${(err as Error).message}`, '确认路径与访问权限', null)
        }
      }

      case 'proxybridge_read_profile': {
        const path = args?.['path'] as string
        if (!path) {
          throw toolError('PROFILE_NOT_FOUND', '缺少必需的 path 参数', '请提供 profile 文件路径', null)
        }
        try {
          const content = readFileSync(path, 'utf-8')
          const parsed = JSON.parse(content)
          // 密码遮蔽
          if (parsed.ProxyConfigs) {
            for (const config of parsed.ProxyConfigs) {
              if (config.Password) {
                config.Password = '***'
              }
            }
          }
          return { content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }] }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            throw toolError('PROFILE_NOT_FOUND', `文件不存在：${path}`, '用 proxybridge_list_profiles 查看现有 profile', null)
          }
          throw toolError('PROFILE_PARSE_ERROR', `解析失败：${(err as Error).message}`, '检查文件编码与 JSON 结构', null)
        }
      }

      case 'proxybridge_start': {
        // FR-4 管理员检测
        const adminResult = checkAdmin()
        if (!adminResult.isAdmin) {
          throw toolError('ENV_NOT_ADMIN', '当前非管理员，ProxyBridge CLI 的 --profile 需要管理员权限', '以管理员身份运行 MCP 宿主；profile 相关工具在非管理员下仍可使用', null)
        }

        const profilePath = args?.['profilePath'] as string
        const cliPathOverride = args?.['cliPath'] as string | undefined
        const verbose = (args?.['verbose'] as number) ?? 1
        const readyTimeoutMs = (args?.['readyTimeoutMs'] as number) ?? 3000

        // 定位 CLI
        const location = locateCli(cliPathOverride)
        const cliPath = location.cliPath!

        // FR-12 启动就绪窗口
        const startTime = Date.now()
        const child = spawn(cliPath, ['--profile', profilePath, '--verbose', String(verbose)], {
          shell: false,
          windowsHide: true,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: dirname(cliPath),
        })

        // 日志缓冲
        child.stdout?.on('data', (data: Buffer) => {
          supervisor.addLog('out', data.toString('utf-8'))
        })
        child.stderr?.on('data', (data: Buffer) => {
          supervisor.addLog('err', data.toString('utf-8'))
        })

        // FR-17 子进程异常退出
        child.on('close', (code, signal) => {
          supervisor.updateLastExit({
            pid: supervisor.getProcess()?.pid,
            exitCode: code,
            terminatedAt: new Date(),
            reason: signal ? `signal:${signal}` : `code:${code}`,
          })
          supervisor.clearProcess()
        })

        // 就绪窗口
        return new Promise<{ content: any[]; isError?: boolean }>((resolve) => {
          const timeout = setTimeout(() => {
            if (child && !child.killed) {
              supervisor.setProcess({
                pid: child.pid!,
                profilePath,
                verbose,
                startedAt: new Date(startTime),
              })
              resolve({ content: [{ type: 'text', text: JSON.stringify({
                started: true,
                pid: child.pid,
                profilePath,
                verbose,
                readyMs: Date.now() - startTime,
              }, null, 2) }] })
            } else {
              resolve({ content: [{ type: 'text', text: JSON.stringify({ started: false, error: 'CLI_START_FAILED' }, null, 2) }], isError: true })
            }
          }, readyTimeoutMs)

          child.once('exit', (code) => {
            clearTimeout(timeout)
            resolve({ content: [{ type: 'text', text: JSON.stringify({ started: false, error: 'CLI_START_FAILED' }, null, 2) }], isError: true })
          })
        })
      }

      case 'proxybridge_status': {
        const status = supervisor.getStatus()
        return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] }
      }

      case 'proxybridge_logs': {
        const lines = (args?.['lines'] as number) ?? (args?.['tail'] as number) ?? 100
        const result = supervisor.getLogs(lines)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      case 'proxybridge_stop': {
        const timeoutMs = (args?.['timeoutMs'] as number) ?? 5000
        const result = await supervisor.stop(timeoutMs)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      case 'proxybridge_test_proxy': {
        // FR-18 参数校验
        const port = args?.['port'] as number
        const timeoutMs = (args?.['timeoutMs'] as number) ?? 5000

        if (typeof port !== 'number' || port < 1 || port > 65535) {
          throw toolError('TEST_PROXY_PORT_INVALID', `port=${port} 非法`, '取值范围 1–65535', null)
        }
        if (typeof timeoutMs !== 'number' || timeoutMs < 1 || timeoutMs > 60000) {
          throw toolError('PROXY_TIMEOUT_INVALID', `timeoutMs=${timeoutMs} 非法`, '取值范围 1–60000 毫秒', null)
        }

        const result = await probeProxy(args!['host'] as string, port, timeoutMs)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
    }
  } catch (err) {
    const error = err as any
    return {
      content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
      isError: true,
    }
  }
})

function getBaseDir(dir?: string): string {
  if (dir) return dir
  if (process.env.PROXYBRIDGE_PROFILE_DIR) return process.env.PROXYBRIDGE_PROFILE_DIR
  const defaultDir = resolve(homedir(), 'Documents', 'ProxyBridge-profiles')
  if (!existsSync(defaultDir)) {
    mkdirSync(defaultDir, { recursive: true })
  }
  return defaultDir
}

function isSafeFilename(filename: string): boolean {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..') || filename.startsWith('/')) {
    return false
  }
  return true
}

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('ProxyBridge MCP Server running on stdio')
}

main().catch(console.error)
