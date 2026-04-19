# WebSocket 通信架构

> Desktop UI、Server 与 CLI 子进程之间的双通道 WebSocket 通信详解。

---

## 1. 整体架构

### 1.1 三进程拓扑

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Desktop UI (浏览器/Tauri)                          │
│                                                                             │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────┐                   │
│  │ Chat View   │    │ Settings     │    │ Permission    │                   │
│  │ (React)     │    │ Panel        │    │ Dialog        │                   │
│  └──────┬──────┘    └──────┬───────┘    └───────┬───────┘                   │
│         │                  │                     │                           │
│         └──────────────────┼─────────────────────┘                           │
│                            │                                                 │
│                     chatStore (Zustand)                                       │
│                            │                                                 │
│                     wsManager (WebSocketManager)                              │
│                            │                                                 │
└────────────────────────────┼─────────────────────────────────────────────────┘
                             │
                  Client WebSocket (/ws/{sessionId})
                  JSON over WS
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Server 进程 (单例, Bun.serve)                           │
│                     src/server/index.ts                                     │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  WebSocket 路由                                                     │    │
│  │  /ws/{sessionId}        → channel='client'  (Desktop UI 连接)       │    │
│  │  /sdk/{sessionId}?token → channel='sdk'     (CLI 子进程连接)        │    │
│  └───────────┬──────────────────────────────┬──────────────────────────┘    │
│              │                              │                                │
│  ┌───────────▼──────────┐     ┌─────────────▼────────────┐                  │
│  │  WS Handler          │     │  WS Handler              │                  │
│  │  (client channel)    │     │  (sdk channel)           │                  │
│  │  ws/handler.ts       │     │  ws/handler.ts           │                  │
│  └───────────┬──────────┘     └─────────────┬────────────┘                  │
│              │                              │                                │
│              └──────────┬───────────────────┘                                │
│                         │                                                    │
│  ┌──────────────────────▼──────────────────────────────────────────────┐    │
│  │                    ConversationService                              │    │
│  │                    services/conversationService.ts                  │    │
│  │                                                                     │    │
│  │  sessions: Map<sessionId, SessionProcess>                          │    │
│  │  每个 session 对应一个 CLI 子进程实例                                │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
              │                                         ▲
              │ Bun.spawn()                             │ SDK WebSocket
              │ (OS 子进程)                              │ (/sdk/{sessionId}?token)
              ▼                                         │
┌─────────────────────────────────────────────────────────────────────────────┐
│              CLI 子进程 (每 session 一个, 动态创建/销毁)                     │
│              claude-haha --print --sdk-url ws://...                          │
│                                                                             │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────────────────┐         │
│  │ stdin (pipe)   │  │ SDK WS Client   │  │ Agent Runtime       │         │
│  │                │  │                 │  │                     │         │
│  │ 接收 stream-   │  │ WebSocket-      │  │ Claude LLM API      │         │
│  │ json 格式的    │  │ Transport       │  │ Tool Execution      │         │
│  │ 下行消息       │  │ (反向连接Server)│  │ (Bash/Read/Write/..)│         │
│  └────────────────┘  └─────────────────┘  └──────────────────────┘         │
│                                                                             │
│  stdout: ignore (不走 TUI)                                                  │
│  stderr: pipe (日志采集)                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 关联关系

| 维度 | 说明 |
|------|------|
| **进程关系** | Server 是父进程，CLI 是 `Bun.spawn` 的子进程；每个 session 1:1 对应一个 CLI 子进程 |
| **通信通道 1** | Client WS (`/ws/{id}`) — Desktop UI ↔ Server 双向通信 |
| **通信通道 2** | SDK WS (`/sdk/{id}?token`) — CLI ↔ Server 双向通信；CLI 主动反向连接 |
| **消息缓冲** | CLI 未连上时，下行消息暂存 `pendingOutbound`，连接后 flush |
| **输出转发** | CLI → SDK WS → `handleSdkPayload` → `outputCallbacks` → `translateCliMsg` → Client WS → UI |
| **断线回收** | Client WS 断开 30s 后自动 `stopSession()` 杀 CLI 子进程 |
| **认证** | SDK WS: URL token 校验；Client WS: JWT（非 localhost 时） |

### 1.3 涉及的关键代码文件

| 模块 | 文件路径 | 职责 |
|------|---------|------|
| Server 入口 | `src/server/index.ts` | Bun.serve 启动、WS 路由分发 |
| WS Handler | `src/server/ws/handler.ts` | Client/SDK channel 消息处理、消息翻译 |
| WS 事件类型 | `src/server/ws/events.ts` | ClientMessage / ServerMessage 类型定义 |
| ConversationService | `src/server/services/conversationService.ts` | CLI 子进程生命周期管理 |
| Desktop WS 客户端 | `desktop/src/api/websocket.ts` | WebSocketManager 封装 |
| Desktop 状态管理 | `desktop/src/stores/chatStore.ts` | Zustand store、消息处理、流式渲染 |
| Desktop 类型定义 | `desktop/src/types/chat.ts` | ClientMessage / ServerMessage / UIMessage 类型 |
| CLI RemoteIO | `src/cli/remoteIO.ts` | SDK 模式下的双向通信层 |
| CLI Transport | `src/cli/transports/WebSocketTransport.ts` | WebSocket 传输层实现 |
| CLI Transport 选择 | `src/cli/transports/transportUtils.ts` | 根据协议和配置选择 Transport |
| CLI 入口 | `src/cli/print.ts` | `--print` 模式入口，解析 `--sdk-url` |

---

## 2. SDK WebSocket 通信 (Server ↔ CLI)

### 2.1 连接建立流程

```
Server 端                                          CLI 子进程端

conversationService.startSession()
  │
  ├─ 构造 sdkUrl:
  │  ws://127.0.0.1:3456/sdk/{sessionId}?token={uuid}
  │
  ├─ Bun.spawn([
  │    'claude-haha',
  │    '--print',
  │    '--sdk-url', sdkUrl,      ◄── 关键: URL 传给子进程
  │    '--input-format', 'stream-json',
  │    '--output-format', 'stream-json',
  │    ...
  │  ])
  │                                                    │
  │                                                    ▼
  │                                              CLI 入口解析 --sdk-url 参数
  │                                              (src/cli/print.ts:481)
  │                                                    │
  │                                                    ▼
  │                                              getStructuredIO(inputPrompt, { sdkUrl })
  │                                              (src/cli/print.ts:5230)
  │                                                    │
  │                                                    ▼
  │                                              new RemoteIO(sdkUrl, inputStream)
  │                                              (src/cli/remoteIO.ts:44)
  │                                                    │
  │                                                    ▼
  │                                              getTransportForUrl(url, headers, sessionId)
  │                                              (src/cli/transports/transportUtils.ts:16)
  │                                                    │
  │                                       ┌────────────┴────────────┐
  │                                       │  ws:/wss: 协议判断       │
  │                                       │  默认: WebSocketTransport│
  │                                       │  CCR_V2: SSETransport   │
  │                                       │  POST_V2: HybridTransport│
  │                                       └────────────┬────────────┘
  │                                                    │
  │                                                    ▼
  │                                              new WebSocketTransport(url, headers, sessionId)
  │                                              (src/cli/transports/WebSocketTransport.ts:119)
  │                                                    │
  │                                                    ▼
  │                                              transport.connect()
  │                                              (remoteIO.ts:172)
  │                                                    │
  │                                                    ▼
  │                                              new WebSocket(url.href, { headers })
  │                                              (WebSocketTransport.ts:162)
  │                                                    │
  │              ┌─────────────────────────────────────┘
  │              │  WebSocket 握手
  │              ▼
  │   Server index.ts: /sdk/ 路由命中
  │   server.upgrade(req, {
  │     data: {
  │       channel: 'sdk',
  │       sdkToken: url.searchParams.get('token')
  │     }
  │   })
  │              │
  │              ▼
  │   ws/handler.ts: open()
  │   ├─ authorizeSdkConnection(sessionId, sdkToken)
  │   │  (比对 token 是否匹配)
  │   └─ attachSdkConnection(sessionId, ws)
  │     ├─ session.sdkSocket = ws  ◄── 绑定!
  │     └─ flush pendingOutbound   ◄── 发送暂存消息
```

### 2.2 下行消息 (Server → CLI)

```
conversationService.sendSdkMessage(sid, payload)
  │
  ├─ session = sessions.get(sid)
  ├─ line = JSON.stringify(payload) + '\n'
  │
  ├─ session.sdkSocket 存在?
  │   ├─ YES → session.sdkSocket.send(line)  ────►  CLI WebSocketTransport.onMessage
  │   │                                                  │
  │   │                                                  ▼
  │   │                                           transport.setOnData callback
  │   │                                           (remoteIO.ts:98)
  │   │                                                  │
  │   │                                                  ▼
  │   │                                           this.inputStream.write(data)
  │   │                                                  │
  │   │                                                  ▼
  │   │                                           StructuredIO 解析 stream-json
  │   │                                           按 \n 分行 → JSON.parse
  │   │                                           路由到 agent 逻辑
  │   │
  │   └─ NO  → session.pendingOutbound.push(line)
  │            (等 SDK WS 连上后 flush)
```

| 方法 | 消息类型 | 用途 |
|------|---------|------|
| `sendMessage()` | `type: 'user'` | 推送用户消息（含 attachments） |
| `respondToPermission()` | `type: 'control_response'` | 回应权限请求 (allow/deny) |
| `setPermissionMode()` | `type: 'control_request'` | 切换权限模式 |
| `sendInterrupt()` | `type: 'control_request'` | 中断当前执行 |

消息格式示例：

```jsonl
// ① 用户消息
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"帮我生成SQL"}]},"parent_tool_use_id":null,"session_id":""}

// ② 权限响应 (allow)
{"type":"control_response","response":{"subtype":"success","request_id":"req-1","response":{"behavior":"allow"}}}

// ③ 权限响应 (deny)
{"type":"control_response","response":{"subtype":"success","request_id":"req-1","response":{"behavior":"deny","message":"User denied via UI"}}}

// ④ 切换权限模式
{"type":"control_request","request_id":"uuid","request":{"subtype":"set_permission_mode","mode":"default"}}

// ⑤ 中断执行
{"type":"control_request","request_id":"uuid","request":{"subtype":"interrupt"}}
```

### 2.3 上行消息 (CLI → Server)

```
RemoteIO.write(message)  (remoteIO.ts:231)
  │
  ├─ this.transport.write(message)
  │    │
  │    │  WebSocketTransport.write(message)  (WebSocketTransport.ts:660)
  │    │    ├─ message 有 uuid → messageBuffer.add(message)  // 缓冲用于重连重放
  │    │    ├─ line = JSON.stringify(message) + '\n'
  │    │    └─ this.sendLine(line)
  │    │         └─ this.ws.send(line)  ──────────►  WS handler.message()
  │    │                                               │
  │    │                                        channel === 'sdk'
  │    │                                        conversationService.handleSdkPayload(sid, raw)
  │    │                                               │
  │    │                                          ├─ 按 \n 分行，JSON.parse
  │    │                                          ├─ 拦截 control_request + can_use_tool
  │    │                                          │  → pendingPermissionRequests.set()
  │    │                                          └─ 遍历 outputCallbacks
  │    │                                             └─ translateCliMessage(msg, sid)
  │    │                                                  → ServerMessage[]
  │    │                                                  → client WS.send() → Desktop UI
```

| CLI 消息类型 | 翻译后的 ServerMessage | 说明 |
|-------------|----------------------|------|
| `system` (subtype:`init`) | `system_notification` | CLI 初始化完成，携带 model 和 slash_commands |
| `assistant` | `content_start` / `content_delta` / `tool_use_complete` | AI 完整回复（非流式场景的兜底） |
| `stream_event` | `status` / `content_start` / `content_delta` / `tool_use_complete` / `thinking` | 流式增量事件 |
| `control_request` (subtype:`can_use_tool`) | `permission_request` | 工具权限请求 |
| `user` (tool_result) | `tool_result` | 工具执行结果回传 |
| `result` | `error` (is_error) + `message_complete` | 对话轮次结束 |
| `system` (task_notification) | `system_notification` | Task 事件通知 |

### 2.4 连接生命周期

```
 Server 进程                                    CLI 子进程
                                               │
 ┌──────────────────────────────────────────────────────────────────┐
 │                     阶段1: WebSocket 握手                        │
 │                    ◄──── HTTP GET /sdk/{sid}?token=xxx ──────── │
 │  server.upgrade(req, { data: { channel:'sdk', sdkToken }})      │
 │                    ────── 101 Switching Protocols ──────────►    │
 └──────────────────────────────────────────────────────────────────┘
                                               │
 ┌──────────────────────────────────────────────────────────────────┐
 │                     阶段2: 认证 & 绑定                           │
 │  authorizeSdkConnection(sid, sdkToken)  // token 比对           │
 │  attachSdkConnection(sid, ws)                                    │
 │    ├─ session.sdkSocket = ws           ◄── 绑定 socket 引用     │
 │    └─ flush pendingOutbound           ◄── 发送暂存消息          │
 └──────────────────────────────────────────────────────────────────┘
                                               │
 ┌──────────────────────────────────────────────────────────────────┐
 │                     阶段3: 稳定通信                              │
 │  ┌─ 心跳保活 ──────────────────────────────────────────────┐     │
 │  │  ping/pong frame (每10s)                                │     │
 │  │  {"type":"keep_alive"}\n  (每5min 数据帧)               │     │
 │  └─────────────────────────────────────────────────────────┘     │
 └──────────────────────────────────────────────────────────────────┘
                                               │
 ┌──────────────────────────────────────────────────────────────────┐
 │                     阶段4: 断开 & 重连                           │
 │  正常断开:                                                       │
 │    detachSdkConnection(sid) → session.sdkSocket = null          │
 │                                                                  │
 │  异常断开 (CLI 自动重连):                                        │
 │    指数退避: 1s → 2s → 4s ... ≤30s (±25% jitter)               │
 │    总预算: 10分钟                                                 │
 │    休眠检测: 60s+ tick gap → 重置重连预算                        │
 │    重连成功 → replayBufferedMessages() (按 UUID 增量重放)       │
 │                                                                  │
 │  永久关闭码 (不再重连):                                          │
 │    1002 (协议错误) / 4001 (session expired) / 4003 (unauthorized)│
 └──────────────────────────────────────────────────────────────────┘
```

---

## 3. Client WebSocket 通信 (Desktop UI ↔ Server)

### 3.1 连接建立流程

```
Desktop UI                                          Server

chatStore.connectToSession(sessionId)
  │
  ├─ 创建 PerSessionState
  │  { connectionState:'connecting', messages:[], ... }
  │
  ├─ wsManager.connect(sessionId)
  │    │
  │    │  new WebSocket(wsUrl + '/ws/' + sid)
  │    │               ──── HTTP GET /ws/{sid} ──────►
  │    │                                            server.upgrade(req, {
  │    │                                              data: { channel:'client', ... }
  │    │                                            })
  │    │               ◄─── 101 Switching Protocols │
  │    │
  │    └─ conn = { ws, handlers, reconnectTimer, ... }
  │
  ├─ wsManager.onMessage(sid, handler)
  │    └─ if (msg.type === 'connected')
  │         → connectionState = 'connected'
  │       handleServerMessage(sid, msg)
  │
  ├─ loadHistory(sid)
  │    └─ GET /api/sessions/{sid}/messages → mapHistoryMessagesToUiMessages()
  │
  └─ getSlashCommands(sid)
       └─ GET /api/sessions/{sid}/slash-commands
```

### 3.2 上行消息 (Desktop UI → Server)

| API | 消息类型 | 触发场景 |
|-----|---------|---------|
| `wsManager.send(sid, {type:'user_message',...})` | `user_message` | 用户发送消息 |
| `wsManager.send(sid, {type:'permission_response',...})` | `permission_response` | 用户允许/拒绝权限 |
| `wsManager.send(sid, {type:'set_permission_mode',...})` | `set_permission_mode` | 切换权限模式 |
| `wsManager.send(sid, {type:'stop_generation'})` | `stop_generation` | 用户点击停止 |
| `wsManager.send(sid, {type:'ping'})` | `ping` | 心跳 (每30s) |

消息格式：

```json
// ① 用户消息
{"type":"user_message","content":"帮我生成SQL","attachments":[{"type":"file","path":"/foo/bar.ts"}]}

// ② 权限响应
{"type":"permission_response","requestId":"req-1","allowed":true,"rule":"always"}

// ③ 切换权限模式
{"type":"set_permission_mode","mode":"bypassPermissions"}

// ④ 停止生成
{"type":"stop_generation"}

// ⑤ 心跳
{"type":"ping"}
```

### 3.3 下行消息 (Server → Desktop UI)

| ServerMessage 类型 | chatStore 处理 | UI 效果 |
|-------------------|---------------|---------|
| `connected` | `connectionState = 'connected'` | 连接就绪 |
| `status` | `chatState = msg.state`, `statusVerb = msg.verb` | 状态栏切换 (thinking/streaming/idle...) |
| `content_start` | 初始化 `streamingText` 或 `activeToolName` | 开始新的内容块 |
| `content_delta` | 累积 `pendingDelta` (50ms 节流) 或 `streamingToolInput` | 实时文字/工具输入流式渲染 |
| `thinking` | 追加或新建 thinking UIMessage | 思考过程展示 |
| `tool_use_complete` | push `tool_use` UIMessage | 工具调用卡片 |
| `tool_result` | push `tool_result` UIMessage | 工具执行结果 |
| `permission_request` | `pendingPermission = ...`, `chatState = 'permission_pending'` | 权限弹窗 |
| `message_complete` | flush 残留文本, `chatState = 'idle'` | 轮次结束 |
| `error` | push `error` UIMessage, `chatState = 'idle'` | 错误提示 |
| `session_title_updated` | 更新 sessionStore / tabStore | Tab 标题刷新 |
| `system_notification` | 更新 `slashCommands` 或 `agentTaskNotifications` | 斜杠命令/任务通知 |
| `team_update/created/deleted` | 转发 teamStore | Team 面板更新 |
| `pong` | 忽略 | — |

### 3.4 流式渲染的节流机制

Desktop UI 对 `content_delta` 的 text 增量做 **50ms 节流**，避免高频微更新导致 React 重渲染开销过大：

```
Server 连续推送:                          Desktop UI:

content_delta {text:'我'}                │
content_delta {text:'来'}                │ pendingDelta = '我来'
content_delta {text:'帮'}                │ pendingDelta = '我来帮'
content_delta {text:'你'}                │ pendingDelta = '我来帮你'
    ...                                   ... (50ms 内不渲染)
                                         │
                                         ▼ 50ms timer 到期
                                         streamingText += '我来帮你...'
                                         │
                                         ▼ React 重渲染一次
                                         UI 显示 "我来帮你..."
```

对应代码 (`chatStore.ts:386-398`)：

```typescript
case 'content_delta':
  if (msg.text !== undefined) {
    pendingDelta += msg.text          // 累积到缓冲
    if (!flushTimer) {
      flushTimer = setTimeout(() => { // 50ms 后批量 flush
        const text = pendingDelta
        pendingDelta = ''
        flushTimer = null
        update((s) => ({ streamingText: s.streamingText + text }))
      }, 50)
    }
  }
  if (msg.toolInput !== undefined)
    update((s) => ({ streamingToolInput: s.streamingToolInput + msg.toolInput }))
  break
```

> `toolInput` 增量不做节流，因为工具输入通常文本量小且需要即时展示完整 JSON 结构。

### 3.5 连接断开与重连

```
 Desktop UI (WebSocketManager)               Server

 ┌─ 主动断开 ──────────────────────────────────────────────────────────┐
 │  chatStore.disconnectSession(sid)                                    │
 │    ├─ clearInterval(elapsedTimer)                                    │
 │    ├─ flush 未写入的 pendingDelta                                    │
 │    ├─ wsManager.disconnect(sid)                                      │
 │    │    ├─ intentionalClose = true    ◄── 标记,阻止自动重连         │
 │    │    ├─ stopPingLoop()                                            │
 │    │    ├─ clearTimeout(reconnectTimer)                              │
 │    │    ├─ pendingMessages = []                                      │
 │    │    ├─ ws.close()  ───────────────────────►  close 事件          │
 │    │    └─ connections.delete(sid)                                   │
 │    └─ sessions 中移除该 session                                      │
 │                                                                      │
 │  Server端:                                                           │
 │    handleWebSocket.close(ws)                                         │
 │      ├─ activeSessions.delete(sid)                                   │
 │      ├─ cleanupStreamState(sid)                                      │
 │      └─ setTimeout(30s) → conversationService.stopSession(sid)      │
 │                             → proc.kill()  杀掉 CLI 子进程           │
 └──────────────────────────────────────────────────────────────────────┘

 ┌─ 异常断开 (桌面端自动重连) ──────────────────────────────────────────┐
 │  ws.onclose 触发                                                     │
 │    ├─ stopPingLoop()                                                 │
 │    ├─ !intentionalClose ?                                            │
 │    │   └─ scheduleReconnect()                                        │
 │    │       指数退避: 1s → 2s → 4s → 8s → 16s → 30s (上限)          │
 │    │       reconnectTimer = setTimeout(() => {                       │
 │    │         connections.delete(sid)                                 │
 │    │         connect(sid)          ◄── 重新连接                     │
 │    │         迁移 handlers 到新连接                                  │
 │    │       }, delay)                                                 │
 │                                                                      │
 │  Server端:                                                           │
 │    close 事件 → 30s cleanup timer 开始倒计时                         │
 │    如果 UI 在 30s 内重连成功:                                        │
 │      clearTimeout(cleanupTimer)    ◄── 取消杀 CLI                   │
 │      activeSessions 重新绑定新 ws                                    │
 └──────────────────────────────────────────────────────────────────────┘
```

---

## 4. 端到端消息时序

### 4.1 一次完整对话的时序图

```
Desktop UI                Server (WS Handler)         ConversationService          CLI 子进程
    │                          │                           │                         │
    │─ user_message ──────────►│                           │                         │
    │  "帮我生成SQL"            │                           │                         │
    │                          │                           │                         │
    │                          │─ startSession() ─────────►│                         │
    │                          │                           │─ Bun.spawn() ──────────►│
    │                          │                           │                         │
    │                          │                           │      ◄── SDK WS connect ─│
    │                          │                           │◄── attachSdkConnection ──│
    │                          │                           │                         │
    │                          │─ sendMessage() ──────────►│                         │
    │                          │                           │─ sendSdkMessage() ─────►│
    │                          │                           │  {type:'user',...}       │
    │                          │                           │                         │
    │◄─ status:thinking ──────│                           │                         │
    │                          │                           │                         │
    │                          │                           │◄── system(init) ────────│
    │◄─ system_notification ──│◄── outputCallback ───────│                         │
    │  {model, slash_cmds}     │                           │                         │
    │                          │                           │                         │
    │                          │                           │◄── stream_event ────────│
    │◄─ status:streaming ─────│◄── outputCallback ───────│  {message_start}         │
    │                          │                           │                         │
    │                          │                           │◄── stream_event ────────│
    │◄─ thinking ─────────────│◄── outputCallback ───────│  {thinking_delta}        │
    │  {text:'让我分析...'}    │                           │                         │
    │                          │                           │                         │
    │                          │                           │◄── stream_event ────────│
    │◄─ content_start:text ───│◄── outputCallback ───────│  {content_block_start}   │
    │  streamingText = ''      │                           │                         │
    │                          │                           │◄── stream_event ────────│
    │◄─ content_delta ────────│◄── outputCallback ───────│  {content_block_delta}
    │  {text:'我来帮你...'}    │                           │                         │
    │                          │                           │                         │
    │                          │                           │◄── stream_event ────────│
    │◄─ content_start:tool ───│◄── outputCallback ───────│  {tool_use:'Write'}      │
    │  activeToolName='Write'  │                           │                         │
    │                          │                           │◄── stream_event ────────│
    │◄─ content_delta ────────│◄── outputCallback ───────│  {toolInput:'{"file...'} │
    │  streamingToolInput+=    │                           │                         │
    │                          │                           │◄── content_block_stop ──│
    │◄─ tool_use_complete ────│◄── outputCallback ───────│  (解析完整 input JSON)   │
    │  messages.push(tool_use) │                           │                         │
    │                          │                           │                         │
    │                          │                           │◄── control_request ─────│
    │                          │                           │  {can_use_tool:'Write'}  │
    │◄─ permission_request ───│◄── outputCallback ───────│                         │
    │  弹出权限对话框           │                           │                         │
    │  chatState=perm_pending  │                           │                         │
    │                          │                           │                         │
    │── permission_response ──►│                           │                         │
    │  {allowed:true}          │─ respondToPermission() ─►│                         │
    │                          │                           │─ sendSdkMessage() ─────►│
    │                          │                           │  {control_response:      │
    │                          │                           │   behavior:'allow'}      │
    │                          │                           │                         │
    │                          │                           │◄── user ─────────────────│
    │                          │                           │  {tool_result}           │
    │◄─ tool_result ──────────│◄── outputCallback ───────│                         │
    │                          │                           │                         │
    │                          │                           │◄── result ──────────────│
    │◄─ message_complete ─────│◄── outputCallback ───────│  {usage:{...}}          │
    │  chatState = 'idle'      │                           │                         │
    │                          │                           │                         │
    │◄─ session_title_updated ─│  (异步 AI 生成标题)       │                         │
    │  title = 'SQL生成'       │                           │                         │
```

### 4.2 权限交互的详细流程

```
    CLI 子进程                    Server                        Desktop UI
       │                           │                               │
       │── control_request ───────►│                               │
       │  {                        │                               │
       │    type:'control_request',│                               │
       │    request_id:'req-1',    │                               │
       │    request: {             │                               │
       │      subtype:'can_use_tool',                              │
       │      tool_name:'Bash',    │                               │
       │      input:{command:'ls'} │                               │
       │    }                      │                               │
       │  }                        │                               │
       │                           │  handleSdkPayload()           │
       │                           │  → pendingPermissionRequests │
       │                           │    .set('req-1', {...})       │
       │                           │                               │
       │                           │  translateCliMessage()        │
       │                           │  → ServerMessage:             │
       │                           │    {type:'permission_request',│
       │                           │     requestId:'req-1',        │
       │                           │     toolName:'Bash',          │
       │                           │     input:{command:'ls'}}     │
       │                           │                               │
       │                           │── permission_request ────────►│
       │                           │                               │  UI 渲染权限弹窗
       │                           │                               │  chatState = 'permission_pending'
       │                           │                               │
       │                           │                               │  用户点击"允许"或"允许本次"
       │                           │                               │
       │                           │◄── permission_response ──────│
       │                           │  {type:'permission_response', │
       │                           │   requestId:'req-1',          │
       │                           │   allowed:true,               │
       │                           │   rule:'session'|'always'}    │
       │                           │                               │
       │                           │  respondToPermission()        │
       │                           │  → sendSdkMessage()           │
       │                           │                               │
       │◄── control_response ──────│                               │
       │  {                        │                               │
       │    type:'control_response',│                              │
       │    response: {            │                               │
       │      subtype:'success',   │                               │
       │      request_id:'req-1',  │                               │
       │      response: {          │                               │
       │        behavior:'allow',  │                               │
       │        updatedPermissions:│                               │
       │          [{type:'addRules',│                              │
       │            rules:[{toolName:'Bash'}],                    │
       │            behavior:'allow',                              │
       │            destination:'session'}]  ◄── rule='always'时 │
       │      }                    │                               │
       │    }                      │                               │
       │  }                        │                               │
       │                           │                               │
       │  CLI 执行工具...           │                               │
```

### 4.3 停止生成的流程

```
Desktop UI                    Server                         CLI 子进程
    │                           │                               │
    │── stop_generation ───────►│                               │
    │                           │                               │
    │  UI 本地:                 │  handleStopGeneration()       │
    │  chatState = 'idle'       │  sessionStopRequested.add(sid)│
    │  flush pendingDelta       │                               │
    │                           │  sendInterrupt()              │
    │                           │─ control_request ────────────►│
    │                           │  {subtype:'interrupt'}        │
    │                           │                               │
    │                           │  setTimeout(3s) ─────────┐    │
    │                           │                          │    │
    │◄─ status:idle ───────────│                          │    │
    │                           │                          │    │
    │                           │  3s 后检查是否还活着       │    │
    │                           │  ├─ 仍存活:               │    │
    │                           │  │  proc.kill() ──────────────│ 强制杀
    │                           │  │  stopSession()         │    │
    │                           │  └─ 已退出: 无操作        │    │
    │                           │                               │
    │                           │  CLI 被杀后来 result(错误)  │    │
    │                           │  但 sessionStopRequested     │    │
    │                           │  已标记 → 不显示错误弹窗     │    │
    │                           │  → 发 message_complete 而非  │    │
    │                           │    error + message_complete  │    │
```

---

## 5. 消息缓冲与重连机制

### 5.1 SDK WebSocket (CLI 侧)

```
WebSocketTransport.write(message)
  │
  ├─ message 有 uuid?
  │   └─ YES → messageBuffer.add(message)     ◄── 环形缓冲区 (容量 1000)
  │            lastSentId = message.uuid
  │
  ├─ state !== 'connected' ?
  │   └─ 跳过发送, 消息留存在 buffer 中等重连后重放
  │
  └─ sendLine(JSON.stringify(message) + '\n')

═══════════════════════════════════════════════════

重连场景:

1. 连接断开 → handleConnectionError()
2. 指数退避: 1s → 2s → 4s → 8s → 16s → 30s (上限, ±25% jitter)
3. 重新 connect() → new WebSocket(url)
4. Server open → authorizeSdkConnection → attachSdkConnection
5. CLI onOpen:
   ├─ Bun WS:   replayBufferedMessages('')                   ◄── 全量重放
   └─ Node WS:  读 upgradeReq.headers['x-last-request-id']
                replayBufferedMessages(serverLastId)          ◄── 增量重放
                从 buffer 中找到 serverLastId 之后的消息，逐条 sendLine

消息丢失防护:
- 带有 uuid 的消息存入 CircularBuffer
- 重连后按 server 确认的 last-request-id 增量重放
- Server 按 UUID 去重, 即使全量重放也不会重复处理
```

### 5.2 SDK WebSocket (Server 侧)

```
SDK WS 未连接时:
  sendSdkMessage() → session.sdkSocket === null
    → pendingOutbound.push(line)             ◄── 暂存队列

SDK WS 连上后:
  attachSdkConnection(sid, ws)
    → session.sdkSocket = ws
    → while (pendingOutbound.length)
        ws.send(pendingOutbound.shift())      ◄── flush 暂存
```

### 5.3 Client WebSocket (Desktop UI 侧)

```
wsManager.send(sid, message)
  │
  ├─ ws.readyState === OPEN
  │   └─ ws.send(JSON.stringify(message))    ◄── 直接发送
  │
  └─ ws.readyState === CONNECTING
      └─ pendingMessages.push(message)        ◄── 暂存

ws.onopen:
  → while (pendingMessages.length > 0)
      ws.send(JSON.stringify(pendingMessages.shift())) ◄── flush
```

---

## 6. 双通道对比

| 维度 | Client WebSocket | SDK WebSocket |
|------|-----------------|---------------|
| **端点** | `/ws/{sessionId}` | `/sdk/{sessionId}?token={uuid}` |
| **客户端** | Desktop UI (浏览器) | CLI 子进程 (Bun) |
| **channel** | `client` | `sdk` |
| **认证** | JWT (非 localhost 时) | URL token 比对 |
| **消息格式** | 单条 JSON | NDJSON (`JSON + '\n'`) |
| **心跳** | `ping/pong` 应用层消息 (30s) | Ping/Pong WS frame (10s) + keep_alive 数据帧 (5min) |
| **消息缓冲** | `pendingMessages[]` (连接中暂存) | `pendingOutbound[]` (未连接暂存) + `CircularBuffer` (重放缓存) |
| **重连策略** | 指数退避 ≤30s, 无限重试 | 指数退避 ≤30s, 10分钟预算, 休眠检测 |
| **断线回收** | 30s 后杀 CLI 子进程 | 被动方, 被 kill |
| **消息翻译** | 原样转发 ServerMessage | `translateCliMessage()` 翻译 CLI 协议为 UI 协议 |
| **流式节流** | 50ms (chatStore 层) | 无 (SDK WS 即时转发) |

---

## 7. UIMessage 模型

Server 推送的 `ServerMessage` 经过 `chatStore.handleServerMessage()` 转换为 `UIMessage`，供 React 组件渲染：

| UIMessage 类型 | 来源 ServerMessage | 渲染效果 |
|---------------|-------------------|---------|
| `user_text` | 用户输入 + `attachments` | 用户气泡 |
| `assistant_text` | `content_delta` 累积后 flush | AI 回复文本 |
| `thinking` | `thinking` / `thinking_delta` | 思考过程折叠区域 |
| `tool_use` | `tool_use_complete` | 工具调用卡片 |
| `tool_result` | `tool_result` | 工具执行结果 |
| `permission_request` | `permission_request` | 权限请求弹窗 |
| `error` | `error` | 错误提示 |
| `task_summary` | 本地生成 (message_complete 时) | 任务清单摘要 |

---

## 8. ChatState 状态机

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
                    ▼                                          │
 ┌─────────┐  user_message  ┌──────────┐  stream_event  ┌───────────┐
 │  idle   │───────────────►│ thinking │───────────────►│ streaming │
 └─────────┘                └──────────┘                └───────────┘
     ▲   ▲                       │                          │  │
     │   │                       │ tool_use                  │  │ content_start
     │   │                       ▼                          │  │ (tool_use)
     │   │                 ┌──────────────┐                 │  ▼
     │   │                 │tool_executing│◄────────────────┤ ┌──────────────────┐
     │   │                 └──────────────┘                 │ │permission_pending│
     │   │                       │  ↑                       │ └──────────────────┘
     │   │    tool_result        │  │ control_request        │       │
     │   │   (回到thinking)      │  │ (can_use_tool)         │       │ permission_response
     │   │                       │  │                        │       │ (allowed → tool_executing)
     │   └─── message_complete ──┘  │                        │       │ (denied → idle)
     │        (result)              │                        │       │
     │                              │── stop_generation ─────┘───────┘
     │                              │   (→ idle)
     │                              │
     └── error ─────────────────────┘
```

| ChatState | 含义 | UI 表现 |
|-----------|------|---------|
| `idle` | 空闲 | 输入框可编辑，无 spinner |
| `thinking` | AI 思考中 | Spinner + "Thinking..." / verb |
| `streaming` | 流式文本输出中 | 实时渲染文本增量 |
| `tool_executing` | 工具执行中 | 工具卡片 + 输入流式展示 |
| `permission_pending` | 等待用户授权 | 权限弹窗，输入框禁用 |
