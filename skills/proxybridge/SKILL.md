---
name: proxybridge
description: ProxyBridge MCP Server 使用指南。当用户需要为特定应用配置代理路由、生成或校验 .pbprofile 文件、启动/停止 ProxyBridge CLI、测试代理端点连通性，或询问 ProxyBridge 路由规则语法时使用此技能。
---

# ProxyBridge Skill

## 触发场景

- 用户要求为特定应用配置代理路由（"让 chrome.exe 走 127.0.0.1:1080 的 SOCKS5 代理"）
- 用户需要生成 `.pbprofile` 文件（"帮我生成一个 ProxyBridge 配置文件"）
- 用户需要校验现有 profile（"这个 .pbprofile 文件有没有问题"）
- 用户需要启动/停止 ProxyBridge CLI（"启动 ProxyBridge"、"停止 ProxyBridge"）
- 用户需要测试代理端点连通性（"测试 127.0.0.1:1080 是否可达"）
- 用户询问 ProxyBridge 路由规则语法（"TargetHosts 支持哪些写法"、"规则匹配顺序是什么"）

## MCP 工具

调用 `proxybridge_*` 前缀的 MCP 工具：

| 工具 | 用途 |
| --- | --- |
| `proxybridge_check_environment` | 检查 CLI 安装、DLL、管理员权限 |
| `proxybridge_build_profile` | 生成并写入 `.pbprofile` 文件 |
| `proxybridge_validate_profile` | 校验 profile 合法性 |
| `proxybridge_read_profile` | 读取并解析单个 profile |
| `proxybridge_list_profiles` | 列举目录下的 profile 文件 |
| `proxybridge_start` | 启动 CLI 进程（需管理员） |
| `proxybridge_status` | 查询进程状态 |
| `proxybridge_logs` | 读取进程日志 |
| `proxybridge_stop` | 停止 CLI 进程 |
| `proxybridge_test_proxy` | 测试代理端点连通性 |

## 规则语法

详见 [rule-syntax.md](references/rule-syntax.md)。

## 路由语义

详见 [routing-semantics.md](references/routing-semantics.md)。

## UDP/QUIC 限制

详见 [udp-and-quic.md](references/udp-and-quic.md)。
