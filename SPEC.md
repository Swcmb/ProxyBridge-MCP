# SPEC: ProxyBridge MCP Server and Skill

> 许可证：GPL-3.0-or-later
> 目标平台：Windows x64
> 参考实现版本：ProxyBridge CLI V4.1.1（实测自 `E:\Program Files\ProxyBridge\ProxyBridge_CLI.exe --help`）
> 本文件为第 2 轮评审后的修订版；评审记录见 §9。

## 1. Background

ProxyBridge 是一款按进程路由流量的通用代理客户端（Proxifier 替代品），支持把任意应用的 TCP/UDP
流量重定向到 SOCKS5 或 HTTP 代理。它的配置载体是一个 `.pbprofile` JSON 文件，由 GUI 导出；
命令行入口 `ProxyBridge_CLI.exe` 只负责**读取并运行**这个 profile，本身没有任何创建、修改、
查询能力。

这带来三个具体缺口：

1. **Agent 无法产出合法配置。** `.pbprofile` 的字段名大小写敏感（`ProxyConfigs` / `ProxyRules` /
   `ProxyConfigId` / `IsEnabled`），规则字段取值有大量约束（进程通配符、IP/区间、端口段、
   动作与代理配置的绑定关系），靠模型手写 JSON 出错率高，且出错往往在运行时才暴露。
2. **Agent 无法运维运行中的进程。** CLI 是前台常驻进程，只有 `Ctrl+C` 能结束，没有状态查询、
   日志抓取、优雅停止的接口。
3. **Agent 无法预检代理可用性。** GUI 里的 "Test Proxy Connection" 在 CLI 侧完全缺失，
   而 CLI 的 `--update` / `--version` / `--profile` 三个入口没有一个提供连通性反馈。

本项目为该 CLI 补上一层 Agent 友好的封装：一个 TypeScript MCP Server（stdio 传输）暴露
一组工具，再配一个 Skill 把 ProxyBridge 的路由语义（规则匹配顺序、localhost 旁路、强制直连
地址段、UDP/QUIC 限制）沉淀为模型可复用的知识。

### 1.1 许可证边界

ProxyBridge 上游为 **MIT 许可**（官方文档页脚声明）。本项目以**外部进程调用**的方式使用其 CLI，
不复制、不反编译、不链接其任何二进制或源码，因此上游许可与本项目的 GPL-3.0-or-later 无冲突。
仓库内不含任何来自 InterceptSuite 的代码或资产。

### 1.2 已实测的一手事实

以下事实由本机实测得出，是本 SPEC 的硬约束；文档站示例若与之冲突，以本节为准。

| 事实 | 证据 |
| --- | --- |
| 版本 V4.1.1，Author `Sourav Kalal/InterceptSuite`，GitHub `https://github.com/InterceptSuite/ProxyBridge` | `--version` / `--help` 输出 |
| 启动横幅（ASCII Logo + Author + GitHub + 版本号）走 **stdout**，正常退出码 0 | `--help` 实测 |
| 非管理员执行 `--profile` 时，**在解析 profile 之前**即失败，stderr 固定输出两行：`ERROR: Administrator privileges required.` 与 `Right-click the executable and select 'Run as administrator'.` | 用合法 profile 与非法 profile 各跑一次，输出一致 |
| `ProxyBridgeCore.dll` 为 NativeAOT 编译产物，无托管元数据（`LoadFrom` 报 `The module was expected to contain an assembly manifest`） | 反射加载实测 |
| 官方 profile JSON 示例中 `Port` 两处均为**字符串**（`"1080"` / `"8080"`） | 文档 `configuration-windows` 页 Profile JSON Format 段 |
| GUI 导出入口为 `File > Export Profile`；CLI 的输入被文档定义为「exported from the GUI」 | 同上 |
| 最多 16 个代理配置同时生效；规则命中的代理配置不存在时回退到第一个 | 同上 Multiple Proxy Configurations 段 |
| GUI 的 Action 下拉默认只出现 DIRECT / BLOCK；未配置任何代理时 PROXY 动作不可选 | 同上 Proxy Rules 段 |
| **非管理员身份下** `whoami /groups` 含 `S-1-16-8192`（Medium 完整性）；管理员下会含 `S-1-16-12288`（High） | 本机实测；SID 为二进制标识，不随系统语言变化 |
| **非管理员身份下** `fsutil dirty query C:` 退出码 1、输出 `Error 5: Access is denied.` | 本机实测 |
| **非管理员身份下** `net session` 退出码 2、无输出 | 本机实测 |
| 上述三条命令均为只读系统查询，不加载驱动、不改变系统状态、不触发 UAC | 命令语义 |

## 2. Goals

| 编号 | 目标 | 可检查的达成标志 |
| --- | --- | --- |
| G-1 | Agent 能生成结构正确的 `.pbprofile` | 对「chrome.exe 走 SOCKS5、curl.exe 走 HTTP」请求，产出 JSON 通过校验器全部规则，且能被 CLI 接受 |
| G-2 | Agent 能在配置写盘前发现错误 | 非法 Action / 超 16 个代理 / 空 ProcessName / 非法 Protocol 被拒绝并指出具体字段 |
| G-3 | Agent 能管理 CLI 常驻进程 | start → status → logs → stop 全链路可调用，stop 后进程确实退出 |
| G-4 | Agent 能预检代理端点 | 端点可达与不可达返回可区分的结果，不阻塞超过设定超时 |
| G-5 | Agent 知道 ProxyBridge 的路由陷阱 | Skill 中记录 localhost 旁路、强制直连段、UDP/QUIC 限制，模型据此选择规则而非乱试 |
| G-6 | 无管理员权限时行为可预期 | 非管理员调用 start 返回明确错误 + 提权指引，不触发 UAC 对话框 |

**明确的非目标（Non-goals）**

- 不修改、不重新编译、不反编译 ProxyBridge 本体。
- 不实现自动 UAC 提权。
- 不复刻 GUI 功能（Connections 实时面板、GUI 内置的 Test Proxy Connection UI）。
- 不实现 macOS / Linux 平台适配；CLI 参数虽跨平台一致，本项目只保证 Windows 行为。
- 不实现规则的热更新/在线修改（ProxyBridge 本身要求改完配置重启进程）。
- 不做跨 MCP 会话的运行状态持久化（§5.3 已固化该边界）。
- 不引入原生模块与编译工具链（见 §8 决策 D-4）。
- 不用 ProxyBridge 自身进程做权限探测（避免未知副作用，见 §8 决策 D-6）。

## 3. Functional requirements

### 3.1 环境与版本探测

**FR-1 定位 CLI 可执行文件**
MCP 必须能定位 `ProxyBridge_CLI.exe`。查找顺序为：工具入参显式路径 → 环境变量
`PROXYBRIDGE_CLI_PATH` → 常见安装路径列表（含 `E:\Program Files\ProxyBridge`）→ PATH。
输出必须包含最终解析到的绝对路径，并回显全部已尝试候选。

**FR-2 版本与能力探测**
提供工具读取 CLI 版本号（内部执行 `--version`）与帮助文本（`--help`），输出中包含版本字符串。
CLI 缺失或无法执行时，返回 `ENV_CLI_NOT_FOUND` 或 `ENV_CLI_NOT_EXECUTABLE` 错误，
错误信息中包含已尝试的全部候选路径。

**FR-3 依赖完整性检查**
CLI 必须与 `ProxyBridgeCore.dll` 位于同一目录才能运行。环境探测工具必须校验该 DLL 是否存在，
缺失时返回 `ENV_CORE_DLL_MISSING` 并说明后果（CLI 将无法启动）。

**FR-4 管理员身份检测**
环境探测工具返回当前 MCP 宿主进程是否以管理员身份运行（`isAdmin` 布尔值）。
检测采用**三级交叉校验**，全部使用 Windows 自带命令；检测过程只读系统信息，
**不 spawn ProxyBridge 进程、不加载驱动、不改变任何系统状态、不触发 UAC**（§1.2 已实测这三条命令的性质）：

| 级 | 命令 | 判定 |
| --- | --- | --- |
| 一级（权威） | `whoami /groups`，解析完整性等级 SID | 命中 `S-1-16-16384`（System）或 `S-1-16-12288`（High）→ 管理员；仅含 `S-1-16-8192`（Medium）或更低 → 非管理员。SID 是与语言无关的二进制标识，本级不受系统语言影响 |
| 二级（交叉校验） | `fsutil dirty query %SystemDrive%` | 退出码 0 → 管理员；非 0 → 非管理员。与一级结论冲突时**以一级为准**，并在返回值中置 `adminCheckConflict: true` 供排障 |
| 三级（仅一级解析失败时启用） | `net session` | 退出码 0 → 管理员，否则非管理员 |

三级均无法得出结论时返回 `ENV_ADMIN_CHECK_FAILED`，`hint` 说明「无法判定管理员身份，请手动确认后重试」。
**禁止**在检测失败时按 `false` 处理。`isAdmin` 为一级结论；`adminCheckMethod` 回显实际生效的级别
（`integrity-sid` / `fsutil-dirty` / `net-session`）。

`--profile` 运行需要管理员（WinDivert 内核驱动），`--version` / `--update` 不需要。

### 3.2 Profile 生成与校验

**FR-5 Profile 数据模型**
工具接受的结构化请求与 `.pbprofile` 的映射关系如下（字段名与落盘 JSON 完全一致）：

| 请求字段 | 落盘字段 | 类型 | 约束 |
| --- | --- | --- | --- |
| `version` | `Version` | string | 只允许 `"1.0"`，其它值报 `PROFILE_VERSION_UNSUPPORTED` |
| `localhostViaProxy` | `LocalhostViaProxy` | boolean | 默认 `false` |
| `trafficLogging` | `IsTrafficLoggingEnabled` | boolean | 默认 `true` |
| `proxies[]` | `ProxyConfigs[]` | array | 长度 1–16（**assumed**：文档只说明「最多 16 个同时生效」，空数组合法性未验证；生成器拒绝空数组并报 `PROXY_LIST_EMPTY`，提示「空配置合法性待实测」，见 R-2） |
| `proxies[].id` | `Id` | number | 正整数；同 profile 内唯一 |
| `proxies[].type` | `Type` | `"socks5" \| "http"` | 其它值报 `PROXY_TYPE_INVALID` |
| `proxies[].host` | `Host` | string | 支持 IP 或域名，非空 |
| `proxies[].port` | `Port` | string | 落盘**必须是字符串**（§8 决策 D-1）；请求层同时接受 number，落盘时 `String(port)`；取值范围 1–65535，越界报 `PROXY_PORT_INVALID` |
| `proxies[].username` / `.password` | `Username` / `Password` | string | 可选，默认空串 |
| `rules[]` | `ProxyRules[]` | array | 顺序即优先级，索引 0 最先匹配；长度上限 200（**assumed**：文档无官方规则数上限，此值仅为给 O(N²) 遮蔽检测设工程上界，越界报 `RULE_LIMIT_EXCEEDED`） |
| `rules[].processName` | `ProcessName` | string | 见 FR-5.1，非空 |
| `rules[].targetHosts` | `TargetHosts` | string | 见 FR-5.2，空串或 `*` 表示全部 |
| `rules[].targetPorts` | `TargetPorts` | string | 见 FR-5.3，空串或 `*` 表示全部 |
| `rules[].protocol` | `Protocol` | `"TCP" \| "UDP" \| "BOTH"` | |
| `rules[].action` | `Action` | `"DIRECT" \| "BLOCK" \| "PROXY"` | |
| `rules[].isEnabled` | `IsEnabled` | boolean | 默认 `true` |
| `rules[].proxyConfigId` | `ProxyConfigId` | number | `action="PROXY"` 时必填且必须命中某个 proxy id；非 PROXY 动作**省略该字段**（§8 决策 D-2） |

**FR-5.1 进程名匹配语法**
`ProcessName` 支持：全匹配 `*`；单进程 `chrome.exe`；分号分隔多进程 `firefox.exe; chrome.exe`；
前缀/后缀/任意位置通配 `steam*.exe`、`*.exe`、`*ch*`、`ch*`。
校验器接受上述全部形态，不做穷举匹配，只拒绝空值。

**FR-5.2 目标主机匹配语法**
`TargetHosts` 支持：单个 IP、域名；通配段 `192.168.*.*`；分号分隔多值；闭区间
`10.10.1.1-10.10.255.255`；IPv6 精确 `::1`、`2001:db8::1`；IPv6 CIDR `2001:db8::/32`、
`fe80::/10`；IPv6 区间 `2001:db8::1-2001:db8::ff`。空串或 `*` 表示全部。
校验器至少能识别并放行 IPv6 的 CIDR 斜杠写法与 IPv4 的区间连字符写法，
遇到无法解析的片段返回 `PROFILE_HOST_PATTERN_INVALID` 并回显该片段。
IPv4 的 CIDR 写法（`10.0.0.0/8`）**未出现在官方文档中**（**assumed**）：校验器宽容接受，
生成器**不得**产出该写法。

**FR-5.3 目标端口匹配语法**
`TargetPorts` 支持单个端口 `80`、分号分隔 `80; 8080`、区间 `80-8000`。
空串或 `*` 表示全部。非数字、非区间形式的片段返回 `PROFILE_PORT_PATTERN_INVALID`。

**FR-5.4 输出路径基准目录**
所有写盘操作必须落在**基准目录**内。基准目录解析顺序：工具入参 `dir` → 环境变量
`PROXYBRIDGE_PROFILE_DIR` → `%USERPROFILE%\Documents\ProxyBridge-profiles`（不存在则创建）。
生成工具的入参是 `filename`（**纯文件名，不接受路径分隔符，不接受 `..`，不接受绝对路径**），
最终路径为 `path.resolve(baseDir, filename)`；违反约束或越界返回 `PROFILE_PATH_OUT_OF_BASE`。
读类与执行类工具（read / list / start）接受用户显式给出的绝对路径，**不做基准目录约束**：
调用方本就是用户自己的 Agent，限制读取只会阻断「运行 GUI 导出的 profile」这一主路径。
读类工具的原则是「路径必须由调用方显式给出，MCP 绝不从别处推导或猜测路径」；
唯一的例外是 `list_profiles` 的 `dir` 入参缺省时使用基准目录（FR-11）。

**FR-6 生成 profile**
生成工具接收 FR-5 的结构化请求与 FR-5.4 的 `filename`，写出 `.pbprofile` 文件，返回文件绝对路径
与写入内容的摘要（代理数量、规则数量、动作分布）。写入前必须先跑 FR-7 校验；校验不通过则
不写文件并返回错误。目标路径已存在时，默认拒绝并返回 `PROFILE_FILE_EXISTS`，除非调用方显式
要求覆盖。除「文件已存在」外的写入失败（磁盘满、目录只读、目标路径是目录、无权限）统一返回
`PROFILE_WRITE_FAILED`，`hint` 中包含系统原始错误码与文案。

**FR-7 校验 profile**
校验器接受两种输入：文件路径，或 FR-5 的结构化请求。校验不通过属于**业务结果**，
返回 `{ valid: false, errors[], warnings[] }`，**不抛工具级错误**；`errors[]` 每个元素的 `code`
取值域就是下表。读取入参本身失败（文件不存在、JSON 解析不了）才是工具级错误，返回
`PROFILE_NOT_FOUND` / `PROFILE_PARSE_ERROR`。

**错误返回体统一为四字段** `{ code, message, fieldPath, hint }`（§5.1.1），其中 `fieldPath` 为
`null` 表示全局性错误（如环境类、文件类）。`message` 中内嵌的字段名必须与 `fieldPath` 一致。

| 类别 | 错误码 | 触发条件 | `fieldPath` |
| --- | --- | --- | --- |
| 结构 | `PROFILE_SCHEMA_INVALID` | JSON 解析失败、缺字段、类型错误 | 对应字段或 `null` |
| 结构 | `PROFILE_UNKNOWN_FIELD` | 出现本 SPEC 未定义的**顶层**字段 | 顶层字段名 |
| 结构 | `PROFILE_VERSION_UNSUPPORTED` | `Version` 不等于 `"1.0"` | `Version` |
| 语义 | `PROXY_LIMIT_EXCEEDED` | 代理配置数 > 16 | `ProxyConfigs` |
| 语义 | `PROXY_LIST_EMPTY` | 代理配置数为 0 | `ProxyConfigs` |
| 语义 | `PROXY_ID_DUPLICATE` | 代理 id 重复 | `ProxyConfigs[i].Id` |
| 语义 | `PROXY_TYPE_INVALID` | `Type` 不在枚举内 | `ProxyConfigs[i].Type` |
| 语义 | `PROXY_PORT_INVALID` | 端口非 1–65535 的整数 | `ProxyConfigs[i].Port` |
| 语义 | `RULE_LIMIT_EXCEEDED` | 规则数 > 200 | `ProxyRules` |
| 语义 | `RULE_PROCESS_EMPTY` | `ProcessName` 为空或仅空白 | `ProxyRules[i].ProcessName` |
| 语义 | `RULE_ACTION_INVALID` | `Action` 不在枚举内 | `ProxyRules[i].Action` |
| 语义 | `RULE_PROTOCOL_INVALID` | `Protocol` 不在枚举内 | `ProxyRules[i].Protocol` |
| 语义 | `RULE_PROXY_REF_MISSING` | `action=PROXY` 但 `ProxyConfigId` 为空或不命中 | `ProxyRules[i].ProxyConfigId` |
| 语义 | `PROFILE_HOST_PATTERN_INVALID` | `TargetHosts` 片段无法解析 | `ProxyRules[i].TargetHosts` |
| 语义 | `PROFILE_PORT_PATTERN_INVALID` | `TargetPorts` 片段无法解析 | `ProxyRules[i].TargetPorts` |

共 15 个阻断级校验错误码，AC-4 逐条覆盖。**未知字段分级**（§8 决策 D-9）：顶层未知字段阻断
（`PROFILE_UNKNOWN_FIELD` 进 `errors[]`）；嵌套对象内的额外键降级为警告级同名码（进 `warnings[]`），
理由是本项目的主路径是读取 GUI 导出的 profile，严格拒绝嵌套层会在真实导出含示例外字段时全线失败。

**FR-8 规则冲突预检**
校验器必须检测并以 `RULE_SHADOWED`（警告级，不阻断）报告后置规则被前置规则完全遮蔽的情况。
因 ProxyBridge 自上而下首个命中即生效，后置规则永远不会被求值。

判定算法（必须按此实现，禁止用启发式猜测）：

1. **归一化**：把规则的四个字段各自解析为一个 token 集合。
   - `ProcessName`：按 `;` 切分、去空白、转小写；`*` → `ALL`；含 `*` 的项 → 通配 token；
     其余 → 字面量 token。
   - `TargetHosts`：按 `;` 切分、去空白；空或 `*` → `ALL`；其余每项归一为
     `ipv4Exact` / `ipv4Range` / `ipv4Cidr` / `ipv4Wildcard` / `ipv6Exact` / `ipv6Cidr` /
     `ipv6Range` / `domainGlob` 八种之一。
   - `TargetPorts`：按 `;` 切分、去空白；空或 `*` → `ALL`；其余归一为闭区间 `[p, q]`。
   - `Protocol`：`TCP` → `{TCP}`，`UDP` → `{UDP}`，`BOTH` → `{TCP, UDP}`。
2. **逐字段比较**，每对 (a 的某 token, b 的某 token) 计算四种结果之一：
   - `SUPERSET`：可证明 a 覆盖 b。
     - `ALL` ⊇ 任何；字面量 ⊇ 相同字面量；含通配 token ⊇ 被它匹配的 token
       （`*` 匹配任意非空进程名；`192.168.*.*` 匹配 `192.168.1.1` 与 `192.168.1.*`）；
     - 区间 `a ⊇ b` 当且仅当 `a.lo ≤ b.lo 且 b.hi ≤ a.hi`；
       IPv4 / IPv6 区间比较须先将地址数值化为无符号 128-bit 整数（Node `BigInt` 或等价手段），
       再按闭区间包含关系判定；禁止使用字符串字典序比较地址。
     - 同地址族的 CIDR `a ⊇ b` 当且仅当 `a.prefixLen ≤ b.prefixLen 且 b.network ∈ a.network`。
   - `SAME`：两者等价（同值 / 同区间 / 同前缀）。
   - `UNCOMPARABLE`：同类但不可判定（如含通配的进程名 `ch*` 与 `chrome.exe`、
     含通配的主机段与 IP 区间、域名通配与 IP）。
   - `INCOMPARABLE`：异类 token 混在一起无法统一比较。
   字段级结果取所有 token 对中**最弱**的一个（存在任一 `UNCOMPARABLE` / `INCOMPARABLE`
   则该字段即为此二值之一；否则只要存在严格 `SUPERSET` 或任一侧为 `ALL` 即为 `SUPERSET`，
   全为 `SAME` 才是 `SAME`）。
3. **规则级判定**：设 `a` 为前置规则、`b` 为后置规则。仅当四个字段的比较结果
   **全部属于 `SUPERSET` 或 `SAME`**，且至少一个字段满足严格包含关系时判定 `a` 遮蔽 `b`，
   报 `RULE_SHADOWED`（附 `a` 与 `b` 的索引）。严格包含关系定义：
   `a` 的某字段归一化为 `ALL` 而 `b` 对应字段不是，**或**两者的 `SUPERSET` 关系为严格真超集
   （即 `a ⊇ b` 成立但 `b ⊇ a` 不成立，亦即两者不等价）。
   - 等价判定：字段级结果为 `SAME` 且两侧归一化 token 集合完全相同。
   - 严格超集判定：字段级结果为 `SUPERSET` 但不满足等价条件。
4. **保守策略**：任一字段为 `UNCOMPARABLE` 或 `INCOMPARABLE` 时**一律不报**。
   宁可漏报不可误报——误报会让用户删掉一条实际生效的规则。
5. `a.IsEnabled` 或 `b.IsEnabled` 任一方为 `false` 时**不报**（禁用的规则本就不会被求值）。
6. 复杂度上界 `O(N²)`，`N ≤ 200`（FR-5 已设上限），最坏 40,000 次比较，单次校验可接受。

**FR-9 强制直连地址预警**
当一条 PROXY 规则会命中强制直连目标时，校验器以 `RULE_OVERRIDDEN_BY_FORCED_DIRECT`
（警告级，不阻断）报告——PROXY 动作对这些目标永远被覆盖为 DIRECT。判定复用 FR-8 的
步骤 1 归一化与步骤 2 的 `SUPERSET` 语义，并沿用步骤 4 的保守不报策略：

| 强制直连目标 | 归一化形态 | 判定条件 |
| --- | --- | --- |
| IPv4 广播 `255.255.255.255` 与 `x.x.x.255` | `ipv4Exact` / 通配段 | `TargetHosts` 与之构成 `SUPERSET` |
| IPv4 组播 `224.0.0.0`–`239.255.255.255` | 区间 | `TargetHosts` ⊇ 该区间（`TargetHosts` 为 `ALL` 或更大区间即报） |
| IPv4 APIPA / 链路本地 `169.254.0.0/16` | `ipv4Cidr` | `TargetHosts` ⊇ 该网段 |
| IPv4 DHCP 端口 UDP 67 / 68 | 端口 | `Protocol ⊇ {UDP}` **且** `TargetPorts` 与 `[67,67]` 或 `[68,68]` 构成 `SUPERSET` |
| IPv6 组播 `FF00::/8` | `ipv6Cidr` | `TargetHosts` ⊇ 该网段 |
| IPv6 链路本地 `FE80::/10` | `ipv6Cidr` | 同上 |
| IPv6 站点本地 `FEC0::/10` | `ipv6Cidr` | 同上 |
| IPv6 未指定地址 `::` | `ipv6Exact` | `TargetHosts` ⊇ 该地址 |
| IPv6 DHCPv6 端口 UDP 546 / 547 | 端口 | `Protocol ⊇ {UDP}` **且** `TargetPorts` 与之构成 `SUPERSET` |

域类 token（`domainGlob`）与任何 IP 类强制直连段都不可比，因此**不报**——这与
「代理域名指向这些地址」的实际行为有关，但静态分析无法判定，交由运行期观察。

**FR-10 UDP 组合预警**
当一条规则同时满足「`Action=PROXY`」且「`Protocol` 为 `UDP` 或 `BOTH`」时，
校验器按规则引用的代理类型给出不同的 `RULE_UDP_REQUIRES_SOCKS5` 警告文案：

| 引用代理 | 警告文案要点 |
| --- | --- |
| `Type=http` | HTTP 代理不支持 UDP，此类流量会直连而非报错，容易被误认为规则未生效 |
| `Type=socks5` | SOCKS5 只是 UDP 转发的必要条件，还需代理服务器实现 UDP ASSOCIATE；否则 UDP 流量直连或被丢弃 |
| 引用无法解析 | 不产生本警告（该情形已由阻断级 `RULE_PROXY_REF_MISSING` 拦截） |

**FR-11 读取与列举 profile**
提供工具列出指定目录下的 `.pbprofile` 文件（`dir` 缺省时用 FR-5.4 的基准目录），以及读取单个
profile 并返回结构化摘要（代理数量与明细、规则数量与动作分布、localhost/trafficLogging 开关），
密码字段以 `***` 遮蔽。

### 3.3 进程生命周期管理

**FR-12 启动**
启动工具参数：`profilePath`（必填，绝对路径）、`verbose`（0–3，默认 1）、`cliPath`（可选，覆盖定位）、
`readyTimeoutMs`（默认 3000，范围 500–30000）。
行为：按 §5.2 的 spawn 契约启动 `ProxyBridge_CLI.exe --profile <path> --verbose <n>`，
不阻塞 MCP 调用。启动前必须执行 FR-4 的管理员检测：非管理员时不启动、不提权，返回
`ENV_NOT_ADMIN`，错误文本中包含「以管理员身份运行 MCP 宿主」的操作指引。

**启动就绪窗口**：启动后进入 `readyTimeoutMs` 就绪窗口，期间持续观察子进程是否存活。
- 窗口内进程退出 → 启动失败，返回 `CLI_START_FAILED`，并附带退出码与退出前 stderr 最后 20 行。
- 窗口结束进程仍存活 → 返回 `{ started: true, pid, profilePath, verbose, readyMs }`。

默认值 3000 ms 的依据（§8 决策 D-7）：CLI 需加载体积较大的 NativeAOT `ProxyBridgeCore.dll`
并初始化 WinDivert 驱动，冷启动耗时未知（Q-6）；3000 ms 是在「误报启动失败」与
「启动失败反馈过慢」之间取的保守值，并提供入参让调用方在慢盘或安全软件拦截时放宽。
该窗口消除了「返回成功但进程几百毫秒后已死」的竞态，使 `status` 的运行标志具备确定语义。

**FR-13 重复启动**
已有进程在运行时再次调用启动，返回 `ALREADY_RUNNING`，并附带当前运行实例的 pid 与 profile 路径，
不新起进程。

**FR-14 状态查询**
状态工具返回：是否在运行、pid、启动时间戳、已运行时长、所用 profile 绝对路径、verbose 级别、
已捕获的日志行数与错误行数、以及**最近的退出记录**（上次运行的 pid、结束时间、退出码/终止原因）。
`lastExit` 为纯进程内存态（§5.3）：MCP 进程重启后该字段一律缺失，此时返回 `running: false`
并附 `note` 说明「运行状态不跨 MCP 重启保留」。

**FR-15 日志读取**
日志以环形缓冲保存，**上限 5000 行**（内存量级：5000 行 × 约 200 字节 ≈ 1 MB）。
读取参数只保留 `lines`：**返回行数上限，默认 100，范围 1–5000**。
`tail` 作为向后兼容别名保留，缺省值同 `lines`；两者同时出现时**以 `lines` 为准**。
每行标注来源流（`out` / `err`）与序号。
子进程 stdout/stderr 字节流按 UTF-8 解码；非法序列替换为 U+FFFD 替换符（`\\uFFFD`），不报错。
请求行数大于当前可用行数时，返回全部可用行并置 `dropped > 0`，**不做静默截断，也不报错**。
返回体固定含 `{ lines, dropped, totalLines }`。从未启动过或已停止时调用，返回
`{ lines: [], dropped: 0, totalLines: 0, note: "当前无受管进程，日志缓冲区为空" }`，
不返回错误。

**FR-16 停止**
**实现决策（§8 D-3）**：Windows 上纯 Node 进程没有 `GenerateConsoleCtrlEvent` 等价原语，
`child.kill()` 不终止进程树，`process.kill(-pid)` 在 Windows 不可靠。因此 `stop` 采用
**单阶段强制终止**：`taskkill /PID <pid> /T /F`，其中 `/T` 终止整棵进程树、`/F` 强制。
- 返回 `{ stopped: true, exitCode?, durationMs, method: "taskkill-tree" }`。
- 默认 5 秒内未确认退出则返回 `stopped: false`，`hint` 提示改用系统进程管理器手动结束。
- 未在运行时调用返回 `NOT_RUNNING`。
- 只终止 FR-12 自己记录的**那一个 pid**，禁止按进程名或通配路径批量终止。
- 副作用说明：Windows 在进程终止时关闭其持有的 WinDivert 句柄，重定向随之失效
  （**assumed**，见 R-8），AC-9 实测确认。
停止后运行状态回到"未运行"，最近退出记录更新。

**FR-17 子进程异常退出（事件驱动路径）**
采用**被动事件监听**路径：`start` 时注册的 `ChildProcess` 实例挂载 `close` 事件处理器，
处理器在子进程退出时**同步**更新内存状态（`running=false`、记录 `exitCode` 与最后若干行日志）。
`status` 工具读取该状态，不另起检测逻辑。
- `close` 事件触发后状态立即对后续 `status` 调用可见，不存在竞态窗口。
- 若 MCP 自身在 `close` 事件触发前崩溃（OOM/segfault），子进程随宿主一起被 OS 回收，
  `lastExit` 一并丢失，下次 `start` 新建实例——此场景与 §5.3 的说明一致。
子进程在 MCP 未主动停止的情况下退出时（崩溃、被用户手动关闭），`status` 返回 `running=false`
并给出退出码与退出前最后若干行日志。

### 3.4 代理连通性测试

**FR-18 连通性探测**
测试工具参数：`host`（string，必填）、`port`（number，必填，1–65535）、`timeoutMs`（默认 5000，范围 1–60000）。
行为：对目标端点建立一次 TCP 连接并报告结果。返回五态：

| 结果 | 触发条件（Node `net.Socket` 错误码） | 含义 |
| --- | --- | --- |
| `reachable` | 连接成功 | 端口可连 |
| `refused` | `ECONNREFUSED` | 端点存在但未监听，或被防火墙 RST |
| `timeout` | 用户 `timeoutMs` 到期仍未完成握手，或 `ETIMEDOUT` / `ERR_SOCKET_CONNECTION_TIMEOUT` | 被静默丢弃或不可路由 |
| `unresolved` | `ENOTFOUND` / `EAI_AGAIN` / `EAI_FAIL` | 域名无法解析 |
| `unreachable` | `EHOSTUNREACH` / `ENETUNREACH` / `ENETDOWN` / `EACCES` / `ECONNRESET` | 路由不可达、被本地策略拒绝或连接被中途重置 |

五态覆盖 Node 在 Windows 上实际会抛出的全部连接期错误，不做未定义状态的兜底合并。

**FR-19 不做协议级握手**
探测只做 TCP 建连，不发送 SOCKS5 握手或 HTTP CONNECT。
因此 `reachable` 只代表端口可连，不代表代理协议可用。返回值中必须包含 `note` 字段
（固定文案 + 视结果追加的针对性说明），避免调用方把端口可达误读为代理可用。

## 4. Non-functional requirements

| 编号 | 类别 | 要求 | 度量方式 |
| --- | --- | --- | --- |
| NFR-1 | 性能 | MCP 冷启动到 `initialize` 响应返回 < 2 秒（参考机：Windows x64 / Node v22） | `npm run bench:startup`：冷启动 20 次取 P50，测量点为「`spawn` 子进程」到「客户端收到 `initialize` 响应」 |
| NFR-2 | 性能 | 连通性探测在 `timeoutMs` 到期后必须返回，不挂起 | 单测用不可路由地址验证 |
| NFR-3 | 可靠性 | stdout 纯净 | MCP 协议独占 stdout；所有日志/调试输出走 stderr。用 `mcp-inspector` 连接时不得出现协议解析错误；AC-11 额外断言 stdout 首字节是 JSON-RPC 帧 |
| NFR-4 | 安全 | 凭据不外泄 | profile 中 `Password` 字段在任何工具返回值、日志、错误信息中均以 `***` 呈现 |
| NFR-5 | 安全 | 不自动提权 | 代码中不存在 `runas` / `ShellExecute` / UAC 触发调用；非管理员场景零提权对话框 |
| NFR-6 | 安全 | 写路径不可穿越 | 写盘工具只接受纯 `filename`，输出必须落在 FR-5.4 的基准目录内；`..`、绝对路径、路径分隔符一律拒绝并报 `PROFILE_PATH_OUT_OF_BASE`。度量方式：AC-22 |
| NFR-7 | 兼容性 | Node.js ≥ 20；Windows x64 | `engines.node` 声明 + CI 检查 |
| NFR-8 | 可维护性 | TypeScript strict 模式零 `any`（除第三方 SDK 类型边界） | `tsc --noEmit` 通过且 eslint `no-explicit-any` 为 error |
| NFR-9 | 可维护性 | 工具命名统一 `proxybridge_` 前缀，且四个 MCP 注解齐全 | `scripts/check-tools.ts` 断言，非人工核对 |
| NFR-10 | 可移植性 | CLI 路径不硬编码为本机路径 | 默认候选表外的一切路径来自入参或环境变量；AC-14 检索 |
| NFR-11 | 可用性 | 所有错误返回结构化对象，含 `code` / `message` / `fieldPath` / `hint` 四字段（§5.1.1 总表逐条定义） | 错误路径单测断言四字段齐全 |
| NFR-12 | 许可证合规 | 根目录 `COPYING`；每个手写源文件带 `SPDX-License-Identifier: GPL-3.0-or-later`；`package.json` 有 `license` 字段 | `npm run check:license` 脚本 |
| NFR-13 | 许可证合规 | 宿主程序打印启动横幅（作者、版本、许可证），且**横幅写 stderr**；仅在 `process.stdin.isTTY === true` 或环境变量 `PROXYBRIDGE_MCP_BANNER=1` 时打印 | 手工执行验证 + AC-15 |
| NFR-14 | 安全 | 外部进程调用一律以 argv 数组传递且 `shell: false`；禁止任何字符串拼接命令行 | `npm run check:no-shell` 脚本 + 单测断言 spawn 选项 |
| NFR-15 | 隐私 | 生成的 `.pbprofile` 含明文口令：工具必须在返回值中提示「该文件含明文凭据，请限制文件访问范围」；MCP 不修改 ACL、不加密、不上传 | 单测断言提示文案存在 |

> NFR-3 与 NFR-13 的关系：MCP stdio 传输下 `stdin` 恒为 JSON-RPC 通道，因此横幅**无条件写 stderr**
> 且在 stdio（非 TTY）传输下默认不打印，从而同时满足「程序从 stdin 读取时有启动横幅」与
> 「stdout 协议纯净」两条要求（§8 决策 D-10）。

## 5. Interfaces and data

### 5.1 MCP 工具清单

`openWorldHint` 口径：**凡工具会 spawn 外部进程或建立网络连接者，一律 `✓`**；
仅读写 MCP 自身进程与本地文件系统边界内的对象者，为 `✗`。
`destructiveHint` 口径：**是否会改变系统代理路由状态或本机进程状态**。写一个用户目录下的文件
属于产物产出，`✗`。
`readOnlyHint` 口径：**是否改变文件系统或外部系统状态**。读操作可能对外部数据的某些字段
做遮蔽处理（如 `Password → ***`），不改变文件系统，仍视为 `readOnly`；客户端需知晓输出
可能被脱敏，但与写入类操作有本质区别。

表中四列与 MCP SDK 的注解字段按序一一对应：
`readOnly → readOnlyHint`、`destructive → destructiveHint`、`idempotent → idempotentHint`、
`openWorld → openWorldHint`。

| 工具名 | 输入 | 输出 | readOnly / destructive / idempotent / openWorld | 错误码 |
| --- | --- | --- | --- | --- |
| `proxybridge_check_environment` | `{ cliPath? }` | `{ found, cliPath, version, coreDllPresent, isAdmin, adminCheckMethod, adminCheckConflict?, candidatesTried[] }` | ✓ / ✗ / ✓ / ✓ | `ENV_CLI_NOT_FOUND`、`ENV_CLI_NOT_EXECUTABLE`、`ENV_CORE_DLL_MISSING`、`ENV_ADMIN_CHECK_FAILED` |
| `proxybridge_build_profile` | `{ filename, profile, overwrite?, dir? }` | `{ path, proxyCount, ruleCount, actionCounts, warnings[], credentialNotice }` | ✗ / ✗ / ✓（`overwrite=false` 时为拒绝式幂等） / ✗ | §5.1.1 中全部阻断级 `PROFILE_*` / `PROXY_*` / `RULE_*` 码 |
| `proxybridge_validate_profile` | `{ path? \| profile? }` | `{ valid, errors[], warnings[] }`（`errors[].code` 取值域为 FR-7 的 15 个码） | ✓ / ✗ / ✓ / ✗ | 工具级：`PROFILE_NOT_FOUND`、`PROFILE_PARSE_ERROR`（校验不通过走 `valid:false`） |
| `proxybridge_list_profiles` | `{ dir? }` | `{ dir, files: [{ name, sizeBytes, modifiedAt }] }` | ✓ / ✗ / ✓ / ✗ | `PROFILE_DIR_UNREADABLE` |
| `proxybridge_read_profile` | `{ path }` | `{ version, localhostViaProxy, trafficLogging, proxies[], rules[] }`（密码遮蔽） | ✓ / ✗ / ✓ / ✗ | `PROFILE_NOT_FOUND`、`PROFILE_PARSE_ERROR` |
| `proxybridge_start` | `{ profilePath, verbose?: 0..3, cliPath?, readyTimeoutMs? }` | `{ started, pid, profilePath, verbose, readyMs }` | ✗ / ✓ / ✓（拒绝式：二次调用返回 `ALREADY_RUNNING`） / ✓ | `ENV_NOT_ADMIN`、`ALREADY_RUNNING`、`CLI_START_FAILED`、`PROFILE_NOT_FOUND` |
| `proxybridge_status` | `{}` | `{ running, pid?, startedAt?, uptimeMs?, profilePath?, verbose?, logLines, errorLines, lastExit?, note? }` | ✓ / ✗ / ✓ / ✗ | 无 |
| `proxybridge_logs` | `{ lines?, tail? }` | `{ lines: [{ n, stream, text }], dropped, totalLines, note? }` | ✓ / ✗ / ✓ / ✗ | 无 |
| `proxybridge_stop` | `{ timeoutMs? }` | `{ stopped, exitCode?, durationMs, method }` | ✗ / ✓ / ✓（拒绝式：二次调用返回 `NOT_RUNNING`） / ✓ | `NOT_RUNNING` |
| `proxybridge_test_proxy` | `{ host, port, timeoutMs? }` | `{ result: "reachable"\|"refused"\|"timeout"\|"unresolved"\|"unreachable", elapsedMs, note }` | ✓ / ✗ / ✓ / ✓ | `PROXY_TIMEOUT_INVALID`、`TEST_PROXY_PORT_INVALID` |

#### 5.1.1 错误码总表

每个错误码的返回体固定为四字段 `{ code, message, fieldPath, hint }`（NFR-11）。
`fieldPath` 为 `null` 表示全局性错误。`阻断` 列表示该错误是否阻止操作执行。

| 错误码 | 触发条件 | message 模板 | hint 要点 | 阻断 |
| --- | --- | --- | --- | --- |
| `ENV_CLI_NOT_FOUND` | 全部候选路径均无 `ProxyBridge_CLI.exe` | `未找到 ProxyBridge_CLI.exe，已尝试：{candidates}` | 设置 `PROXYBRIDGE_CLI_PATH` 或在工具入参中给出 `cliPath` | 是 |
| `ENV_CLI_NOT_EXECUTABLE` | 找到文件但执行 `--version` 失败 | `找到 {path} 但无法执行：{原始错误}` | 检查文件权限与 Windows 兼容性 | 是 |
| `ENV_CORE_DLL_MISSING` | 同目录下无 `ProxyBridgeCore.dll` | `缺少 {path}\ProxyBridgeCore.dll，CLI 无法启动` | CLI 与 DLL 必须同目录，请完整安装 | 是 |
| `ENV_ADMIN_CHECK_FAILED` | FR-4 三级检测均失败 | `无法判定管理员身份` | 手动以管理员身份运行 MCP 宿主后重试 | 是 |
| `ENV_NOT_ADMIN` | FR-12 启动前置检测为非管理员 | `当前非管理员，ProxyBridge CLI 的 --profile 需要管理员权限` | 以管理员身份运行 MCP 宿主；profile 相关工具在非管理员下仍可使用 | 是 |
| `ALREADY_RUNNING` | 已有受管子进程在运行 | `已有实例在运行（pid={pid}，profile={path}）` | 先调用 `proxybridge_stop` | 是 |
| `CLI_START_FAILED` | 就绪窗口内子进程退出（FR-12） | `CLI 启动后立即退出（exitCode={code}）：{stderr 尾行}` | 检查 profile 是否合法、DLL 是否同目录、驱动是否可用；若确认属启动偏慢，可用 `readyTimeoutMs` 放宽 | 是 |
| `NOT_RUNNING` | 未在运行时调用 `stop` | `当前没有受管进程` | 先调用 `proxybridge_start` | 是 |
| `PROFILE_NOT_FOUND` | 给定路径不存在 | `文件不存在：{path}` | 用 `proxybridge_list_profiles` 查看现有 profile | 是 |
| `PROFILE_PARSE_ERROR` | 读取的 profile 非合法 JSON | `解析失败：{原始错误}` | 检查文件编码与 JSON 结构 | 是 |
| `PROFILE_DIR_UNREADABLE` | 列举目录失败 | `无法读取目录 {dir}：{原始错误}` | 确认路径与访问权限 | 是 |
| `PROFILE_FILE_EXISTS` | 目标文件已存在且未要求覆盖 | `文件已存在：{path}` | 传 `overwrite: true` 或换文件名 | 是 |
| `PROFILE_WRITE_FAILED` | 落盘失败（磁盘满/只读/目标是目录/无权限） | `写入失败：{path}：{系统原始错误}` | 检查磁盘空间、目录权限与目标路径 | 是 |
| `PROFILE_PATH_OUT_OF_BASE` | `filename` 含路径分隔符 / `..` / 绝对路径，或结果越界基准目录 | `非法输出路径：{filename}，必须落在 {baseDir} 内` | 只传纯文件名；换目录请用 `dir` 入参或 `PROXYBRIDGE_PROFILE_DIR` | 是 |
| `PROFILE_SCHEMA_INVALID` | JSON 解析失败、缺字段、类型错误 | `{fieldPath}: {原因}` | 按 FR-5 表逐字段核对 | 是 |
| `PROFILE_UNKNOWN_FIELD` | 出现未定义的**顶层**字段 | `未知字段 {fieldPath}` | 仅使用 FR-5 列出的顶层字段 | 是 |
| `PROFILE_VERSION_UNSUPPORTED` | `Version ≠ "1.0"` | `Version 只支持 "1.0"，收到 "{v}"` | 从 GUI 重新导出 profile | 是 |
| `PROXY_LIMIT_EXCEEDED` | 代理数 > 16 | `代理配置数 {n} 超过上限 16` | 合并代理端点或拆成多个 profile | 是 |
| `PROXY_LIST_EMPTY` | 代理数为 0 | `ProxyConfigs 为空` | 空配置合法性待实测；如只需 DIRECT/BLOCK 规则请人工确认后再生成 | 是 |
| `PROXY_ID_DUPLICATE` | id 重复 | `proxies[{i}].id={v} 与第 {j} 项重复` | 保证 id 唯一 | 是 |
| `PROXY_TYPE_INVALID` | `Type` 非枚举值 | `proxies[{i}].type="{v}" 非法` | 只允许 `socks5` 或 `http` | 是 |
| `PROXY_PORT_INVALID` | `proxies[].port` 非 1–65535 | `proxies[{i}].port={v} 非法` | 端口范围 1–65535 | 是 |
| `RULE_LIMIT_EXCEEDED` | 规则数 > 200 | `规则数 {n} 超过上限 200` | 用通配进程名合并同类规则 | 是 |
| `RULE_PROCESS_EMPTY` | `ProcessName` 空 | `rules[{i}].processName 为空` | 填进程名或 `*` | 是 |
| `RULE_ACTION_INVALID` | `Action` 非枚举值 | `rules[{i}].action="{v}" 非法` | 只允许 `DIRECT`/`BLOCK`/`PROXY` | 是 |
| `RULE_PROTOCOL_INVALID` | `Protocol` 非枚举值 | `rules[{i}].protocol="{v}" 非法` | 只允许 `TCP`/`UDP`/`BOTH` | 是 |
| `RULE_PROXY_REF_MISSING` | PROXY 动作无有效 `ProxyConfigId` | `rules[{i}].action=PROXY 但 ProxyConfigId={v} 未命中任何代理` | 指向 `proxies[].id` 中的某一项 | 是 |
| `PROFILE_HOST_PATTERN_INVALID` | `TargetHosts` 片段无法解析 | `rules[{i}].targetHosts 片段 "{seg}" 无法解析` | 按 FR-5.2 语法 | 是 |
| `PROFILE_PORT_PATTERN_INVALID` | `TargetPorts` 片段无法解析 | `rules[{i}].targetPorts 片段 "{seg}" 无法解析` | 按 FR-5.3 语法 | 是 |
| `PROXY_TIMEOUT_INVALID` | `timeoutMs` 非正整数或超过 60000 | `timeoutMs={v} 非法` | 取值范围 1–60000 毫秒 | 是 |
| `TEST_PROXY_PORT_INVALID` | `test_proxy` 的 `port` 非 1–65535 | `port={v} 非法` | 取值范围 1–65535 | 是 |

上表 28 个阻断级码中，前 15 个为 **FR-7 的校验码**（进 `errors[]`），其余为工具级码（抛错）。
**警告级码**（不阻断，写入 `warnings[]`）：

| 警告码 | 触发条件 | 说明 |
| --- | --- | --- |
| `RULE_SHADOWED` | FR-8 遮蔽判定命中 | 后置规则永远不会被求值 |
| `RULE_OVERRIDDEN_BY_FORCED_DIRECT` | FR-9 强制直连段命中 | PROXY 动作被覆盖为 DIRECT |
| `RULE_UDP_REQUIRES_SOCKS5` | FR-10 UDP 组合命中 | 文案按引用代理类型分（http / socks5） |
| `RULE_PROXY_REF_ON_NON_PROXY` | 非 PROXY 动作却带 `ProxyConfigId` | **降级为警告**（§8 决策 D-2 与 Q-1）：GUI 导出在 DIRECT/BLOCK 规则上是否带 `ProxyConfigId: 0` 尚未验证（Q-1），阻断级门禁会误拒 GUI 导出的合法写法 |
| `PROFILE_UNKNOWN_FIELD`（警告形态） | 嵌套对象内出现未定义键 | 字段路径回显在 `fieldPath` |

#### 5.1.2 并发与幂等范围

- **单实例**：start / stop / status 三个工具共享同一个串行化队列（内部互斥），
  同一时刻至多存在一个受管子进程，并发调用 start 不会起出两个进程。
  该队列保证 status 不被长耗时的 stop 阻塞超过 stop 自身的超时上限。
- **幂等语义**：无副作用且可重复调用的工具标 `✓`；有副作用的重复调用**一律走拒绝式幂等**
  （第二次返回 `ALREADY_RUNNING` / `NOT_RUNNING` / `PROFILE_FILE_EXISTS` 且不产生新状态）。
- **不做的事**：本项目不实现跨 MCP 调用方（多个 Agent 会话共享同一个 CLI 实例）的并发控制，
  该边界由 §5.3 的「状态不持久化」自然限定——每个 MCP 进程只管理自己拉起的子进程。

### 5.2 CLI 契约（外部依赖，实测 V4.1.1）

MCP 依赖以下 CLI 行为，**不修改**：

| 调用 | 需要管理员 | 预期行为（实测） |
| --- | --- | --- |
| `--help` / `-?` / `-h` | 否 | stdout 打印 ASCII Logo + 作者 + GitHub + 选项列表，退出码 0 |
| `--version` | 否 | 打印版本信息，退出码 0 |
| `--update` | 否 | 检查更新并打开发布页 |
| `--profile <path> [--verbose <0-3>]` | **是** | 非管理员时在解析 profile **之前**即失败，stderr 输出 `ERROR: Administrator privileges required.`；管理员下前台常驻运行，转发 stdout/stderr，`Ctrl+C` 退出 |

verbose 语义：`0` 静默（默认）、`1` 仅日志消息、`2` 仅连接事件、`3` 两者兼有。
MCP 启动时默认使用 `verbose=1`，因为 `--verbose 0` 会让日志工具无内容可读。

**spawn 契约（NFR-14 的落地形式）**：

| 选项 | 取值 | 理由 |
| --- | --- | --- |
| 参数传递 | 始终为 argv **数组**，如 `[--profile, profilePath, --verbose, String(verbose)]` | 杜绝命令注入 |
| `shell` | `false` | Windows 下 `shell: true` 会经 `cmd.exe` 二次解析，含空格/引号的路径与恶意输入可逃逸 |
| `windowsHide` | `true` | 不弹出控制台窗口 |
| `detached` | `false` | 子进程留在本进程作业内，退出事件可被可靠观测（FR-17） |
| `stdio` | `['ignore', 'pipe', 'pipe']` | stdin 忽略；stdout/stderr 接入日志环形缓冲（FR-15） |
| `cwd` | CLI 可执行文件所在目录 | 满足 DLL 同目录要求（FR-3） |
| 终止方式 | `taskkill /PID <pid> /T /F`，`shell: false`，argv 数组 | 见 FR-16 与决策 D-3 |

### 5.3 数据生命周期

- `.pbprofile` 文件：由 MCP 生成或用户从 GUI 导出。生成文件含明文凭据（NFR-15），
  MCP 不修改其 ACL、不加密、不上传、不自动清理。读类工具不改文件。
- 子进程句柄与运行状态：**只存于 MCP 进程内存，不持久化**。MCP 进程重启后运行状态归零，
  `lastExit` 一并消失（FR-14 已对齐该语义）。若 MCP 宿主自身崩溃（非 `proxybridge_stop`
  触发，如 OOM/segfault），其子进程会被 OS 一并回收，`lastExit` 随 MCP 进程丢失，下次
  `start` 新建实例；此行为与 `proxybridge_status` 的 `note` 字段「运行状态不跨 MCP 重启保留」
  一致。
- 日志环形缓冲：只存于内存，最多 5000 行（FR-15），不落盘。
- 管理员检测过程：无状态产生（只读系统查询，FR-4）。
- **本项目明确不做**跨 MCP 会话的运行状态持久化（assumed：属于非目标，评审可挑战）。
  推论：若 MCP 宿主崩溃，其拉起的 CLI 子进程会随宿主一起结束，用户需重新 `start`。

### 5.4 目录布局

```
D:\ProxyBridge-skill\
├── COPYING                       GPL-3.0
├── README.md
├── SPEC.md
├── PLAN.md
├── package.json                  根脚本入口（用 npm --prefix 委派，不声明 workspaces）
├── .gitignore
├── scripts/                      仓库级校验脚本（§4 的度量方式）
│   ├── bench-startup.ts          NFR-1：冷启动 20 次取 P50
│   ├── check-license.ts          NFR-12：COPYING / SPDX / package.json license
│   ├── check-tools.ts            NFR-9：工具名前缀 + 四注解齐全 + openWorld 口径
│   ├── check-no-shell.ts         NFR-5 / NFR-14 / R-5：禁用 runas / ShellExecute / shell:true / 按名批量 kill
│   └── check-skill-refs.ts       AC-16：SKILL.md 引用的 references 均存在
├── .github/
│   └── workflows/
│       └── ci.yml                runs-on: windows-latest；Node 版本矩阵 + 上述全部脚本
├── packages/
│   └── mcp-server/
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts          入口：stdio server 注册
│       │   ├── cli/              locate.ts / version.ts / admin.ts
│       │   ├── profile/          schema.ts / build.ts / validate.ts / read.ts / patterns.ts
│       │   ├── process/          supervisor.ts / logbuffer.ts
│       │   ├── net/              probe.ts
│       │   ├── tools/            每个工具一个文件
│       │   └── errors.ts         §5.1.1 错误码与结构化错误
│       ├── test/
│       │   ├── fixtures/
│       │   │   └── gui-export.pbprofile   真实 GUI 导出夹具（凭据已清洗，见 AC-18）
│       │   └── *.test.ts         单元测试 + 模拟进程的联调用例
└── skills/
    └── proxybridge/
        ├── SKILL.md
        └── references/
            ├── rule-syntax.md    进程/IP/端口匹配语法
            ├── routing-semantics.md  匹配顺序、localhost、强制直连
            └── udp-and-quic.md   UDP/QUIC/HTTP3 限制与排查
```

CI 说明：本项目的全部路径假设、`taskkill` 依赖与 §5.2 spawn 契约均为 Windows 专属，
`ci.yml` 固定 `runs-on: windows-latest`，不设 Linux/macOS 矩阵。

## 6. Acceptance criteria

| 编号 | 对应 | 验收条件 | 验证方式 |
| --- | --- | --- | --- |
| AC-1 | NFR-7/8 | `npm run build`、`tsc --noEmit`、`npm run lint` 均零错误 | `npm run build && npm run lint` |
| AC-2 | FR-1~FR-4 | `proxybridge_check_environment` 返回 `found=true`、真实路径、`version` 含 `4.1.1`、`coreDllPresent=true`；非管理员下 `isAdmin=false`、`adminCheckMethod=integrity-sid`；管理员下 `isAdmin=true`；三处均与 `whoami /groups` 的人工判读一致。另用注入的伪造命令输出单测覆盖：二级/三级降级路径、以及 `adminCheckConflict=true` 分支 | 管理员与非管理员各跑一次真实调用 + 3 条依赖注入单测 |
| AC-3 | FR-6 | 「chrome.exe 走 SOCKS5、curl.exe 走 HTTP」请求产出的 JSON 含 2 个 `ProxyConfigs` 与 2 条 `ProxyRules`，`ProxyConfigId` 指向正确 id，`Port` 落盘为字符串 | 单测断言 `typeof parsed.Port === 'string'` + 人工检视产物 |
| AC-4 | FR-7 | FR-7 表中全部 15 个阻断级校验错误码各有一条单测，断言返回体四字段齐全且 `fieldPath` 与 `message` 内嵌字段名一致 | `npm test` 逐 case |
| AC-5 | FR-8 | 构造 6 组用例：`ALL` 遮蔽任意、通配段遮蔽具体 IP、区间真包含、非代理字段全同 → 报 `RULE_SHADOWED`；`ch*` vs `chrome.exe`、IP vs 区间 → **不报**；另加禁用规则（前或后）→ 不报 | 单测（正例 4 条 + 反例 3 条） |
| AC-6 | FR-9/FR-10 | 五组用例：PROXY 规则命中 `169.254.0.0/16` → `RULE_OVERRIDDEN_BY_FORCED_DIRECT`；命中 `192.168.*.*` 通配段覆盖组播 → 报；`Protocol=BOTH` 且 `TargetPorts` 为 `*` 覆盖 DHCP 端口 → 报；`TargetHosts=example.com`（域类）→ 不报；`Protocol=TCP` 且 `TargetPorts=67` → 不报。另 FR-10：引用 `type=http` 与 `type=socks5` 各一条，断言 `RULE_UDP_REQUIRES_SOCKS5` 文案不同 | 单测 |
| AC-7 | FR-12 | 非管理员身份下调用 `proxybridge_start` 返回 `ENV_NOT_ADMIN`，系统中不出现 UAC 对话框，且 `tasklist` 中无 `ProxyBridge_CLI.exe` 残留 | 管理员联调前先以非管理员跑一次并截图 |
| AC-8 | FR-12/14/15/16 | **管理员身份真实联调**：以管理员启动 MCP 宿主，走三轮。轮一 `verbose: 1`：start 返回 `started:true` 与真实 pid → status 返回同一 pid 与 `running:true` → logs 读到日志行 → stop 返回 `stopped:true` 且 `tasklist` 中该 pid 已消失。轮二 `verbose: 2`：logs 能读到连接事件行。轮三：记录 `readyTimeoutMs` 默认值下的 `readyMs` 实测范围，写入 `README.md` 的「环境备注」段；
SPEC §1.2 仅记录 3000ms 默认值的由来，不回写实测结果。若均值显著低于 500ms，需在 §8 决策 D-7
中追加修订记录重新评估默认值合理性（解 Q-5） | 真实执行（需用户配合提权），逐项截图/记录输出 |
| AC-9 | FR-17 + R-8 | 启动后用任务管理器杀掉子进程，status 返回 `running=false`、带退出码与最后若干行日志；杀进程后本机网络恢复正常（WinDivert 重定向已失效） | 管理员联调环节顺带验证 |
| AC-10 | FR-18 | 四组用例：本机临时监听的端口 → `reachable`；同机已确认关闭的端口 → `refused`（非 `timeout`）；保留 TLD 域名 `nonexistent.invalid` → `unresolved`；`192.0.2.1:81` + `timeoutMs=1500` → 结果 ∈ {`timeout`, `unreachable`} 且总耗时 ≤ 2500 ms | 三个确定性单测 + 一次真实调用（`192.0.2.1` 的实际结果记入 README） |
| AC-11 | NFR-3 | `mcp-inspector` 连接无协议错误；stdout 首字节为 JSON-RPC 帧（`{`），全程无非协议输出 | `npx @modelcontextprotocol/inspector` 实测 |
| AC-12 | NFR-4 | 读取含密码的 profile，返回体中所有 `Password` 为 `***` | 单测 |
| AC-13 | NFR-5 + R-5 | 全仓检索无 `runas` / `ShellExecute` / `ShellExecuteEx`；且源码中不存在按进程名或通配路径批量终止的调用（`taskkill` 的目标 PID 必须来自受管实例记录） | `npm run check:no-shell` 零命中 + 人工核对 `taskkill` 调用点 |
| AC-14 | NFR-9/10 | 工具清单全部 `proxybridge_` 前缀且四注解齐全；源码无硬编码 `E:\Program Files\ProxyBridge`（默认候选表除外） | `npm run check:tools` + `rg -n "E:\\\\Program Files" packages/` 仅命中候选表 |
| AC-15 | NFR-12/13/14 | `COPYING` 存在；每个 `.ts` 首行有 SPDX 头；`package.json` 含 `"license": "GPL-3.0-or-later"`；所有 spawn 调用点 `shell:false`；**横幅行为**：以 stdio（非 TTY）方式启动时 stdout 无横幅、`PROXYBRIDGE_MCP_BANNER=1` 时 stderr 出现完整横幅（作者/版本/许可证） | `npm run check:license && npm run check:no-shell` + 手工两次执行 |
| AC-16 | G-5 | `skills/proxybridge/SKILL.md` 存在，frontmatter 含 `name` + `description`（第三人称，含 ≥ 3 个具体触发短语）；正文 ≤ 400 行；三份 `references/*.md` 各 ≥ 40 行且均被 SKILL.md 引用 | `npm run check:skill-refs` + 行数统计 |
| AC-17 | G-1~G-4 | 用 MCP 工具从零完成一次真实代理配置（生成 profile → 校验 → 启动 → 观察连接 → 停止），全过程无需手写 JSON | 管理员联调中端到端走一遍 |
| AC-18 | FR-11 + R-1 | 用**真实 GUI 导出的** `.pbprofile` 夹具（`packages/mcp-server/test/fixtures/gui-export.pbprofile`，凭据已清洗）跑 `proxybridge_read_profile` 与 `proxybridge_validate_profile`：read 返回结构化摘要且密码为 `***`；validate 的结论（通过或仅含警告）记入 README，用于校准 `PROFILE_UNKNOWN_FIELD` 的严格度 | 单测 + 人工检视 |
| AC-19 | FR-19 | `proxybridge_test_proxy` 返回体含 `note` 字段，且文案明确「TCP 可连不等于代理协议可用」 | 单测断言字段与文案 |
| AC-20 | NFR-15 | `proxybridge_build_profile` 返回体含 `credentialNotice` 明文提示 | 单测 |
| AC-21 | FR-15 | 向日志缓冲灌入 6000 行后调用 `proxybridge_logs`：断言 `totalLines === 5000`、`dropped > 0`、返回行数等于可用行数；未启动进程时调用返回 `{ lines: [], totalLines: 0, note }` 且不报错；`tail` 与 `lines` 同时给出时以 `lines` 为准 | 单测（模拟进程输出 6000 行） |
| AC-22 | NFR-6 | `filename` 分别取 `..\x.pbprofile`、`a/b.pbprofile`、`C:\x.pbprofile` 三条，均返回 `PROFILE_PATH_OUT_OF_BASE`，且基准目录内未产生任何文件 | 单测 |
| AC-23 | FR-13 | 已有受管进程时再次调用 `proxybridge_start`：返回 `ALREADY_RUNNING` 且附带原 pid，`tasklist` 中进程数未增加 | 联调用例 |
| AC-24 | NFR-1 | `npm run bench:startup` 输出冷启动 P50 并记录到 README；P50 ≥ 2000 ms 时记录为已知偏差并说明原因 | `npm run bench:startup` |

## 7. Risks and open questions

| 编号 | 风险 | 可能性 | 影响 | 缓解 |
| --- | --- | --- | --- | --- |
| R-1 | `.pbprofile` 的实际解析器比文档严格，或真实 GUI 导出含文档示例未列出的字段 | 中 | 高：生成的 profile 跑不起来，或校验在主路径上误拒 | 先以真实 GUI 导出夹具（AC-18）确定实际字段集，再据此校准 `PROFILE_UNKNOWN_FIELD` 的分级（顶层阻断 / 嵌套警告）；AC-8 真实联调最终验证 |
| R-2 | `ProxyConfigs` 为空数组是否被 CLI 接受未知 | 中 | 中：影响是否允许纯 DIRECT/BLOCK profile | 已在 FR-5 标为 (assumed)；生成器保守拒绝并提示；AC-8 中实测一次空配置行为并回写 SPEC |
| R-3 | CLI 的 stdout 是 UTF-8 还是本地代码页，中文/本地化输出可能乱码 | 中 | **中**：影响日志可读性与 AC-8 联调观察 | FR-15 已规定按 UTF-8 解码、非法序列替换为 `�`；AC-8 中观察真实输出 |
| R-4 | 非管理员下 CLI 是否先解析 profile 再报错 | 低 | 中 | 已实测证伪：非管理员下 stderr 固定为权限错误且先于解析（§1.2）。FR-4 已改用系统命令判定，该风险不再影响设计 |
| R-5 | `taskkill /T` 按父子关系杀进程树时误杀无关进程 | 低 | 高 | 只终止 FR-12 自己记录的单个 pid，禁止按进程名/通配路径批量终止；AC-13 专项检索确认 |
| R-6 | Skill 里的路由语义随 ProxyBridge 版本漂移 | 中 | 中：指导过期 | SKILL.md 标注适用的 CLI 版本（当前 V4.1.1），并写明升级后需复核的三处文档章节 |
| R-7 | 用户以管理员身份运行 MCP 会扩大宿主进程权限面 | 中 | 中：安全面变大 | 文档化提示：若不需要启动流量路由，profile 相关工具可在非管理员下正常使用 |
| R-8 | 强制终止后 WinDivert 重定向或系统代理残留 | 低 | 中 | Windows 在进程终止时关闭句柄（assumed）；AC-9 实测杀进程后本机网络恢复；Skill 的排查章节给出用户侧确认方法 |
| R-9 | `Port` 落盘形态若与真实解析器不符会导致 CLI 启动失败 | 低 | 高 | 已按官方文档与 GUI 导出兼容性定为 string（决策 D-1）；AC-8 中额外用 number 形态生成一次做对照，记录 CLI 实际接受哪种 |
| R-10 | `whoami` / `fsutil` 在受限容器或裁剪版 Windows 中缺失或不可用 | 低 | 中：无法判定管理员身份 | FR-4 三级降级；三级全失败时返回 `ENV_ADMIN_CHECK_FAILED` 而非误判为非管理员；AC-2 用依赖注入单测覆盖失败路径 |

**开放问题**

| 编号 | 问题 | 谁能回答 |
| --- | --- | --- |
| Q-1 | `ProxyConfigId` 在 `Action="DIRECT"` / `"BLOCK"` 的规则里填 `0` 与省略该字段是否等价？ | 生成器当前**省略**该字段（决策 D-2）；相应校验码已降级为警告（§5.1.1）；AC-8 用 GUI 导出原件顺带实测 |
| Q-2 | CLI 是否支持 profile 热重载？文档未提 | AC-8 联调时观察；若支持可省去 stop/start |
| Q-3 | 是否需要为 `nexus-proxy`（InterceptSuite 的 SOCKS5 服务器，支持 UDP ASSOCIATE / QUIC）提供专门工具？当前判定为范围外 | 用户；可在后续里程碑追加 |
| Q-4 | 真实 GUI 导出的 profile 含哪些字段？含不含示例外字段？ | AC-18 用真实导出夹具确定；结论回写 §5.1.1 的 `PROFILE_UNKNOWN_FIELD` 分级 |
| Q-5 | 管理员下 CLI 从 spawn 到「可接受流量」的实际耗时是多少？ | AC-8 轮三实测 `readyMs` 并写 README 环境备注段（SPEC §1.2 仅记录默认值由来）；若均值显著低于 500ms 则在 §8 决策 D-7 追加修订记录 |
| Q-6 | FR-8/FR-9 中 IPv6 区间比较是否依赖外部库（`ipaddr.js` / `BigInt`）？纯 Node 标准库是否足够？ | 实现者（需在 FR-8 步骤 1 补充归一化实现约束后验证） |
| Q-7 | FR-17 子进程异常退出采用「按需观测」还是「事件驱动」路径？ | 架构决策（本轮已锁定事件驱动路径，此处作为实施前最终确认） |

## 8. 关键决策

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| D-1 | `Port` 落盘为**字符串** | 官方 profile JSON 示例两处均为字符串；文档明确 CLI 的输入是「GUI 导出的 profile」，与 GUI 导出保持一致是硬约束。请求层仍接受 number 以便调用方便（R-9 保留对照实测） |
| D-2 | 非 PROXY 动作的规则**省略** `ProxyConfigId` 字段；对应校验码降级为警告 | 文档只给了 PROXY 场景的示例（Q-1 未决）。省略可规避「填 0 与填 null 是否等价」这个未验证分支；阻断级门禁会误拒 GUI 导出的合法写法，因此该码降为警告 |
| D-3 | `stop` 采用 `taskkill /T /F` 单阶段强制终止，放弃两阶段优雅停止 | 纯 Node 缺少 `GenerateConsoleCtrlEvent` 等价原语；为实现优雅停止而引入原生模块会拖入编译工具链，与「最小实现」和 NFR-7 的兼容性目标冲突（决策 D-4） |
| D-4 | 不引入原生模块与编译工具链 | CLI 交互只需 TCP 建连与进程启停，Node 标准库足够；引入原生依赖会破坏「clone 后 `npm install && npm run build` 即可用」这一验收前提 |
| D-5 | 写路径受基准目录约束，读/执行路径只要求调用方显式给出 | 路径穿越的实质风险在写入；限制读取会阻断「运行用户从 GUI 导出的 profile」这一主路径（MCP 与调用方同为用户信任域） |
| D-6 | 管理员检测使用 `whoami /groups`（一级）+ `fsutil dirty query`（二级）+ `net session`（三级），**不使用 ProxyBridge 进程做探测** | 权限门信号虽来自产品自身，但其「探测子进程是否加载驱动」在管理员侧从未实测（Q-4 同源问题），且探测实例不受受管表管辖，可能与 `start` 形成双重重定向。系统命令路线已实测三条全为只读、零副作用、且一级判定不受系统语言影响 |
| D-7 | 启动就绪窗口默认 3000 ms，且可通过 `readyTimeoutMs` 放宽 | NativeAOT DLL + 驱动初始化耗时未知（Q-5），固定 1000 ms 易误报；可配置让慢环境可自救，错误 hint 也指向该参数 |
| D-8 | 错误返回体统一为四字段 `{ code, message, fieldPath, hint }` | FR-7 要求回显字段路径、`fieldPath` 缺失会让校验错误无法定位；三处表述曾互斥，统一后 FR-7 / §5.1.1 / NFR-11 / AC-4 全部对齐 |
| D-9 | 未知字段分级：顶层阻断、嵌套警告 | 文档字段清单来源是官网示例，而主路径是读取 GUI 导出的 profile；一刀切阻断会在真实导出含示例外字段时全线失败（Q-4） |
| D-10 | 启动横幅写 stderr，且仅在 TTY 或 `PROXYBRIDGE_MCP_BANNER=1` 时打印 | MCP stdio 传输下 `stdin` 恒为 JSON-RPC 通道，「从 stdin 读取时打印横幅」的条件永远成立，若写 stdout 会污染协议流。此决策使 NFR-3 与 NFR-13 同时成立 |
| D-11 | 测试连通性错误码改名为 `TEST_PROXY_PORT_INVALID` | 与校验层的 `PROXY_PORT_INVALID` 同码会让客户端无法按 `code` 分支区分来源 |

## 9. Review log

### 第 1 轮

- **评审方式**：`use_agent(agent="document-reviewer")` 在本机因 provider 适配器缺失无法派发
  （报 `no adapter registered for provider "inherit"`，改写为具体模型 ID 同样失败），
  降级为通用 subagent 通道，内联 DocReview 的完整六步方法论与输出格式，评审口径不变。
- **结论**：CHANGES REQUESTED（1 Blocking / 6 High / 8 Medium / 1 Low）。
- **findings 与处置**：

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| B-1 | Blocking | NFR-6 提到「调用方指定的目录」但文档无此概念，`outPath` 为任意路径，NFR 无法实施且与 FR-6/5.1 冲突 | 新增 FR-5.4 定义基准目录（入参 `dir` → `PROXYBRIDGE_PROFILE_DIR` → `%USERPROFILE%\Documents\ProxyBridge-profiles`）；生成工具入参改为纯 `filename`；新增 `PROFILE_PATH_OUT_OF_BASE`；读类工具明确不做基准约束并给出理由（D-5）；NFR-6 改写；AC-14 补检索 |
| H-1 | High | `Port` 声明为 number，与官方 schema 的字符串冲突 | 改为 string（决策 D-1），请求层兼容 number；补 `Version` 约束与 `PROFILE_VERSION_UNSUPPORTED`、`PROFILE_UNKNOWN_FIELD` 错误码与 AC；新增 R-9 |
| H-2 | High | FR-8 超集遮蔽无可实现算法，无「不可判定」策略，无规则数上限 | FR-8 重写为六步判定算法（归一化 → 四态比较 → 规则级合并 → 保守不报）；新增 `rules[] ≤ 200` 上界与 `RULE_LIMIT_EXCEEDED`；AC-5 拆成正例 4 条 + 反例 2 条 |
| H-3 | High | FR-4 把管理员检测方式推给实现 | FR-4 固化为三级策略（详见第 2 轮 N-2/N-8，已再次改写） |
| H-4 | High | FR-16 两阶段优雅终止在纯 Node 下缺原语 | 改为 `taskkill /T /F` 单阶段强制终止（决策 D-3、D-4），输出 schema 去掉恒真的 `forced`、改为 `method`；新增 R-8 与 AC-9 的残留验证 |
| H-5 | High | FR-18 三态不足、AC-10 fixture 不可复现、FR-18 与 5.1 入参不一致 | 状态扩为五态并给出每个 Node 错误码的映射表；入参统一为 `{host, port, timeoutMs?}`，删除「或直接给 proxy 配置对象」的表述；AC-10 改为三组确定性用例 + 一组记录实际结果的非确定性用例 |
| H-6 | High | 未规定 spawn 形态，存在命令注入面 | §5.2 新增 spawn 契约表（argv 数组 / `shell:false` / `windowsHide` / `detached:false` / stdio / cwd）；新增 NFR-14 与 `check:no-shell` 脚本；AC-15 扩展 |
| M-1 | Medium | FR-14 与 5.3 对 `lastExit` 跨重启语义矛盾 | 统一为纯内存态：FR-14 删去「重启后说明上次退出原因」，改为返回 `note`；`lastExit` 在 5.1 中标注为可选内存态 |
| M-2 | Medium | 缺统一错误码注册表；`proxies[]` 为 0 无码 | 新增 §5.1.1 错误码总表（触发条件 / message 模板 / hint / 是否阻断）；新增 `PROXY_LIST_EMPTY` 等码 |
| M-3 | Medium | start 的立即返回存在竞态，`CLI_START_FAILED` 无触发定义 | FR-12 增加启动就绪窗口；AC-8 断言随之确定化 |
| M-4 | Medium | 未声明并发/幂等边界，`idempotentHint` 标注与行为不符 | 新增 §5.1.2 并发与幂等范围（单实例串行队列、拒绝式幂等、不做跨调用方控制）；5.1 表逐工具修正注解 |
| M-5 | Medium | FR 与 AC 未一一对应；AC-4 措辞错；AC-8 未写明 `verbose:2` | 新增 AC-18/19/20；AC-8 拆为 `verbose:1` 与 `verbose:2` 两轮 |
| M-6 | Medium | 日志缓冲 2000 行与 `lines` 上限 5000 自相矛盾 | 缓冲上限统一为 5000 行，明确内存量级与「请求行数 > 可用行数时返回全部并置 `dropped>0`」 |
| M-7 | Medium | 5.4 缺 `scripts/` 与 CI 产物；AC-16 词数口径不可机械判定；单包却声明 workspaces | 5.4 补 5 个校验脚本与 `.github/workflows/ci.yml`；NFR-1 补 P50/测量点定义；AC-16 改为行数 + 触发短语数 + 引用完整性；根 `package.json` 去掉 workspaces 改用 `npm --prefix` |
| M-8 | Medium | 缺凭据落盘告知、强杀残留风险、写入失败异常流 | 新增 NFR-15 与 AC-20；新增 R-8 与 AC-9 残留验证；FR-6 新增 `PROFILE_WRITE_FAILED` |
| L-1 | Low | 5.1 表缺 `destructiveHint` 列，`openWorldHint` 口径不一致 | 5.1 补齐四注解列；表前用一句话固定两个 hint 的判定口径 |

### 第 2 轮

- **结论**：CHANGES REQUESTED（2 High / 13 Medium / 4 Low）。
- **核验结论**：16 条中 9 条完全修复，7 条部分修复；本轮新增问题的根因高度集中——
  第 1 轮修 FR-8 时建立了精确算法范式，但 FR-9/FR-10 未跟上；同时 3 处新增内容之间引入了新的互相矛盾。
- **findings 与处置**：

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| N-1 | High | NFR-13「从 stdin 读取时打印横幅」与 NFR-3「stdout 独占」互斥——stdio 传输下条件恒真 | 决策 D-10：横幅写 stderr，且仅在 `process.stdin.isTTY === true` 或 `PROXYBRIDGE_MCP_BANNER=1` 时打印；NFR-13 与 AC-15 同步改写；AC-11 增加「stdout 首字节为 `{`」断言；§4 增加两条 NFR 的关系说明 |
| N-2 | High | FR-4 一级探测（CLI 权限门）在管理员侧的副作用未实测，且探测子进程无回收定义，可能与 `start` 形成双重重定向 | **放弃 CLI 探测方案**（决策 D-6）：改为 `whoami /groups`（一级）+ `fsutil dirty query`（二级）+ `net session`（三级），三条已实测为只读、零副作用；新增 R-10；AC-7 增加「`tasklist` 无残留」断言 |
| N-3 | Medium | 错误返回体形状在 FR-7 / §5.1.1 / NFR-11 / AC-4 四处互斥 | 决策 D-8：统一为四字段 `{ code, message, fieldPath, hint }`；四处表述同步改写；§5.1.1 总表补 `fieldPath` 列语义 |
| N-4 | Medium | `list_profiles` 分配了 `PROFILE_PATH_OUT_OF_BASE`，与 D-5「读类工具不做基准约束」矛盾且该码在其上不可达 | §5.1 删除该行的该错误码；FR-5.4 补充说明唯一例外（`dir` 缺省时才用基准目录） |
| N-5 | Medium | FR-9 只有自然语言，无判定算法，且未覆盖 DHCP 端口这一**端口维度** | FR-9 重写为 9 行判定表，复用 FR-8 的归一化与 `SUPERSET` 语义，并补入 UDP 端口条件；AC-6 从 1 组扩到 5 组 |
| N-6 | Medium | FR-13、FR-15、NFR-1、NFR-6 无任何 AC 覆盖 | 新增 AC-21（FR-15 环形缓冲与 `dropped`）、AC-22（NFR-6 三种穿越输入）、AC-23（FR-13 `ALREADY_RUNNING`）、AC-24（NFR-1 记录 P50） |
| N-7 | Medium | `check_environment` 的 `openWorld ✗` 违反文档自定口径（它会 spawn CLI） | 改为 `openWorld ✓`；口径句补「凡 spawn 外部进程或建立网络连接者一律 ✓」，供 `check-tools.ts` 机械断言 |
| N-8 | Medium | FR-4 二级降级在现有错误次序下不可达，AC-2 的降级验证无法执行 | 随 N-2 一并解决：一级为 `whoami /groups`，CLI 缺失不再是降级前提；AC-2 改用**依赖注入的伪造命令输出**单测覆盖二级/三级与冲突分支，可执行 |
| N-9 | Medium | Q-1 未决，但 `RULE_PROXY_REF_ON_NON_PROXY` 是阻断级，会误拒 GUI 导出的合法写法 | 决策 D-2：该码降级为警告并移入警告表；AC-8 增加「用 GUI 导出原件跑 validate」一轮 |
| N-10 | Medium | `PROFILE_UNKNOWN_FIELD` 全量拒绝与主路径冲突，且 AC-18 未规定夹具来源 | 决策 D-9：顶层阻断、嵌套警告；AC-18 明确使用真实 GUI 导出夹具（5.4 已补 fixtures 路径）；R-1 缓解改为「先用夹具确定字段集再校准严格度」；新增 Q-4 |
| N-11 | Medium | `PROXY_PORT_INVALID` 一码两义；AC-4 的「17 个」不可机械核对 | 决策 D-11：工具层改名 `TEST_PROXY_PORT_INVALID`；§5.1.1 拆为「15 个校验码 + 13 个工具级码」两段并显式说明；AC-4 改为「FR-7 表中全部 15 个阻断级校验错误码」 |
| N-12 | Medium | 1000 ms 就绪窗口无依据，可能误报使 AC-8 变脆 | 决策 D-7：默认 3000 ms + `readyTimeoutMs` 可配置（500–30000），写明依据；`CLI_START_FAILED` 的 hint 增加放宽指引；新增 Q-5；AC-8 轮三实测并回写 §1.2 |
| N-13 | Medium | FR-10 的 UDP 警告未按引用代理类型区分，SOCKS5 场景文案误导 | FR-10 改为按 `ProxyConfigId` 指向 `type=http` / `type=socks5` / 引用无效三分支给文案；AC-6 增加两条正例 |
| N-14 | Medium | `validate_profile` 的错误码词汇未定义（`valid:false` 时 `errors[].code` 取值域未定），与 NFR-11 冲突 | FR-7 明确区分工具级失败与业务结果；`errors[].code` 取值域 = FR-7 的 15 个码；§5.1 该行补 `PROFILE_NOT_FOUND` / `PROFILE_PARSE_ERROR` |
| N-15 | Medium | FR-15 的 `tail` 与 `lines` 语义重叠、优先级未定义；无进程时的 `logs` 返回未定义 | FR-15 收敛为单一 `lines`（默认 100、上限 5000），`tail` 保留为别名且以 `lines` 为准；无进程时返回 `{ lines: [], dropped: 0, totalLines: 0, note }` 不报错；AC-21 覆盖 |
| N-16 | Low | NFR-6 行单元格数与表头不符 | 删除多余竖线，并把度量方式补为 AC-22 |
| N-17 | Low | R-5 缓解误引 AC-13（AC-13 当时只查 UAC 相关调用） | AC-13 扩展为同时覆盖 R-5：断言 `taskkill` 的目标 PID 必须来自受管实例记录；R-5 缓解改引 AC-13 |
| N-18 | Low | FR-8 把 `ALL`（token 取值）混入比较结果集合；禁用规则只排除了前置 `a` | 步骤 3 改为只用 `SUPERSET` / `SAME` 两态并单独定义严格包含条件；步骤 5 改为「`a` 或 `b` 任一方禁用即不报」；AC-5 增加对应的反例 |
| N-19 | Low | `check-tools.ts` 所需的 SDK 注解字段名未文档化；CI 运行平台未指定 | §5.1 表下声明四列与 `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` 按序对应；§5.4 与 CI 说明中固定 `runs-on: windows-latest` |

- **下一轮结论**：待定。

### 第 3 轮

- **评审方式**：`DocReview` agent 按六维度审查（一致性 / 完整性 / 可实施性 / 风险覆盖 / 验收可测性 / 结构合理性）。
- **结论**：**Conditional Pass（需修改后重审）**——共发现 6 条新问题（2 High / 2 Medium / 2 Low），无 Blocking / High 级阻断问题，整体达到可进入实施预备状态。
- **findings 与处置**：

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| H-01 | High | FR-17 未锁定子进程异常退出的观测路径（按需观测 vs 事件驱动），导致 AC-9 只能验证其中一条路径 | 明确采用**事件驱动**路径：`start` 时注册 `ChildProcess.close` 事件处理器同步更新内存状态；FR-17 补充状态机转换与 MCP 自身崩溃场景与 §5.3 的衔接 |
| H-02 | High | FR-8 步骤 2 缺少两类归一化/判定细节：① IPv6 区间比较的数值化手段未定义；②「严格 SUPERSET」未形式化 | 步骤 1 追加约束「IPv4/IPv6 区间比较须先将地址数值化为无符号 128-bit 整数（Node `BigInt` 或等价手段），禁止字符串字典序」；步骤 3 重写为「严格包含关系定义 + 等价判定 + 严格超集判定」两段，消除歧义 |
| M-01 | Medium | §5.3 未覆盖 MCP 自身崩溃（OOM/segfault）场景下 `lastExit` 丢失行为 | §5.3 子进程句柄段补充一行：若 MCP 宿主自身崩溃，子进程随宿主被 OS 回收，`lastExit` 丢失，下次 `start` 新建实例——行为与 `note` 字段一致 |
| M-02 | Medium | §5.1 表 `readOnly` 口径未说明读操作输出可能对外部数据字段做遮蔽变形 | 在 `readOnlyHint` 口径句补充例外说明：「读操作可能对外部数据的某些字段做遮蔽处理（如 `Password → ***`），不改变文件系统，仍视为 `readOnly`；客户端需知晓输出可能被脱敏」 |
| L-01 | Low | R-3 标了 UTF-8 乱码风险但 FR-15 未定义编码策略；影响等级偏低 | FR-15 补「子进程 stdout/stderr 字节流按 UTF-8 解码，非法序列替换为 U+FFFD」；R-3 影响从「低」上调至「中」 |
| L-02 | Low | AC-8 轮三「回写 README 与 §1.2」存在歧义：SPEC 定稿后不应再改；实测 `readyMs` 每次不同 | 改为「记录 `readyMs` 实测范围写入 `README.md` 的「环境备注」段；SPEC §1.2 仅记录 3000ms 默认值由来，不回写实测结果；若均值显著低于 500ms 则在 §8 决策 D-7 追加修订记录」；Q-5 同步改写 |

- **下一轮结论**：待第 4 轮复审。