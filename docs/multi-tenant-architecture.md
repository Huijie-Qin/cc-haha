# cc-haha 多租户 SaaS 架构说明文档

> 版本: v1.0 | 日期: 2026-04-20 | 状态: 设计阶段

---

## 1. 概述

cc-haha 多租户 SaaS 方案将当前的单用户桌面/客户端应用，改造为云原生 SaaS 服务。多个租户（组织）通过统一 Web API 使用 Claude Code Agent，各租户的数据与会话逻辑隔离。

### 双模式运行

| 模式 | 环境变量 | 说明 |
|------|---------|------|
| `local` | `CC_MODE=local`（默认） | 单用户 CLI/Desktop 模式，与当前行为完全一致，无需 Docker/PostgreSQL |
| `saas` | `CC_MODE=saas` | 多租户云服务模式，需 PostgreSQL + Docker |

**核心原则：`local` 模式零侵入——不加载 DB 模块，不引入 Docker 依赖，所有现有功能不变。**

---

## 2. 整体架构

### 2.1 系统架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              外部用户                                       │
│                                                                              │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐         │
│   │ Web 浏览器 │    │ Telegram │    │  飞书    │    │ 其他 IM 适配器│         │
│   └─────┬─────┘    └────┬─────┘    └────┬─────┘    └──────┬───────┘         │
│         │               │               │                 │                  │
│         ▼               ▼               ▼                 ▼                  │
└─────────┬───────────────┬───────────────┬─────────────────┬──────────────────┘
          │ HTTPS/WSS     │               │                 │
          ▼               ▼               ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         负载均衡器 (nginx/caddy)                              │
│                     │  HTTPS 终结  │  WSS 代理  │  会话粘滞  │                │
└────────────────────────────┬────────────────────────────────────────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Gateway 1  │  │   Gateway 2  │  │   Gateway N  │       ← 无状态，水平扩展
│              │  │              │  │              │
│ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────────┐ │
│ │ JWT 鉴权 │ │  │ │ JWT 鉴权 │ │  │ │ JWT 鉴权 │ │
│ │ 限流     │ │  │ │ 限流     │ │  │ │ 限流     │ │
│ │ 路由     │ │  │ │ 路由     │ │  │ │ 路由     │ │
│ │ WS 代理  │ │  │ │ WS 代理  │ │  │ │ WS 代理  │ │
│ │ SPA 托管 │ │  │ │ SPA 托管 │ │  │ │ SPA 托管 │ │
│ └──────────┘ │  │ └──────────┘ │  │ └──────────┘ │
└──────┬───┬───┘  └──────┬───┬───┘  └──────┬───┬───┘
       │   │              │   │              │   │
       │   └──────────────┼───┼──────────────┘   │
       │                  │   │                   │
       ▼                  ▼   │                   ▼
┌──────────────┐  ┌──────────┴───┐         ┌──────────────┐
│  PostgreSQL  │  │ Orchestrator │         │  PostgreSQL  │
│              │  │              │         │  (只读副本)   │
│ ┌──────────┐ │  │ ┌──────────┐ │         └──────────────┘
│ │ 租户数据 │ │  │ │ 容器生命周期│ │
│ │ 会话记录 │ │  │ │ Volume 管理│ │
│ │ 用量审计 │ │  │ │ 健康检查   │ │
│ │ RLS 隔离 │ │  │ │ 资源限制   │ │
│ └──────────┘ │  │ └──────────┘ │
└──────────────┘  └──────┬───────┘
                         │ Docker API
       ┌─────────────────┼─────────────────┐
       │                 │                 │
       ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Agent 容器 1 │  │  Agent 容器 2 │  │  Agent 容器 N │     ← 按 session 粒度创建
│  (CLI + SDK) │  │  (CLI + SDK) │  │  (CLI + SDK) │
│              │  │              │  │              │
│ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────────┐ │
│ │ 3 Volume │ │  │ │ 3 Volume │ │  │ │ 3 Volume │ │
│ │ 挂载     │ │  │ │ 挂载     │ │  │ │ 挂载     │ │
│ └──────────┘ │  │ └──────────┘ │  │ └──────────┘ │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                  │                 │
       └──────────────────┼─────────────────┘
                          │ HTTPS
                          ▼
              ┌────────────────────────┐
              │   LLM Provider API     │
              │   (Anthropic/OpenAI/..) │
              └────────────────────────┘
```

### 2.2 三大核心组件

| 组件 | 代码路径 | 职责 | 状态 |
|------|---------|------|------|
| **Gateway** | `src/gateway/` | 统一入口：JWT 鉴权、限流、路由、WS 代理、SPA 托管 | 无状态，可水平扩展 |
| **Orchestrator** | `src/orchestrator/` | Docker 容器生命周期管理、Volume 管理、健康检查 | 有状态，单实例/Docker 主机 |
| **Agent Container** | 容器镜像 | CLI agent 运行时，每 session 一个容器 | 随 session 创建/销毁 |

---

## 3. 核心数据流

### 3.1 用户提问完整流程

以用户提问 "帮我生成一份 SQL" 为例，展示完整的数据流交互：

```
用户浏览器              Gateway               Orchestrator          Agent 容器           PostgreSQL
    │                    │                      │                    │                    │
    │  1. POST /api/auth/login                │                    │                    │
    │  email+password    │                      │                    │                    │
    │───────────────────►│                      │                    │                    │
    │                    │  2. 查询 users 表     │                    │                    │
    │                    │───────────────────────────────────────────────────────────────►│
    │                    │  3. 返回用户信息      │                    │                    │
    │                    │◄───────────────────────────────────────────────────────────────│
    │                    │                      │                    │                    │
    │                    │  4. 生成 JWT (RS256)  │                    │                    │
    │                    │  {sub,tid,role,exp}   │                    │                    │
    │  5. 返回 accessToken + refreshToken       │                    │                    │
    │◄───────────────────│                      │                    │                    │
    │                    │                      │                    │                    │
    │  6. POST /api/sessions                    │                    │                    │
    │  Authorization: Bearer <jwt>              │                    │                    │
    │───────────────────►│                      │                    │                    │
    │                    │  7. 验证 JWT          │                    │                    │
    │                    │  提取 tenantId+userId │                    │                    │
    │                    │                      │                    │                    │
    │                    │  8. INSERT INTO sessions                  │                    │
    │                    │───────────────────────────────────────────────────────────────►│
    │  9. 返回 sessionId │                      │                    │                    │
    │◄───────────────────│                      │                    │                    │
    │                    │                      │                    │                    │
    │  10. WSS /ws/{sessionId}?token=<jwt>      │                    │                    │
    │  发送: {"type":"user_message",             │                    │                    │
    │        "content":"帮我生成一份SQL"}         │                    │                    │
    │═══════════════════►│                      │                    │                    │
    │                    │                      │                    │                    │
    │                    │  11. 验证 JWT         │                    │                    │
    │                    │  检查 session 属于该 tenantId              │                    │
    │                    │                      │                    │                    │
    │                    │  12. POST /internal/sessions/{id}/start   │                    │
    │                    │  {tenantId, userId, providerConfig, ...}  │                    │
    │                    │─────────────────────►│                    │                    │
    │                    │                      │                    │                    │
    │                    │                      │  13. 解密 BYOK key │                    │
    │                    │                      │  14. 创建 Docker 容器                    │
    │                    │                      │  - 挂载 3 个 Volume │                    │
    │                    │                      │  - 注入环境变量     │                    │
    │                    │                      │  - CLI args 含 --sdk-url                 │
    │                    │                      │───────────────────►│                    │
    │                    │                      │                    │                    │
    │                    │                      │                    │  15. CLI 启动      │
    │                    │                      │                    │  加载记忆文件      │
    │                    │                      │                    │  (Managed→User→    │
    │                    │                      │                    │   Project→AutoMem) │
    │                    │                      │                    │                    │
    │                    │  16. SDK WS 连接     │                    │                    │
    │                    │◄─────────────────────────────────────│                    │
    │                    │                      │                    │                    │
    │                    │  17. 返回 containerId+status=active    │                    │
    │                    │◄─────────────────────│                    │                    │
    │                    │                      │                    │                    │
    │                    │  18. 转发 user_message 到 SDK WS        │                    │
    │                    │─────────────────────────────────────►│                    │
    │                    │                      │                    │                    │
    │                    │                      │                    │  19. CLI 调用      │
    │                    │                      │                    │  Anthropic API     │
    │                    │                      │                    │─────────────────►  │
    │                    │                      │                    │                    │
    │                    │                      │                    │  20. 流式响应       │
    │                    │                      │                    │◄──────────────────  │
    │                    │                      │                    │                    │
    │  21. 流式推送                       │                    │                    │
    │  {"type":"content_delta","text":".."}      │                    │                    │
    │◄═══════════════════│◄─────────────────────────────────────│                    │
    │                    │                      │                    │                    │
    │  ... 更多 delta ... │                      │                    │                    │
    │                    │                      │                    │                    │
    │  22. message_complete                      │                    │                    │
    │  {"type":"message_complete","usage":{...}} │                    │                    │
    │◄═══════════════════│◄─────────────────────────────────────│                    │
    │                    │                      │                    │                    │
    │                    │  23. INSERT conversation_messages       │                    │
    │                    │  (解析 usage, 累加 tenant_usage)         │                    │
    │                    │───────────────────────────────────────────────────────────────►│
```

### 3.2 鉴权流程（JWT）

```
┌────────┐                           ┌────────┐                           ┌────────┐
│  客户端  │                           │ Gateway │                           │  数据库  │
└───┬────┘                           └───┬────┘                           └───┬────┘
    │                                    │                                    │
    │  POST /api/auth/register           │                                    │
    │  {email, password, tenantName,     │                                    │
    │   tenantSlug}                      │                                    │
    │───────────────────────────────────►│                                    │
    │                                    │  INSERT tenants + users            │
    │                                    │───────────────────────────────────►│
    │                                    │◄───────────────────────────────────│
    │                                    │                                    │
    │                                    │  签发 JWT:                         │
    │                                    │  accessToken  (15min, RS256)       │
    │                                    │  refreshToken (7d, RS256)          │
    │◄───────────────────────────────────│                                    │
    │                                    │                                    │
    │                                    │                                    │
    │  后续请求:                          │                                    │
    │  Authorization: Bearer <accessToken>                                    │
    │───────────────────────────────────►│                                    │
    │                                    │  验证签名+有效期                     │
    │                                    │  提取 {sub:userId, tid:tenantId,   │
    │                                    │        role:"member"}              │
    │                                    │  注入 RequestContext               │
    │                                    │                                    │
    │                                    │                                    │
    │  accessToken 过期后:                 │                                    │
    │  POST /api/auth/refresh            │                                    │
    │  {refreshToken}                    │                                    │
    │───────────────────────────────────►│                                    │
    │                                    │  验证 refreshToken                 │
    │                                    │  签发新 accessToken                │
    │◄───────────────────────────────────│                                    │
```

### 3.3 WebSocket 消息代理流程

```
客户端 WS                  Gateway                   Agent 容器 SDK WS
    │                        │                            │
    │  ws://host/ws/{sid}    │                            │
    │  ?token=<jwt>          │                            │
    │═══════════════════════►│                            │
    │                        │  验证 JWT                   │
    │                        │  检查 session.tenantId      │
    │                        │  === jwt.tenantId           │
    │  {"type":"connected"}  │                            │
    │◄═══════════════════════│                            │
    │                        │                            │
    │  {"type":"user_message",│                           │
    │   "content":"..."}     │                            │
    │───────────────────────►│  转发到 SDK WS              │
    │                        │───────────────────────────►│
    │                        │                            │
    │                        │  SDK 响应:                  │
    │                        │◄───────────────────────────│
    │  {"type":"status",     │                            │
    │   "state":"thinking"}  │  翻译+转发                  │
    │◄───────────────────────│                            │
    │                        │                            │
    │  {"type":"content_delta",│                          │
    │   "text":"..."}        │                            │
    │◄───────────────────────│◄───────────────────────────│
    │                        │                            │
    │                        │                            │
    │  工具调用需要权限:       │                            │
    │  {"type":"permission_  │◄───────────────────────────│
    │   "request",...}       │                            │
    │◄───────────────────────│                            │
    │                        │                            │
    │  {"type":"permission_  │                            │
    │   "response",          │                            │
    │   "allowed":true}      │                            │
    │───────────────────────►│───────────────────────────►│
    │                        │                            │
```

---

## 4. 多租户记忆系统

### 4.1 记忆层级与加载优先级

CLI 的 `getMemoryFiles()` 函数（`src/utils/claudemd.ts`）按固定优先级加载记忆，**后加载的优先级更高**。多租户方案通过环境变量和 Volume 挂载，将租户记忆注入 Managed 类型路径，用户记忆注入 User 类型路径，利用现有类型系统实现天然隔离。

```
优先级 (低 → 高)
│
│  ┌─────────────────────────────────────────────────────────────────────┐
│  │ 1. Managed 类型                                                     │
│  │    路径: /etc/claude-code/CLAUDE.md                                 │
│  │    来源: tenant-{id}-home volume  →  租户级 (所有用户继承)            │
│  │    代码: getManagedFilePath() → /etc/claude-code (Linux)            │
│  └─────────────────────────────────────────────────────────────────────┘
│
│  ┌─────────────────────────────────────────────────────────────────────┐
│  │ 2. Managed 规则                                                     │
│  │    路径: /etc/claude-code/.claude/rules/*.md                       │
│  │    来源: tenant-{id}-home volume  →  租户级规则                      │
│  │    代码: getManagedClaudeRulesDir()                                 │
│  └─────────────────────────────────────────────────────────────────────┘
│
│  ┌─────────────────────────────────────────────────────────────────────┐
│  │ 3. User 类型                                                        │
│  │    路径: $CLAUDE_CONFIG_DIR/CLAUDE.md                               │
│  │         = /home/agent/.claude/users/{userId}/CLAUDE.md              │
│  │    来源: tenant-{id}-user-{userId} volume  →  用户私有               │
│  │    代码: getClaudeConfigHomeDir() 读取 CLAUDE_CONFIG_DIR 环境变量     │
│  └─────────────────────────────────────────────────────────────────────┘
│
│  ┌─────────────────────────────────────────────────────────────────────┐
│  │ 4. User 规则                                                        │
│  │    路径: $CLAUDE_CONFIG_DIR/rules/*.md                              │
│  │    来源: tenant-{id}-user-{userId} volume  →  用户私有规则            │
│  └─────────────────────────────────────────────────────────────────────┘
│
│  ┌─────────────────────────────────────────────────────────────────────┐
│  │ 5. Project 类型                                                     │
│  │    路径: /workspace/CLAUDE.md                                       │
│  │    来源: tenant-{id}-workspace volume  →  租户共享项目级              │
│  │    代码: getOriginalCwd()/CLAUDE.md                                 │
│  └─────────────────────────────────────────────────────────────────────┘
│
│  ┌─────────────────────────────────────────────────────────────────────┐
│  │ 6. Local 类型                                                       │
│  │    路径: /workspace/CLAUDE.local.md                                 │
│  │    来源: tenant-{id}-workspace volume  →  用户私有项目级              │
│  └─────────────────────────────────────────────────────────────────────┘
│
│  ┌─────────────────────────────────────────────────────────────────────┐
│  │ 7. AutoMem 类型                                                     │
│  │    路径: $CLAUDE_CONFIG_DIR/projects/{path}/memory/MEMORY.md        │
│  │    来源: tenant-{id}-user-{userId} volume  →  用户私有自动记忆        │
│  │    代码: getAutoMemEntrypoint()                                     │
│  └─────────────────────────────────────────────────────────────────────┘
```

### 4.2 三层 Volume 挂载方案

每个 Agent 容器挂载 3 个 Docker named volume，对应 3 个独立挂载点，实现记忆的多层级隔离：

```
┌───────────────────────────────────────────────────────────────────────┐
│                        Agent 容器                                      │
│                                                                        │
│  ┌─ /etc/claude-code/ ──────────────────────────────────────────────┐ │
│  │  [tenant-acme-home volume]  挂载点                               │ │
│  │                                                                    │ │
│  │  CLI 加载方式: Managed 类型 (最低优先级，所有用户继承)                │ │
│  │                                                                    │ │
│  │  ├── CLAUDE.md                ← 租户全局指令                       │ │
│  │  ├── .claude/rules/          ← 租户级规则                         │ │
│  │  │   └── coding-standards.md                                      │ │
│  │  └── managed-settings.d/     ← 租户级管理设置                      │ │
│  │                                                                    │ │
│  │  写入控制: 仅通过 Gateway API 管理，agent 容器只读                    │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  ┌─ /home/agent/.claude/users/alice/ ───────────────────────────────┐ │
│  │  [tenant-acme-user-alice volume]  挂载点                          │ │
│  │                                                                    │ │
│  │  CLI 加载方式: User 类型 (中优先级，覆盖 Managed)                   │ │
│  │  环境变量: CLAUDE_CONFIG_DIR=/home/agent/.claude/users/alice       │ │
│  │                                                                    │ │
│  │  ├── CLAUDE.md                ← Alice 私有用户级指令                │ │
│  │  ├── rules/                   ← Alice 私有规则                     │ │
│  │  ├── cache/                   ← Alice 缓存                        │ │
│  │  └── projects/{path}/                                              │ │
│  │      ├── memory/MEMORY.md    ← Alice 的 AutoMem                  │ │
│  │      └── {sid}.jsonl         ← 会话恢复缓存                       │ │
│  │                                                                    │ │
│  │  写入控制: Agent 可读写，仅 Alice 的容器可访问此 volume              │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  ┌─ /workspace/ ─────────────────────────────────────────────────────┐ │
│  │  [tenant-acme-workspace volume]  挂载点                            │ │
│  │                                                                    │ │
│  │  CLI 加载方式: Project + Local 类型 (较高优先级)                    │ │
│  │                                                                    │ │
│  │  ├── CLAUDE.md                ← 项目级指令 (租户共享)               │ │
│  │  ├── CLAUDE.local.md          ← 用户私有项目指令                    │ │
│  │  ├── .claude/rules/           ← 项目级规则                         │ │
│  │  └── (项目文件)               ← 代码仓库                           │ │
│  │                                                                    │ │
│  │  写入控制: Agent 可读写 (受权限系统约束)                             │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  关键设计:                                                             │
│  · 无软链接 — Managed 和 User 在不同路径，不存在同名冲突               │
│  · 无 CLI 代码修改 — 利用现有 getManagedFilePath() + CLAUDE_CONFIG_DIR │
│  · 租户级记忆通过 Managed 路径加载，用户级覆盖生效                      │
└───────────────────────────────────────────────────────────────────────────┘
```

### 4.3 用户间记忆加载对比

同一租户 Acme 的 Alice 和 Bob 各自看到不同的记忆加载结果：

```
Alice 的容器                              Bob 的容器
────────────                              ────────────

1. Managed:                               1. Managed:
   /etc/claude-code/CLAUDE.md                /etc/claude-code/CLAUDE.md
   → "Acme 编码规范 v2"  ✓ 相同              → "Acme 编码规范 v2"  ✓ 相同

2. Managed 规则:                          2. Managed 规则:
   /etc/claude-code/.claude/rules/           /etc/claude-code/.claude/rules/
   → "代码必须通过 lint" ✓ 相同               → "代码必须通过 lint" ✓ 相同

3. User:                                  3. User:
   ~/.claude/users/alice/CLAUDE.md           ~/.claude/users/bob/CLAUDE.md
   → "我偏好中文注释"  ✗ 不同                  → "我偏好英文注释"  ✗ 不同

4. User 规则:                             4. User 规则:
   ~/.claude/users/alice/rules/              ~/.claude/users/bob/rules/
   → "使用函数式风格"  ✗ 不同                  → "使用面向对象风格" ✗ 不同

5. Project:                               5. Project:
   /workspace/CLAUDE.md                      /workspace/CLAUDE.md
   → "本项目使用 React"  ✓ 相同               → "本项目使用 React"  ✓ 相同

6. Local:                                 6. Local:
   /workspace/CLAUDE.local.md                /workspace/CLAUDE.local.md
   → Alice 的本地覆盖   ✗ 不同                → Bob 的本地覆盖     ✗ 不同

7. AutoMem:                               7. AutoMem:
   alice/projects/.../MEMORY.md              bob/projects/.../MEMORY.md
   → Alice 的自动记忆   ✗ 不同                → Bob 的自动记忆     ✗ 不同
```

### 4.4 隔离保证矩阵

| 隔离维度 | 保证方式 | 具体机制 |
|---------|---------|---------|
| 跨租户 | Volume 命名隔离 | `tenant-A-*` volume 不会挂载到租户 B 的容器 |
| 跨租户 | 数据库查询隔离 | 所有 SQL 查询包含 `WHERE tenant_id = $1` |
| 跨租户 | RLS（纵深防御） | PostgreSQL Row-Level Security 策略 |
| 同租户跨用户 | User volume 隔离 | `tenant-A-user-alice` vs `tenant-A-user-bob` 各自独立 |
| 同租户共享 | 租户级 Managed volume | 同租户所有容器共享 `/etc/claude-code/` |
| 同租户共享 | 项目级 Workspace volume | 同租户所有容器共享 `/workspace/` |

---

## 5. 容器生命周期

### 5.1 状态机

```
                    ┌─────────┐
                    │  [none]  │
                    └────┬─────┘
                         │ onFirstMessage
                         ▼
                    ┌──────────┐
            ┌──────│ creating  │
            │      └────┬──────┘
            │           │ 容器启动成功
            │           ▼
            │      ┌─────────┐    onDisconnect
            │      │  active  │────────────────┐
            │      └────┬──────┘                │
            │           │                       ▼
            │           │              ┌────────────┐
            │           │              │    idle     │◄─── onReconnect (30s 内)
            │           │              └─────┬──────┘
            │           │                    │ onIdleTimeout
            │           │                    ▼
            │      onUserStop          ┌────────────┐
            │           │              │ destroying  │
            │           │              └─────┬──────┘
            │           │                    │
            │           └────────────────────┘
            │                                │
            │  onContainerExit               │
            └────────────────────────────────┘
                                             │
                                             ▼
                                        ┌─────────┐
                                        │  [none]  │
                                        └─────────┘
```

### 5.2 容器作用域

**一个 session 对应一个容器**。同一用户的多个 session 各自有独立容器。并发上限由 plan 控制：

| Plan | 最大并发 Session | 单容器 CPU | 单容器内存 | 闲置超时 |
|------|-----------------|-----------|-----------|---------|
| Free | 1 | 0.5 CPU | 512 MB | 30s |
| Pro | 5 | 1 CPU | 2 GB | 5min |
| Enterprise | 无限 | 2 CPU | 4 GB | 可配置 |

### 5.3 容器销毁触发

| 场景 | 触发 | 流程 |
|------|------|------|
| 用户主动停止 | `DELETE /api/sessions/:id` | Gateway → Orchestrator → `docker stop --time 3` → SIGTERM(3s) → SIGKILL → `--rm` 自动移除 |
| 断连闲置超时 | WS 断开 → 超时计时器 | 同上流程 |
| 容器崩溃 | Docker exit 事件 | 清理 container_id，推送错误到客户端，下次消息自动 `--resume` |
| 定期清扫（兜底） | 每60s巡检 | DB 状态与 Docker API 交叉校验，清理孤立记录/容器 |

### 5.4 资源清理

| 资源 | 容器销毁时释放? | 说明 |
|------|---------------|------|
| 容器进程 | 是 | `docker stop` + `--rm` |
| 容器网络/文件系统 | 是 | Docker 自动回收 |
| `/workspace` 数据 | **否** | named volume 持久化 |
| `/etc/claude-code` 数据 | **否** | named volume 持久化（租户级记忆） |
| User volume 数据 | **否** | named volume 持久化（用户级记忆） |
| DB 会话记录 | **否** | PostgreSQL 数据不变 |
| CPU/内存 | 是 | 归还宿主机 |

---

## 6. 数据库设计

### 6.1 ER 关系图

```
┌──────────────┐       ┌──────────────┐       ┌───────────────────┐
│   tenants    │       │    users     │       │ provider_configs  │
│──────────────│       │──────────────│       │───────────────────│
│ id (PK)      │◄──┐   │ id (PK)      │   ┌──│ id (PK)           │
│ name         │   │   │ tenant_id(FK)│───┘  │ tenant_id (FK)    │
│ slug (UNIQ)  │   │   │ email        │      │ name              │
│ plan         │   │   │ password_hash│      │ type              │
│ settings     │   │   │ display_name │      │ base_url          │
│ created_at   │   │   │ role         │      │ auth_token (加密)  │
│ updated_at   │   │   │ auth_providers│     │ models            │
└──────┬───────┘   │   │ created_at   │      │ is_active         │
       │           │   └──────┬───────┘      └───────────────────┘
       │           │          │
       │           │          │
       │           │          ▼
       │           │   ┌──────────────────┐      ┌────────────────────────┐
       │           └──│    sessions       │      │ conversation_messages   │
       │              │──────────────────│      │────────────────────────│
       │              │ id (PK)           │─────│ id (PK)                │
       │              │ tenant_id (FK)    │     │ session_id (FK,CASCADE)│
       │              │ user_id (FK)      │     │ tenant_id (FK)         │
       │              │ title             │     │ role                   │
       │              │ work_dir          │     │ content (JSONB)        │
       │              │ model             │     │ model                  │
       │              │ permission_mode   │     │ parent_tool_use_id     │
       │              │ container_id      │     │ created_at             │
       │              │ status            │     └────────────────────────┘
       │              │ created_at        │
       │              │ updated_at        │
       │              └──────┬────────────┘
       │                     │
       │                     ▼
       │              ┌──────────────────┐
       │              │     teams        │
       │              │──────────────────│
       └─────────────│ id (PK)           │
                      │ tenant_id (FK)    │
                      │ name              │
                      │ lead_agent_id     │
                      │ lead_session_id(FK)│
                      └──────┬───────────┘
                             │
                             ▼
                      ┌──────────────────┐
                      │  team_members    │
                      │──────────────────│
                      │ id (PK)           │
                      │ team_id (FK,CASC) │
                      │ agent_id          │
                      │ name              │
                      │ agent_type        │
                      │ model             │
                      │ status            │
                      │ session_id (FK)   │
                      └──────────────────┘

       ┌──────────────────┐     ┌──────────────────┐
       │   audit_logs     │     │   tenant_usage   │
       │──────────────────│     │──────────────────│
       │ id (PK)          │     │ id (PK)          │
       │ tenant_id        │     │ tenant_id (FK)   │
       │ user_id          │     │ date             │
       │ action           │     │ input_tokens     │
       │ resource         │     │ output_tokens    │
       │ details (JSONB)  │     │ request_count    │
       │ created_at       │     │ UNIQUE(t,d)      │
       └──────────────────┘     └──────────────────┘
```

### 6.2 隔离策略

所有数据表均包含 `tenant_id` 列，所有查询强制带 `WHERE tenant_id = $1`。纵深防御启用 PostgreSQL RLS：

```sql
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions
  USING (tenant_id = current_setting('app.current_tenant')::uuid);
```

Gateway 在每次数据库操作前设置 `app.current_tenant`。

---

## 7. API 与通信协议

### 7.1 REST API 总览

```
┌─────────────────────────────────────────────────────────────────┐
│  认证 (/api/auth/*)                                             │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ POST /register   注册租户+用户，返回 JWT pair            │    │
│  │ POST /login      邮箱密码登录，返回 JWT pair              │    │
│  │ POST /refresh    刷新 accessToken                       │    │
│  │ POST /social     社交 OAuth (Google/GitHub)              │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  会话 (/api/sessions/*) — 租户隔离                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ GET    /           列出当前用户会话                       │    │
│  │ POST   /           创建新会话                             │    │
│  │ GET    /:id        获取会话详情                           │    │
│  │ PATCH  /:id        更新会话                               │    │
│  │ DELETE /:id        停止并删除会话                         │    │
│  │ GET    /:id/messages  获取对话消息                        │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Provider (/api/providers/*) — 租户隔离                           │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ GET    /           列出租户的 provider 配置               │    │
│  │ POST   /           添加 BYOK provider                    │    │
│  │ PUT    /:id        更新 provider                          │    │
│  │ DELETE /:id        删除 provider                          │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  设置/团队/技能/等 — 租户隔离                                      │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ GET/PATCH  /api/settings                                │    │
│  │ GET/POST   /api/teams                                   │    │
│  │ ...                                                      │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  系统                                                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ GET /api/status    健康检查 (公开)                        │    │
│  │ GET /health        简单健康检查                           │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Gateway ↔ Orchestrator 内部通信

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/internal/sessions/:id/start` | 创建/定位容器 |
| POST | `/internal/sessions/:id/stop` | 销毁容器 |
| GET | `/internal/sessions/:id/status` | 检查容器健康 |
| GET | `/internal/health` | Orchestrator 自身健康 |

### 7.3 WebSocket 协议

**连接**: `wss://<host>/ws/<sessionId>?token=<jwt>`

客户端 → 服务端:

```json
{ "type": "user_message", "content": "text" }
{ "type": "permission_response", "requestId": "...", "allowed": true }
{ "type": "set_permission_mode", "mode": "default" }
{ "type": "stop_generation" }
{ "type": "ping" }
```

服务端 → 客户端:

```json
{ "type": "connected", "sessionId": "..." }
{ "type": "content_start", "blockType": "text|tool_use", "toolName": "..." }
{ "type": "content_delta", "text": "..." }
{ "type": "tool_use_complete", "toolName": "...", "toolUseId": "...", "input": {} }
{ "type": "tool_result", "toolUseId": "...", "content": {}, "isError": false }
{ "type": "permission_request", "requestId": "...", "toolName": "...", "input": {} }
{ "type": "message_complete", "usage": { "input_tokens": 0, "output_tokens": 0 } }
{ "type": "status", "state": "idle|thinking|streaming|permission_pending" }
{ "type": "error", "message": "...", "code": "..." }
{ "type": "session_title_updated", "sessionId": "...", "title": "..." }
{ "type": "pong" }
```

---

## 8. 安全模型

### 8.1 安全层级

```
┌─────────────────────────────────────────────────────────────┐
│ 第1层: 网络隔离                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ · 容器运行在独立 Docker 网络                               │ │
│ │ · 仅出站 HTTPS(443) + 内部 SDK WS                        │ │
│ │ · 容器间禁止通信 (--icc=false)                            │ │
│ │ · 无宿主机文件系统访问 (Volume 非 bind mount)              │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                              │
│ 第2层: 容器沙箱                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ · --no-new-privileges                                    │ │
│ │ · 只读 rootfs (可写 /tmp, /workspace)                    │ │
│ │ · 非 root 用户 (UID 1000)                                │ │
│ │ · CPU/内存/PID 资源限制                                   │ │
│ │ · --security-opt no-new-privileges                       │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                              │
│ 第3层: 应用层隔离                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ · JWT 验证 (RS256) — 签名不可伪造                         │ │
│ │ · 所有 DB 查询带 tenant_id                               │ │
│ │ · PostgreSQL RLS 纵深防御                                 │ │
│ │ · API Key AES-256-GCM 加密存储                            │ │
│ │ · 限流 (per-tenant sliding window)                       │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                              │
│ 第4层: 审计与可观测性                                         │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ · 审计日志 (不含消息内容/API Key)                         │ │
│ │ · Prometheus metrics                                    │ │
│ │ · 健康检查端点                                            │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 API Key 安全

```
用户提交 BYOK Key          Gateway 存储              容器创建时
──────────────          ────────────            ────────────
    │                       │                       │
    │ 1. 明文 sk-ant-...    │                       │
    │──────────────────────►│                       │
    │                       │ 2. AES-256-GCM 加密    │
    │                       │    密钥: platform key  │
    │                       │ 3. 存入 DB (密文)      │
    │                       │──────────────────────►│
    │                       │                       │
    │                       │                       │  4. 读取密文
    │                       │                       │◄───│
    │                       │  5. 解密               │   │
    │                       │◄──────────────────────│   │
    │                       │                       │   │
    │                       │  6. 注入容器环境变量     │   │
    │                       │  ANTHROPIC_AUTH_TOKEN  │   │
    │                       │──────────────────────►│   │
    │                       │                       │   │
    │                       │                       │  7. Agent 在内存中
    │                       │                       │     使用明文 key
    │                       │                       │     调用 LLM API
```

**保证**: 明文 key 永远不出现在 DB、日志、API 响应中。

---

## 9. 服务改造映射

### 9.1 现有代码 → SaaS 适配

| 现有模块 | 文件路径 | 改造内容 |
|---------|---------|---------|
| Auth 中间件 | `src/server/middleware/auth.ts` | API Key 验证 → JWT RS256 验证 |
| SessionService | `src/server/services/sessionService.ts` | 文件操作 → PostgreSQL 查询，所有方法加 `tenantId` |
| ProviderService | `src/server/services/providerService.ts` | 文件操作 → `provider_configs` 表，authToken 加解密 |
| SettingsService | `src/server/services/settingsService.ts` | 文件操作 → `tenants.settings` JSONB 查询 |
| ConversationService | `src/server/services/conversationService.ts` | `Bun.spawn()` → 委托 Orchestrator；`buildChildEnv()` 移至 Orchestrator |
| TeamService | `src/server/services/teamService.ts` | 文件操作 → `teams`/`team_members` 表 |
| WS Handler | `src/server/ws/handler.ts` | 加入 tenant context；消息路由变为 proxy |
| Router | `src/server/router.ts` | 新增 `api/auth` 路由 |
| Server Entry | `src/server/index.ts` | SaaS 模式下初始化 DB 连接 + 迁移 |

### 9.2 Local 模式兼容

当 `CC_MODE=local` 时：
- Auth 中间件注入静态 `RequestContext { tenantId: 'local', userId: 'local', role: 'owner' }`
- 所有 service 走现有文件路径，不加载 DB 模块
- `Bun.spawn()` 在宿主机启动 CLI 子进程
- 不需要 Docker、PostgreSQL、Orchestrator

---

## 10. 部署拓扑

### 10.1 最小生产拓扑

```
                    ┌──────────────────────┐
                    │   负载均衡器           │
                    │   nginx / caddy       │
                    │   · HTTPS 终结         │
                    │   · WSS 代理           │
                    │   · 会话粘滞 (sessionId)│
                    └──────────┬───────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                  │
       ┌────▼─────┐     ┌────▼─────┐     ┌────▼─────┐
       │ Gateway 1 │     │ Gateway 2 │     │ Gateway N │
       │  :3456    │     │  :3456    │     │  :3456    │
       └────┬──────┘     └────┬──────┘     └────┬──────┘
            │                  │                  │
            └──────────────────┼──────────────────┘
                               │ 内部网络
                    ┌──────────▼───────────┐
                    │    Orchestrator       │
                    │    :3457              │
                    │    · 容器生命周期      │
                    │    · Volume 管理      │
                    └──────────┬───────────┘
                               │ Docker API
            ┌──────────────────┼──────────────────┐
            │                  │                  │
       ┌────▼─────┐     ┌────▼─────┐     ┌────▼─────┐
       │ Agent C1 │     │ Agent C2 │     │ Agent CN │
       │ CLI+SDK  │     │ CLI+SDK  │     │ CLI+SDK  │
       └────┬─────┘     └────┬─────┘     └────┬─────┘
            │                  │                  │
            └──────────────────┼──────────────────┘
                               │ HTTPS
                    ┌──────────▼───────────┐
                    │     PostgreSQL        │
                    │     · 主库             │
                    │     · 只读副本 (可选)   │
                    └──────────────────────┘
```

### 10.2 E2E 测试拓扑 (本地 Docker Desktop)

```
┌───────────────────────────────────────────────────────────────────┐
│  Docker Network: cc-haha-e2e                                      │
│                                                                    │
│  ┌──────────┐    ┌────────────┐    ┌──────────────┐    ┌───────┐ │
│  │ postgres │◄───│  gateway   │───►│orchestrator  │    │  web  │ │
│  │  :5432   │    │  :3456     │    │  :3457       │    │ :2024 │ │
│  │          │    │            │    │              │    │  SPA  │ │
│  │          │    │ /api/*     │    │ /internal/*  │    │       │ │
│  │          │    │ /ws/*      │    │ Docker.sock  │    │       │ │
│  │          │    │ /sdk/*     │    │              │    │       │ │
│  └──────────┘    └────────────┘    └──────┬───────┘    └───────┘ │
│                                            │                      │
│                              ┌─────────────▼─────────────┐       │
│                              │  Agent Container (动态)    │       │
│                              │  按 session 创建           │       │
│                              │  cc-haha-agent:latest     │       │
│                              └──────────────────────────┘       │
└───────────────────────────────────────────────────────────────────┘
```

---

## 11. 分阶段实施路线

```
Phase 1          Phase 2          Phase 3          Phase 4          Phase 5          Phase 6
提取 DB 层        建设 Gateway 鉴权  建设 Orchestrator  租户隔离加固     Web SPA 改造     规模化
─────────       ──────────       ──────────       ──────────       ──────────       ──────────

│ PostgreSQL     │ JWT 鉴权       │ 容器生命周期    │ RLS            │ 移除 Tauri     │ 水平扩展
│ 迁移运行器      │ /api/auth/*   │ Agent 镜像     │ 限流中间件      │ Web SPA 构建   │ 读写分离
│ 查询助手       │ Auth 中间件    │ Conversation  │ 审计日志        │ IM 适配器更新  │ Prometheus
│ CC_MODE 变量   │ 登录/注册页    │   Service 改造 │ 容器安全加固    │ 移除本地特有功能│ 管理后台
│ 无界面变更      │ 仍单进程部署   │ Volume 管理    │ API Key 加密    │                │ Stripe 计费
│                │                │                │ 渗透测试        │                │
▼                ▼                ▼                ▼                ▼                ▼
可独立验证       可独立验证        可独立验证        可独立验证        可独立验证        可独立验证
```

---

## 12. 错误码参考

| 错误码 | HTTP | 含义 |
|-------|------|------|
| `UNAUTHORIZED` | 401 | JWT 无效或过期 |
| `FORBIDDEN` | 403 | 用户角色权限不足 |
| `TENANT_QUOTA_EXCEEDED` | 429 | 限流或配额超限 |
| `CONTAINER_START_FAILED` | 503 | Orchestrator 无法创建容器 |
| `CONTAINER_CRASH` | 500 | Agent 容器崩溃 |
| `SESSION_NOT_FOUND` | 404 | 会话不存在或跨租户访问 |
| `PROVIDER_CONFIG_INVALID` | 400 | BYOK Key 无效或缺失 |

错误响应格式:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description",
  "retryable": false,
  "details": {}
}
```
