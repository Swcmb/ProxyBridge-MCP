# ProxyBridge MCP Server — 实施计划

对应 `SPEC.md` 的 §6 验收标准（AC-1~AC-24）与 §5.4 目录布局。

## 阶段划分

### 阶段 1：基础设施（已完成）

| 任务 | 对应 AC | 验证方式 | 状态 |
| --- | --- | --- | --- |
| 项目骨架（package.json / tsconfig / .gitignore / COPYING / CI） | AC-1 | `npm run build && tsc --noEmit` 零错误 | ✅ 完成 |
| 错误码体系（errors.ts） | AC-4 | 单测逐 code 覆盖 | ✅ 完成 |
| Profile 校验器（validate.ts） | AC-4~6 | 单测断言 | ✅ 完成 |
| Profile 生成器（build.ts） | AC-3 | 单测 | ✅ 完成 |
| Profile 读取（read.ts） | AC-12 | 单测 | ✅ 完成 |
| 连通性探测（probe.ts） | AC-10/19 | 单测 | ✅ 完成 |
| 进程生命周期（supervisor.ts / logbuffer.ts） | AC-7~9, 21, 23 | 联调用例 | ✅ 完成 |
| MCP Server 入口与工具注册（index.ts） | AC-11 | `mcp-inspector` 实测 | ✅ 完成 |
| CLI 定位与管理员检测（locate.ts / admin.ts） | AC-2 | 真实调用 + 注入单测 | ✅ 完成 |
| Skill 文档（SKILL.md + 3 份 references） | AC-16 | `check:skill-refs` | ✅ 完成 |
| 5 个校验脚本 | AC-14/15 | `npx tsx scripts/check-*.ts` | ✅ 完成 |

### 阶段 2：真实联调（需用户配合提权）

| 任务 | 对应 AC | 前置条件 | 状态 |
| --- | --- | --- | --- |
| 管理员身份真实联调（三轮：verbose 1/2/3 + 就绪窗口实测） | AC-8/17 | 用户以管理员身份启动 MCP 宿主 | ⏳ 待执行 |
| 非管理员启动拒绝验证 | AC-7 | 非管理员环境 | ⏳ 待执行 |
| 子进程异常退出 + WinDivert 残留验证 | AC-9 | 任务管理器手动杀进程 | ⏳ 待执行 |
| 连通性五态真实调用（192.0.2.1:81 结果记入 README） | AC-10 | 网络可用 | ⏳ 待执行 |
| `mcp-inspector` 协议纯净性验证 | AC-11 | — | ⏳ 待执行 |
| `bench:startup` 冷启动 P50 实测 | AC-24 | — | ⏳ 待执行 |
| GUI 导出夹具验证（AC-18） | AC-18 | 用户提供真实 `.pbprofile` 夹具 | ⏳ 待执行 |

### 阶段 3：收尾

| 任务 | 说明 |
| --- | --- |
| 补 AC-5~AC-22 剩余单测 | FR-8 遮蔽 7 组用例、FR-9/10 五组用例、FR-15 环形缓冲、NFR-6 三种穿越输入、NFR-1 P50 记录等 |
| 补 test/fixtures/ 目录内容 | gui-export.pbprofile 真实夹具 |
| 补 eslint 配置 | `lint` 脚本依赖 |
| CI 全绿 | GitHub Actions 推 main 后验证 |

## 未决风险（来自 SPEC §7）

| 风险 | 缓解 |
| --- | --- |
| R-1 profile 解析器比文档严格 | AC-18 夹具确定字段集后校准 `PROFILE_UNKNOWN_FIELD` 分级 |
| R-2 空 `ProxyConfigs` 合法性未知 | AC-8 联调实测一次空配置行为 |
| Q-5 冷启动耗时未知 | AC-8 轮三实测 `readyMs` 回写 README 环境备注段 |
| Q-7 事件驱动路径 | SPEC 已锁定，实现已按 close 事件监听落地 |
