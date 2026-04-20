# Multi-Tenant SaaS Service Design

Date: 2026-04-19
Status: Draft

## Goal

Transform cc-haha from a single-user desktop/client application into a cloud SaaS service where multiple tenants (organizations) can use the Claude Code agent through a unified web API, with each tenant's data and sessions logically isolated.

## Architecture Overview

Three process-level components:

### 1. Gateway (`src/gateway/`)

Single entry point for all client traffic (HTTP + WebSocket).

- Tenant/user JWT authentication (RS256)
- Rate limiting (per-tenant sliding window)
- Request routing to internal services
- WebSocket proxy: client WS ↔ container SDK WS
- Serves web SPA static files
- Stateless — horizontally scalable behind a load balancer

### 2. Session Orchestrator (`src/orchestrator/`)

Manages per-session Docker container lifecycle.

- Creates/stops agent containers on Gateway request
- Tracks active containers, health checks, cleanup of stale sessions
- Injects tenant provider config (API keys, base URLs) as container env vars
- Manages tenant workspace Docker volumes
- Stateful — single instance per Docker host; state recoverable from PostgreSQL + Docker API

### 3. Existing Server Services (adapted)

Current services (`sessionService`, `providerService`, `settingsService`, etc.) refactored to accept `tenantId` as a required parameter, backed by PostgreSQL instead of file-based storage.

### Data Flow

```
Web/IM Client
    | HTTPS/WSS
Gateway (auth -> extract tenantId + userId)
    | internal HTTP
Orchestrator (create/locate container)
    | Docker SDK WebSocket
Container (CLI agent subprocess)
    | HTTPS
LLM Provider API
```

### Backward Compatibility

When `CC_MODE=local`, the system runs exactly as today: single-user auth, file-based storage, `Bun.spawn()` CLI subprocesses. No PostgreSQL, no Docker, no Orchestrator required.

## Tenant & User Model

### Tenant (Organization)

- Represents an organization or workspace
- Has a plan tier (`free` / `pro` / `enterprise`) controlling quotas
- Owns provider configs (BYOK or platform-managed keys)
- Owns a default workdir template
- Settings: permission mode defaults, allowed models, rate limits

### User

- Belongs to one tenant (single-tenancy membership)
- Role within tenant: `owner`, `admin`, `member`
- Authenticates via email/password or social OAuth (Google, GitHub); SSO added later
- JWT on login contains: `{ sub: userId, tid: tenantId, role: "member" }`

### Database Schema (PostgreSQL)

```sql
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free',
  settings    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL,
  password_hash TEXT,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'member',
  auth_providers JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, email)
);

CREATE TABLE provider_configs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  base_url    TEXT,
  auth_token  TEXT,
  models      JSONB DEFAULT '[]',
  is_active   BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  title           TEXT,
  work_dir        TEXT NOT NULL,
  model           TEXT,
  permission_mode TEXT DEFAULT 'default',
  container_id    TEXT,
  status          TEXT NOT NULL DEFAULT 'idle',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE conversation_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  role              TEXT NOT NULL,
  content           JSONB NOT NULL,
  model             TEXT,
  parent_tool_use_id TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  user_id     UUID,
  action      TEXT NOT NULL,
  resource    TEXT,
  details     JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tenant_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  date            DATE NOT NULL,
  input_tokens    BIGINT DEFAULT 0,
  output_tokens   BIGINT DEFAULT 0,
  request_count   INT DEFAULT 0,
  UNIQUE(tenant_id, date)
);

CREATE TABLE teams (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  description     TEXT,
  lead_agent_id   TEXT,
  lead_session_id UUID REFERENCES sessions(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, name)
);

CREATE TABLE team_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  agent_type  TEXT,
  model       TEXT,
  color       TEXT,
  status      TEXT NOT NULL DEFAULT 'idle',
  session_id  UUID REFERENCES sessions(id),
  joined_at   TIMESTAMPTZ DEFAULT now()
);

-- Performance indexes
CREATE INDEX idx_sessions_tenant_user ON sessions(tenant_id, user_id);
CREATE INDEX idx_sessions_status ON sessions(tenant_id, status);
CREATE INDEX idx_conversation_messages_session ON conversation_messages(session_id, created_at);
CREATE INDEX idx_conversation_messages_tenant ON conversation_messages(tenant_id, created_at);
CREATE INDEX idx_audit_logs_tenant ON audit_logs(tenant_id, created_at);
CREATE INDEX idx_tenant_usage_tenant_date ON tenant_usage(tenant_id, date);
```

Key design decisions:

- `tenant_id` on every table for query scoping — no cross-tenant data leakage in shared DB
- Provider auth tokens encrypted at rest with AES-256-GCM using a platform master key
- `conversation_messages` is append-only (no updates), matching current JSONL semantics
- Row-Level Security (RLS) enabled as defense-in-depth (see Security section)

## Gateway Design

### JWT Authentication Flow

```
POST /api/auth/register   -> creates tenant + user, returns JWT pair
POST /api/auth/login      -> validates credentials, returns { accessToken, refreshToken }
POST /api/auth/refresh    -> validates refreshToken, returns new accessToken
POST /api/auth/social     -> handles OAuth callback (Google/GitHub), upserts user, returns JWT pair
```

Token structure:
```json
{
  "sub": "userId",
  "tid": "tenantId",
  "role": "member",
  "type": "access",
  "exp": 1745000000,
  "iat": 1745000000
}
```

- Access tokens: 15 minute lifetime
- Refresh tokens: 7 day lifetime
- RS256 signatures — private key on Gateway, public key shared with Orchestrator

### Middleware Chain

1. `corsMiddleware` — allowed-origins per tenant
2. `authMiddleware` — extract JWT, verify signature, inject `tenantId` + `userId` + `role` into request context
3. `rateLimitMiddleware` — per-tenant sliding window (configurable by plan tier)
4. `tenantMiddleware` — load tenant settings into request context (plan, active provider, permission defaults)

### WebSocket Upgrade

- Client connects to `wss://gateway/ws/:sessionId?token=<jwt>`
- Gateway verifies JWT, checks `sessionId` belongs to the same `tenantId`
- Gateway locates container via Orchestrator and proxies WebSocket bidirectionally
- SDK tokens (container → Gateway) are one-time random UUIDs, same as current design

### API Surface

Same paths as current server, tenant-scoped:

```
# Auth (new)
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/refresh
POST   /api/auth/social

# Sessions (existing, tenant-scoped)
GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/:id/messages
DELETE /api/sessions/:id
PATCH  /api/sessions/:id

# Providers (existing, tenant-scoped)
GET    /api/providers
POST   /api/providers
PUT    /api/providers/:id
DELETE /api/providers/:id

# Settings, Teams, Skills, etc. (existing, tenant-scoped)
GET    /api/settings
PATCH  /api/settings
GET    /api/teams
...

# WebSocket
WS     /ws/:sessionId
```

### Internal Communication with Orchestrator

Gateway calls Orchestrator via internal HTTP on a private network:

- `POST /internal/sessions/:id/start` — create/locate container
- `POST /internal/sessions/:id/stop` — destroy container
- `GET  /internal/sessions/:id/status` — check container health

## Session Orchestrator & Container Sandbox

### Container Image

- Lightweight image built from the existing CLI binary (`claude-haha`)
- Base: `ubuntu:24.04-minimal` or `distroless`
- Contains: CLI binary, Bun runtime, minimal OS tools (git, bash)
- Pre-built and stored in a container registry; Orchestrator pulls on first use

### Per-Session Container Creation

Orchestrator receives: `{ sessionId, tenantId, userId, workDir, providerConfig, runtimeSettings }`

1. Create Docker container with:
   - **Env vars** (same as current `buildChildEnv()`, minus OAuth token):
     - `ANTHROPIC_BASE_URL` = providerConfig.baseUrl
     - `ANTHROPIC_AUTH_TOKEN` = providerConfig.authToken (decrypted)
     - `ANTHROPIC_MODEL` = runtimeSettings.model
     - `CALLER_DIR` = /workspace
     - `PWD` = /workspace
     - `HOME` = /home/agent
     - `CC_HAHA_SKIP_DOTENV` = 1
     - `CLAUDE_CODE_ENABLE_TASKS` = 1
   - **Volume mounts**:
     - tenant workspace volume → /workspace
     - tenant home volume → /home/agent/.claude
   - **Network**: internal Docker network (can reach Gateway SDK endpoint + LLM provider APIs; cannot reach other containers or host)
   - **CLI args**: `--print --verbose --sdk-url ws://gateway:3456/sdk/{sessionId}?token={sdkToken} --session-id {sessionId} --input-format stream-json --output-format stream-json`
   - **Resource limits**: CPU shares, memory cap (per plan tier), no --privileged
   - **Security**: `--no-new-privileges`, read-only rootfs (writable /tmp, /workspace), non-root user (UID 1000)
   - **Auto-remove** on exit

2. Start container, wait for SDK WebSocket connection from CLI

3. Return container info to Gateway: `{ containerId, status: 'active' }`

### Volume Mounts & Memory Persistence

Each tenant gets **two** Docker named volumes per container:

**1. Workspace volume**: `tenant-{tenantId}-workspace`
- Mounted at `/workspace` in every container for that tenant
- Contains project files, project-level `CLAUDE.md`, `.claude/memory/`
- Persistent across sessions — user can resume conversations and see their files
- Enterprise option: mount external storage (S3, NFS) instead

**2. Home volume**: `tenant-{tenantId}-home`
- Mounted at `/home/agent/.claude` in every container for that tenant
- Contains global user memory that persists across sessions:
  - `~/.claude/CLAUDE.md` — global user instructions
  - `~/.claude/memory/` — cross-session memory/preference files
- Container env: `HOME=/home/agent`
- This ensures that every time a container starts for the tenant, the CLI's `~/.claude/` reads from the persistent home volume

**Resume mechanism**: When a user resumes an existing session:
1. Orchestrator queries `conversation_messages` from PostgreSQL for the session
2. Converts to JSONL format matching the CLI's transcript schema
3. Writes the transcript into the home volume at `/home/agent/.claude/projects/{sanitized_path}/{sessionId}.jsonl`
4. Starts the container with `--resume {sessionId}`
5. CLI reads the transcript file and reconstructs conversation context

This means: **transcripts are authored by PostgreSQL → exported to volume → read by CLI**. PostgreSQL is the source of truth; the JSONL file in the home volume is a cache for the CLI to consume.

```
┌─ tenant-acme-workspace volume ──────────────┐
│  /workspace/                                 │
│  ├── CLAUDE.md          ← project-level ✅   │
│  ├── .claude/memory/    ← project-level ✅   │
│  └── (project files)                         │
└──────────────────────────────────────────────┘

┌─ tenant-acme-home volume ───────────────────┐
│  /home/agent/.claude/                        │
│  ├── CLAUDE.md          ← global user ✅     │
│  ├── memory/            ← global memory ✅   │
│  │   └── preferences.md                      │
│  └── projects/{path}/                        │
│      └── {sessionId}.jsonl ← resume cache ✅ │
└──────────────────────────────────────────────┘
```

### Container Lifecycle

```
State machine:
  [none] -> creating -> active -> idle -> destroying -> [none]
                         ^        |
                         |________| (user reconnects within 30s)

Events:
  - onFirstMessage:  create container -> active
  - onDisconnect:    start 30s idle timer
  - onReconnect:     cancel idle timer -> active
  - onIdleTimeout:   graceful stop (SIGTERM -> 3s -> SIGKILL) -> destroying -> remove
  - onUserStop:      immediate stop -> destroying -> remove
  - onContainerExit: cleanup container record -> [none]
```

**Container scope**: One container per session. Multiple sessions from the same user each get their own container. The concurrency limit (per plan tier) caps how many containers a user can have simultaneously.

**Destruction triggers** (4 cases):

1. **User主动停止**: User clicks stop or calls `DELETE /api/sessions/:id`. Gateway → Orchestrator → `docker stop --time 3` → SIGTERM (3s) → SIGKILL. Container has `--rm` so auto-removed on exit. Session data (messages, title) remains in PostgreSQL; only the compute container is destroyed.

2. **断连闲置超时**: WebSocket disconnect detected → 30s idle timer starts. If user reconnects within 30s → timer cancelled. If timer fires → same stop flow as case 1. Idle timeout is configurable by plan (Free: 30s, Pro: 5min, Enterprise: configurable).

3. **容器崩溃**: Docker daemon notifies Orchestrator of container exit. Orchestrator cleans up: `sessions.container_id = NULL, sessions.status = 'idle'`. Gateway pushes error to client. On next user message, new container created with `--resume sessionId`.

4. **定期清扫 (兜底)**: Every 60s, Orchestrator queries `sessions WHERE status = 'active'`, cross-references with Docker API. Stale entries (DB says active but container gone) are cleaned up. Orphaned containers (running but no active WebSocket for N minutes) are force-stopped.

**Resource cleanup on destruction**:

| Resource | Released? | Notes |
|----------|-----------|-------|
| Container process | Yes | `docker stop` + `--rm` |
| Container network | Yes | Auto-cleaned with container |
| Container filesystem | Yes | Auto-cleaned with container (read-only rootfs) |
| `/workspace` data | No | Docker named volume — persists |
| `/home/agent/.claude` data | No | Docker named volume — persists (memory, CLAUDE.md) |
| Session DB records | No | PostgreSQL data untouched |
| Memory/CPU | Yes | Returned to Docker host |

**Concurrent session limit enforcement**: When a tenant hits their plan's max concurrent sessions, new session creation returns `429 TENANT_QUOTA_EXCEEDED`. User must manually close an existing session first.

### Concurrency Limits (per plan tier)

| Plan       | Max concurrent sessions | CPU per container | Memory per container |
|------------|------------------------|-------------------|---------------------|
| Free       | 1                      | 0.5 CPU           | 512 MB              |
| Pro        | 5                      | 1 CPU             | 2 GB                |
| Enterprise | Unlimited              | 2 CPU             | 4 GB                |

## Service Adaptation — Existing Code Changes

### Auth middleware (`src/server/middleware/auth.ts`)

Current: single API key check against `process.env.ANTHROPIC_API_KEY`.

New: JWT verification with RS256. Returns typed request context:

```typescript
type RequestContext = {
  tenantId: string
  userId: string
  role: 'owner' | 'admin' | 'member'
}

function requireAuth(req: Request): { context: RequestContext } | Response
```

### ConversationService (`src/server/services/conversationService.ts`)

- Remove `Bun.spawn()` logic — delegated to Orchestrator
- `startSession(sessionId, tenantId, ...)` calls `POST /internal/sessions/:id/start`
- `stopSession(sessionId)` calls `POST /internal/sessions/:id/stop`
- `sendMessage()` and `respondToPermission()` route through Gateway's proxied WebSocket
- `buildChildEnv()` removed — env construction moves to Orchestrator
- Gateway proxies SDK WebSocket messages bidirectionally

### SessionService (`src/server/services/sessionService.ts`)

- All methods gain `tenantId` parameter
- File operations replaced with PostgreSQL queries:
  - `listSessions(tenantId, userId)` → `SELECT * FROM sessions WHERE tenant_id = $1 AND user_id = $2`
  - `createSession(tenantId, userId, workDir)` → `INSERT INTO sessions ...`
  - `getSession(sessionId, tenantId)` → `SELECT * FROM sessions WHERE id = $1 AND tenant_id = $2`
- Session transcript files replaced with `conversation_messages` table

### ProviderService (`src/server/services/providerService.ts`)

- All methods gain `tenantId` parameter
- File reads replaced with `provider_configs` table queries
- `authToken` values decrypted on read using platform encryption key
- `activateProvider(tenantId, providerId)` sets all others to inactive for that tenant

### SettingsService (`src/server/services/settingsService.ts`)

- Replaced with `tenants.settings` JSONB column queries
- `getUserSettings(tenantId)` → `SELECT settings FROM tenants WHERE id = $1`
- `setPermissionMode(tenantId, mode)` → `UPDATE tenants SET settings = jsonb_set(settings, '{permissionMode}', $3) WHERE id = $1`

### TeamService (`src/server/services/teamService.ts`)

- All methods gain `tenantId` parameter
- Team configs moved to `teams` table
- Team members tracked in `team_members` table
- Transcript queries use `conversation_messages` table

### WebSocket handler (`src/server/ws/handler.ts`)

- Handler gains tenant context from upgrade request JWT
- `handleUserMessage` delegates session start to Orchestrator via Gateway
- Message routing becomes proxy: client WS ↔ Gateway ↔ container SDK WS
- `translateCliMessage()` logic stays unchanged — runs on Gateway side

### hahaOAuthService (`src/server/services/hahaOAuthService.ts`)

- Not used in SaaS mode — tenants use BYOK or platform-managed keys
- Kept for backward compatibility in local mode
- Platform-managed keys stored in `provider_configs` with special `tenant_id = 'platform'`

### Compatibility Shim

When `CC_MODE=local`, the auth middleware injects a static `RequestContext` with `tenantId = 'local'` and `userId = 'local'` without requiring a JWT. All service calls receive this default context, so existing code that doesn't pass `tenantId` explicitly continues to function. The PostgreSQL layer is bypassed entirely in local mode — services use the existing file-based storage paths.

## Web UI Adaptation

### What Changes

- **Remove Tauri**: all `@tauri-apps/*` imports, `src-tauri/` directory, Tauri configs
- **API client** (`desktop/src/api/client.ts`): `baseUrl` becomes configurable; all requests include JWT in `Authorization` header
- **WebSocket client** (`desktop/src/api/websocket.ts`): connection includes `?token=<jwt>`; token passed on connect
- **Auth pages**: Login, Register, Forgot Password under `desktop/src/pages/auth/`
- **Auth store**: New Zustand store (`desktop/src/stores/authStore.ts`) managing JWT tokens, auto-refresh, login/logout
- **Buddy sprite**: depends on Tauri APIs; needs removal or web fallback

### What Stays the Same

- All chat UI components (`desktop/src/components/chat/`)
- Session management UI
- Settings UI structure
- Team UI
- i18n system
- Zustand stores structure (just add auth store)

### File Serving

Gateway serves the built SPA:
- `GET /` → index.html
- `GET /assets/*` → static JS/CSS bundles
- `GET /api/*` → API routes (no conflict)
- `WS /ws/*` → WebSocket upgrade (no conflict)

### IM Adapters

- IM users map to tenant users (auto-created or linked via existing pairing flow)
- WsBridge connects to Gateway with a service-to-service JWT (contains `tenantId` claim)
- Session creation via Gateway API with service JWT

## Security Model

### Tenant Data Isolation

- Every database query includes `WHERE tenant_id = $1` — no exceptions
- Query helper enforces tenant scoping at the data access layer
- Row-Level Security (RLS) as defense-in-depth:
  ```sql
  ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON sessions
    USING (tenant_id = current_setting('app.current_tenant')::uuid);
  ```
  Gateway sets `app.current_tenant` on each DB connection before executing queries.

### Container Sandboxing

- `--no-new-privileges`, read-only rootfs, no `--privileged`
- Isolated Docker network: only outbound HTTPS (443) and internal SDK WebSocket to Gateway
- No host filesystem access — workspace is a Docker volume, not a bind mount
- No inter-container communication
- Resource limits enforced per container (CPU, memory, PID count)
- Container runs as non-root user (UID 1000)

### API Key Encryption

- Tenant BYOK keys encrypted at rest with AES-256-GCM using a platform master key
- Key stored in secrets manager (AWS KMS, Vault, or env var for self-hosted)
- Decrypted only at container creation time and injected as env vars
- Decrypted keys never touch the database, logs, or API responses
- Platform-managed keys use same encryption with separate key identifier

### Rate Limiting

Per-tenant sliding window, enforced at Gateway:

| Plan       | Request rate    | Token rate (output)   |
|------------|-----------------|-----------------------|
| Free       | 60 req/min      | 100K tokens/day       |
| Pro        | 300 req/min     | 2M tokens/day         |
| Enterprise | 1000 req/min    | 20M tokens/day        |

Token usage tracked by parsing `usage` from CLI result messages, accumulated in `tenant_usage` table.

### WebSocket Security

- JWT required on WebSocket upgrade (query param `?token=<jwt>`)
- Gateway validates token before proxying to container
- SDK tokens (container → Gateway) are one-time random UUIDs
- Cross-session access prevented: `sessionId.tenantId === jwt.tenantId`

### Audit Logging

- All API requests and WebSocket events logged with tenantId, userId, timestamp
- Sensitive data (message content, API keys) NOT logged — only event types and metadata
- Logs stored in `audit_logs` table, retained per compliance requirements
- Enterprise tenants can export audit logs via API

## Error Handling & Resilience

### Container Failure Handling

- Container crash detected via Docker API health check or exit event
- Gateway sends error to client: `{ type: 'error', message: 'Agent session crashed. Reconnecting...', code: 'CONTAINER_CRASH' }`
- On next user message, Orchestrator creates new container with `--resume sessionId`
- Conversation resumes from last transcript state in PostgreSQL

### Database Resilience

- Connection pooling via Bun's built-in Postgres client or `pg-pool`
- Retry logic for transient failures: 3 retries with 100ms/500ms/1s backoff
- Read replicas for `conversation_messages` queries — configured per deployment
- Migration runner runs on Gateway startup; supports rollback

### Gateway Resilience

- Stateless — no session state in process memory
- Active WebSocket connections are only in-process state
- Gateway restart: clients auto-reconnect via existing WsBridge reconnect logic
- Horizontal scaling: multiple Gateway instances behind load balancer (sticky sessions by `sessionId`)

### Orchestrator Resilience

- Stateful but recoverable:
  1. On restart, load sessions with `status = 'active'` from PostgreSQL
  2. Cross-reference with Docker API — remove stale `container_id` entries
  3. Resume monitoring active containers
- Single instance per Docker host; multi-host via Docker Swarm or Kubernetes is a future operational concern

### Error Response Format

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description",
  "retryable": false,
  "details": {}
}
```

Key error codes:

| Code | HTTP | Meaning |
|------|------|---------|
| `UNAUTHORIZED` | 401 | Invalid or expired JWT |
| `FORBIDDEN` | 403 | User lacks role permission |
| `TENANT_QUOTA_EXCEEDED` | 429 | Rate limit or token quota hit |
| `CONTAINER_START_FAILED` | 503 | Orchestrator cannot create container |
| `CONTAINER_CRASH` | 500 | Agent container crashed |
| `SESSION_NOT_FOUND` | 404 | Session doesn't exist or wrong tenant |
| `PROVIDER_CONFIG_INVALID` | 400 | BYOK key invalid or missing |

## Deployment & Operations

### Minimal Production Topology

```
                    +------------------+
                    |   Load Balancer   |
                    |   (nginx/caddy)   |
                    +--------+---------+
                             |
             +---------------+---------------+
             |               |               |
        +----v----+    +----v----+    +----v----+
        |Gateway 1|    |Gateway 2|    |Gateway N|
        +----+----+    +----+----+    +----+----+
             |               |               |
             +---------------+---------------+
                             | internal network
                    +--------v---------+
                    |   Orchestrator    |
                    +--------+---------+
                             | Docker API
              +--------------+--------------+
              |              |              |
        +-----v----+  +-----v----+  +-----v----+
        |Agent C1  |  |Agent C2  |  |Agent CN  |
        |(CLI+SDK) |  |(CLI+SDK) |  |(CLI+SDK) |
        +----------+  +----------+  +----------+
                             |
                    +--------v---------+
                    |    PostgreSQL     |
                    +------------------+
```

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `CC_MODE` | `local` or `saas` | `local` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `JWT_PRIVATE_KEY_PATH` | RS256 private key for signing tokens | — |
| `JWT_PUBLIC_KEY_PATH` | RS256 public key for verification | — |
| `ENCRYPTION_KEY_PATH` | AES-256 key for API key encryption | — |
| `ORCHESTRATOR_URL` | Internal URL for Orchestrator API | `http://127.0.0.1:3457` |
| `DOCKER_HOST` | Docker daemon socket for Orchestrator | `unix:///var/run/docker.sock` |
| `AGENT_IMAGE` | Docker image name for agent containers | `claude-agent:latest` |
| `GATEWAY_SDK_URL` | URL containers use to reach Gateway SDK WS | `ws://127.0.0.1:3456` |

### Database Migrations

Numbered SQL files in `src/db/migrations/`:
- `001_create_tenants.sql`
- `002_create_users.sql`
- `003_create_provider_configs.sql`
- `004_create_sessions.sql`
- `005_create_conversation_messages.sql`
- `006_create_audit_logs.sql`
- `007_create_tenant_usage.sql`
- `008_create_teams.sql`
- `009_create_team_members.sql`
- `010_create_indexes.sql`

Each migration is idempotent (`IF NOT EXISTS`). A `migrations` table tracks applied migrations.

### Monitoring

Gateway `GET /api/status`:
```json
{
  "status": "ok",
  "mode": "saas",
  "orchestrator": "connected",
  "database": "connected",
  "activeSessions": 12,
  "uptime": 86400
}
```

Orchestrator `GET /internal/health`:
```json
{
  "status": "ok",
  "dockerDaemon": "connected",
  "runningContainers": 12,
  "maxContainers": 100
}
```

Prometheus metrics endpoint (`:9090/metrics`) on both services for request rates, latency, container lifecycle events.

## Testing Strategy

### Unit Tests

- Every tenant-scoped service method tested for:
  - Correct tenant isolation (tenant A cannot access tenant B's data)
  - Role-based access control (member vs admin vs owner)
  - Input validation (invalid tenantId, missing auth)
- Existing test structure preserved (Bun test runner + Vitest)
- Multi-tenant seed data fixtures (2+ tenants with users, sessions, providers)

### Integration Tests

- Gateway ↔ Orchestrator: container creation, message routing, teardown
- Gateway ↔ PostgreSQL: all CRUD with tenant scoping
- End-to-end: auth → create session → send message → receive response → stop session
- Real PostgreSQL and Docker daemon in CI (Docker-in-Docker or service containers)

### Container Integration Tests

- Container starts with correct env vars and CLI args
- Container cannot access host filesystem
- Container network isolation (cannot reach other containers)
- Container respects resource limits
- Graceful shutdown on SIGTERM

### Security Tests

- SQL injection: parameterized queries verified; fuzz test API surface
- JWT forgery: expired, tampered, and missing tokens
- Cross-tenant access: systematically attempt every endpoint with wrong tenant token
- Container escape: verify read-only rootfs, no --privileged, non-root user
- API key exposure: keys never in API responses, logs, or errors

### Load Tests

- N concurrent tenants with active sessions
- Gateway throughput (requests/sec) and WebSocket latency
- Orchestrator container creation time (target: <3s cold start)
- PostgreSQL query performance under load

## Migration Path — Phased Rollout

### Phase 1: Extract DB Layer

- Add PostgreSQL client and migration runner
- Create database schema
- Build `src/db/` module with typed query helpers accepting `tenantId`
- Add `CC_MODE` env var — `saas` uses PostgreSQL; `local` uses existing file-based code
- No user-facing changes — purely internal refactoring

### Phase 2: Build Gateway Auth

- Implement JWT auth (register, login, refresh, social OAuth)
- Add auth middleware to existing server
- Add `/api/auth/*` routes
- Add login/register pages to web UI
- System now requires login but still runs CLI subprocesses on host
- Still single-process deployment

### Phase 3: Build Orchestrator

- Extract Orchestrator as a separate process
- Implement container lifecycle management
- Build agent Docker image
- Modify ConversationService to delegate to Orchestrator
- Add workspace volume management
- Deploy: Gateway + Orchestrator + Docker daemon + PostgreSQL

### Phase 4: Tenant Isolation Hardening

- Rate limiting middleware
- Row-Level Security in PostgreSQL
- Audit logging
- Container security hardening (read-only rootfs, network isolation, resource limits)
- API key encryption at rest
- Security penetration testing

### Phase 5: Web SPA + IM Adapter Update

- Strip Tauri from desktop app, build as web SPA
- Gateway serves SPA static files
- Update IM adapters to use service JWT auth
- Remove local-only features (buddy sprite, etc.)

### Phase 6: Polish and Scale

- Horizontal Gateway scaling behind load balancer
- Read replicas for PostgreSQL
- Prometheus metrics and alerting
- Admin dashboard for tenant management
- Self-service tenant signup and billing integration (Stripe)

## E2E Verification Flow — Local Docker Environment

This section defines a complete end-to-end verification procedure that runs on a single Mac with Docker Desktop. It validates every data path in the multi-tenant architecture: auth → tenant isolation → session creation → agent execution → permission flow → conversation persistence.

### Prerequisites

| Dependency | Version | Verification Command |
|------------|---------|---------------------|
| Docker Engine | 24.0+ | `docker --version` |
| Docker Compose | v2+ | `docker compose version` |
| Bun | 1.1+ | `bun --version` |
| curl | any | `curl --version` |
| jwt-cli (optional) | 6+ | `jwt --version` |

Docker must have at least 4 GB memory allocated (Docker Desktop → Settings → Resources).

### Quick Start

```bash
# 1. Build all images and start services
docker compose -f docker-compose.e2e.yml up --build -d

# 2. Wait for services to be healthy (max 60s)
./scripts/e2e-wait-for-ready.sh

# 3. Run the full E2E test suite
./scripts/e2e-test.sh

# 4. Open web UI in browser
open http://127.0.0.1:3456
```

### Service Topology (docker-compose.e2e.yml)

```
┌─────────────────────────────────────────────────────────────────┐
│  Docker Network: cc-haha-e2e                                    │
│                                                                 │
│  ┌────────┐   ┌────────────┐   ┌─────────────┐   ┌──────────┐ │
│  │ pg     │   │ gateway    │   │ orchestrator│   │ web      │ │
│  │ :5432  │◄──│ :3456      │──►│ :3457       │   │ :2024    │ │
│  │        │   │            │   │             │   │          │ │
│  │        │   │ /api/*     │   │ /internal/* │   │ SPA      │ │
│  │        │   │ /ws/*      │   │             │   │          │ │
│  │        │   │ /sdk/*     │   │ Docker.sock │   │          │ │
│  └────────┘   └────────────┘   └──────┬──────┘   └──────────┘ │
│                                      │                         │
│                        ┌─────────────▼─────────────┐           │
│                        │ Agent Container (dynamic) │           │
│                        │ Created per session       │           │
│                        │ cc-haha-agent:latest      │           │
│                        └──────────────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

### Docker Compose File

`docker-compose.e2e.yml` at project root:

```yaml
version: "3.9"

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: cc_haha
      POSTGRES_USER: cc_haha
      POSTGRES_PASSWORD: e2e_password
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cc_haha"]
      interval: 2s
      timeout: 3s
      retries: 30

  gateway:
    build:
      context: .
      dockerfile: Dockerfile.gateway
    ports:
      - "3456:3456"
    environment:
      CC_MODE: saas
      DATABASE_URL: postgres://cc_haha:e2e_password@postgres:5432/cc_haha
      JWT_PRIVATE_KEY_PATH: /keys/private.pem
      JWT_PUBLIC_KEY_PATH: /keys/public.pem
      ENCRYPTION_KEY_PATH: /keys/encryption.key
      ORCHESTRATOR_URL: http://orchestrator:3457
    volumes:
      - ./keys:/keys:ro
      - web-spa:/app/dist
    depends_on:
      postgres:
        condition: service_healthy

  orchestrator:
    build:
      context: .
      dockerfile: Dockerfile.orchestrator
    ports:
      - "3457:3457"
    environment:
      DATABASE_URL: postgres://cc_haha:e2e_password@postgres:5432/cc_haha
      DOCKER_HOST: unix:///var/run/docker.sock
      GATEWAY_SDK_URL: ws://gateway:3456
      AGENT_IMAGE: cc-haha-agent:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - agent-workspaces:/workspaces
      - agent-homes:/homes
    depends_on:
      postgres:
        condition: service_healthy

  web:
    build:
      context: ./desktop
      dockerfile: Dockerfile.web
    ports:
      - "2024:80"
    depends_on:
      - gateway

volumes:
  pgdata:
  agent-workspaces:
  agent-homes:
  web-spa:
```

### Agent Docker Image

`Dockerfile.agent` at project root:

```dockerfile
FROM oven/bun:1.1-alpine

WORKDIR /app

# Copy entire project and install dependencies
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

COPY src/ src/
COPY bin/ bin/

# Agent runs as non-root user
RUN adduser -D -u 1000 agent
USER agent

# Default: run CLI in print mode with SDK URL
# The actual --sdk-url is provided at container create time
ENTRYPOINT ["bun", "src/entrypoints/cli.tsx"]
CMD ["--print", "--verbose", "--output-format=stream-json", "--input-format=stream-json"]
```

### Gateway Docker Image

`Dockerfile.gateway` at project root:

```dockerfile
FROM oven/bun:1.1-alpine

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

COPY src/ src/
COPY bin/ bin/
COPY scripts/ scripts/

# Generate self-signed JWT keys for development
RUN mkdir -p /keys && \
    openssl genpkey -algorithm RSA -out /keys/private.pem -pkeyopt rsa_keygen_bits:2048 && \
    openssl rsa -pubout -in /keys/private.pem -out /keys/public.pem && \
    openssl rand -hex 32 > /keys/encryption.key

EXPOSE 3456
CMD ["bun", "src/gateway/index.ts"]
```

### Orchestrator Docker Image

`Dockerfile.orchestrator` at project root:

```dockerfile
FROM oven/bun:1.1-alpine

# Install Docker CLI for container management
RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

COPY src/ src/

# Pre-build the agent image (available to Docker daemon via socket mount)
COPY Dockerfile.agent /app/Dockerfile.agent

EXPOSE 3457
CMD ["bun", "src/orchestrator/index.ts"]
```

### Web SPA Docker Image

`Dockerfile.web` in `desktop/`:

```dockerfile
FROM oven/bun:1.1-alpine AS build
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

`nginx.conf` in `desktop/`:

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API and WebSocket to Gateway
    location /api/ {
        proxy_pass http://gateway:3456;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /ws/ {
        proxy_pass http://gateway:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    location /health {
        proxy_pass http://gateway:3456;
    }
}
```

### E2E Test Scenarios

All scenarios run via `scripts/e2e-test.sh` and can also be executed manually with curl.

---

#### Scenario 1: User Registration & Login

```bash
# Register tenant A
curl -s -X POST http://127.0.0.1:3456/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@acme.com","password":"test1234","tenantName":"Acme Corp","tenantSlug":"acme"}' \
  | jq .

# Expected:
# { "accessToken": "eyJ...", "refreshToken": "eyJ...", "tenantId": "uuid-acme", "userId": "uuid-alice" }

# Save tokens
TOKEN_A=$(curl -s -X POST http://127.0.0.1:3456/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@acme.com","password":"test1234"}' | jq -r '.accessToken')

# Register tenant B
curl -s -X POST http://127.0.0.1:3456/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"bob@beta.com","password":"test1234","tenantName":"Beta Inc","tenantSlug":"beta"}'

TOKEN_B=$(curl -s -X POST http://127.0.0.1:3456/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"bob@beta.com","password":"test1234"}' | jq -r '.accessToken')

# Verify token contains tenant info
echo "$TOKEN_A" | cut -d. -f2 | base64 -d 2>/dev/null | jq .
# Expected: { "sub": "...", "tid": "uuid-acme", "role": "owner", ... }
```

**Pass criteria:**
- Registration returns 200 with valid JWT
- Login returns 200 with valid JWT
- JWT payload contains `tid` (tenantId) matching the created tenant
- Duplicate email registration returns 409

---

#### Scenario 2: Provider Configuration (BYOK)

```bash
# Tenant A configures BYOK provider
curl -s -X POST http://127.0.0.1:3456/api/providers \
  -H "Authorization: Bearer $TOKEN_A" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-anthropic",
    "type": "anthropic",
    "baseUrl": "https://api.anthropic.com",
    "authToken": "sk-ant-ak-test-key-xxx",
    "models": ["claude-sonnet-4-6"]
  }' | jq .

# Expected: { "id": "uuid-provider", "name": "my-anthropic", "isActive": true }

# Verify: auth token is NOT returned in GET response
curl -s http://127.0.0.1:3456/api/providers \
  -H "Authorization: Bearer $TOKEN_A" | jq .
# Expected: authToken should be masked or absent

# Verify: Tenant B cannot see Tenant A's providers
curl -s http://127.0.0.1:3456/api/providers \
  -H "Authorization: Bearer $TOKEN_B" | jq .
# Expected: []
```

**Pass criteria:**
- Provider created successfully
- Auth token not exposed in GET response
- Tenant B sees zero providers (cross-tenant isolation)

---

#### Scenario 3: Session Creation & Agent Execution

```bash
# Create session for tenant A
SESSION_RESP=$(curl -s -X POST http://127.0.0.1:3456/api/sessions \
  -H "Authorization: Bearer $TOKEN_A" \
  -H "Content-Type: application/json" \
  -d '{"workDir": "/workspace", "model": "claude-sonnet-4-6"}')
SESSION_ID=$(echo "$SESSION_RESP" | jq -r '.sessionId')
echo "Session: $SESSION_ID"

# Connect WebSocket and send message (using websocat or wscat)
# Install: brew install websocat
echo '{"type":"user_message","content":"帮我生成一份SQL"}' | \
  timeout 60 websocat -1 "ws://127.0.0.1:3456/ws/$SESSION_ID?token=$TOKEN_A"

# Alternatively, use the helper script:
./scripts/e2e-chat.sh "$TOKEN_A" "$SESSION_ID" "帮我生成一份SQL"
```

**Pass criteria:**
- Session created with status `idle`
- Container started (visible via `docker ps`)
- WebSocket receives `connected` message
- WebSocket receives `status: thinking` → `status: streaming` flow
- WebSocket receives `content_delta` with response text
- After completion, `message_complete` with usage stats

---

#### Scenario 4: Permission Flow

```bash
# Send a message that triggers a tool use (e.g., asking to write a file)
./scripts/e2e-chat.sh "$TOKEN_A" "$SESSION_ID" "请创建一个文件 hello.txt 内容为 Hello World"

# Expected event sequence on WebSocket:
# 1. { type: "content_start", blockType: "text" }
# 2. { type: "content_delta", text: "I'll create..." }
# 3. { type: "content_start", blockType: "tool_use", toolName: "Write" }
# 4. { type: "tool_use_complete", toolName: "Write", ... }
# 5. { type: "permission_request", requestId: "...", toolName: "Write", ... }
#
# Respond with allow:
echo '{"type":"permission_response","requestId":"<requestId>","allowed":true}' | \
  websocat "ws://127.0.0.1:3456/ws/$SESSION_ID?token=$TOKEN_A"
#
# 6. { type: "tool_result", toolUseId: "...", isError: false }
# 7. { type: "content_delta", text: "I've created..." }
# 8. { type: "message_complete", usage: { ... } }
```

**Pass criteria:**
- Permission request received on client WS
- After allow response, tool executes successfully
- Tool result is sent back
- File exists in tenant workspace volume

---

#### Scenario 5: Tenant Data Isolation

```bash
# List sessions as Tenant A
curl -s http://127.0.0.1:3456/api/sessions \
  -H "Authorization: Bearer $TOKEN_A" | jq '. | length'
# Expected: 1 (the session created above)

# List sessions as Tenant B
curl -s http://127.0.0.1:3456/api/sessions \
  -H "Authorization: Bearer $TOKEN_B" | jq '. | length'
# Expected: 0

# Try to access Tenant A's session as Tenant B
curl -s http://127.0.0.1:3456/api/sessions/$SESSION_ID \
  -H "Authorization: Bearer $TOKEN_B"
# Expected: 404 { "error": "SESSION_NOT_FOUND" }

# Verify database isolation directly
docker exec cc-haha-postgres psql -U cc_haha -c \
  "SELECT tenant_id, count(*) FROM sessions GROUP BY tenant_id;"
# Expected: two rows with correct counts per tenant
```

**Pass criteria:**
- Each tenant sees only their own sessions
- Cross-tenant session access returns 404
- Database query shows tenant-scoped data

---

#### Scenario 6: Container Lifecycle

```bash
# Verify container is running during active session
docker ps --filter "label=cc-haha.session-id=$SESSION_ID"
# Expected: 1 container running

# Stop the session via API
curl -s -X DELETE "http://127.0.0.1:3456/api/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $TOKEN_A"

# Verify container is cleaned up (wait 5s for graceful shutdown)
sleep 5
docker ps --filter "label=cc-haha.session-id=$SESSION_ID"
# Expected: 0 containers

# Verify Orchestrator health
curl -s http://127.0.0.1:3457/internal/health | jq .
# Expected: { "status": "ok", "dockerDaemon": "connected", "runningContainers": 0 }
```

**Pass criteria:**
- Container created when session starts
- Container removed when session stops
- No orphan containers after cleanup

---

#### Scenario 7: Auth Token Refresh & Expiry

```bash
# Get fresh tokens
LOGIN_RESP=$(curl -s -X POST http://127.0.0.1:3456/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@acme.com","password":"test1234"}')
ACCESS_TOKEN=$(echo "$LOGIN_RESP" | jq -r '.accessToken')
REFRESH_TOKEN=$(echo "$LOGIN_RESP" | jq -r '.refreshToken')

# Wait for access token to expire (15 min in production; set to 30s in e2e via JWT_ACCESS_TTL=30s)
sleep 35

# Access token should be rejected
curl -s http://127.0.0.1:3456/api/sessions \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
# Expected: 401 { "error": "UNAUTHORIZED" }

# Refresh the token
NEW_ACCESS=$(curl -s -X POST http://127.0.0.1:3456/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}" | jq -r '.accessToken')

# New access token should work
curl -s http://127.0.0.1:3456/api/sessions \
  -H "Authorization: Bearer $NEW_ACCESS" | jq .
# Expected: 200 with session list
```

**Pass criteria:**
- Expired access token returns 401
- Refresh token grants new access token
- New access token works

---

#### Scenario 8: Rate Limiting

```bash
# Send many requests rapidly as tenant A (free tier: 60 req/min)
for i in $(seq 1 70); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3456/api/sessions \
    -H "Authorization: Bearer $TOKEN_A")
  echo "Request $i: $STATUS"
done

# Expected: first 60 return 200, subsequent return 429
```

**Pass criteria:**
- Requests within limit return 200
- Requests exceeding limit return 429 with `TENANT_QUOTA_EXCEEDED`

---

#### Scenario 9: Conversation Persistence & Resume

```bash
# Create session and have a conversation
SESSION_ID=$(curl -s -X POST http://127.0.0.1:3456/api/sessions \
  -H "Authorization: Bearer $TOKEN_A" \
  -H "Content-Type: application/json" \
  -d '{"workDir":"/workspace"}' | jq -r '.sessionId')

# Send first message
./scripts/e2e-chat.sh "$TOKEN_A" "$SESSION_ID" "hello"

# Verify messages persisted in DB
docker exec cc-haha-postgres psql -U cc_haha -c \
  "SELECT role, content FROM conversation_messages WHERE session_id = '$SESSION_ID' ORDER BY created_at;"
# Expected: rows for user + assistant messages

# Resume session (create new container for same session)
./scripts/e2e-chat.sh "$TOKEN_A" "$SESSION_ID" "what did I just say?"
# Expected: agent has context from previous message
```

**Pass criteria:**
- Messages persisted in `conversation_messages` table
- Session resume works — agent has prior conversation context

---

#### Scenario 10: Web UI Full Flow

```
1. Open http://127.0.0.1:2024 in browser
2. Click "Register" → fill email, password, tenant name → submit
3. Auto-redirect to chat interface
4. Type "帮我生成一份SQL" → enter
5. Observe streaming response in chat UI
6. If permission prompt appears → click "Allow"
7. Verify tool result rendered in UI
8. Click "New Session" → verify new session starts
9. Click "Settings" → verify provider management works
10. Logout → login → verify sessions persist
```

**Pass criteria:**
- Complete auth flow works in browser
- Chat with streaming works
- Permission prompts render and can be responded to
- Session list shows history
- Settings page reads/writes provider config

---

### E2E Test Runner Script

`scripts/e2e-test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE_URL="http://127.0.0.1:3456"
PASS=0
FAIL=0

report() {
  local name=$1 result=$2
  if [ "$result" = "pass" ]; then
    echo "  ✅ $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== E2E Test Suite ==="
echo ""

# --- Scenario 1: Auth ---
echo "--- Scenario 1: Auth ---"

# Register tenant A
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"e2e-a@test.com","password":"test1234","tenantName":"E2E Alpha","tenantSlug":"e2e-alpha"}')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
TOKEN_A=$(echo "$BODY" | jq -r '.accessToken')
TENANT_A=$(echo "$BODY" | jq -r '.tenantId')
report "Register tenant A" "$([ "$STATUS" = "200" ] && echo pass || echo fail)"

# Register tenant B
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"e2e-b@test.com","password":"test1234","tenantName":"E2E Beta","tenantSlug":"e2e-beta"}')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
TOKEN_B=$(echo "$BODY" | jq -r '.accessToken')
report "Register tenant B" "$([ "$STATUS" = "200" ] && echo pass || echo fail)"

# Duplicate registration should fail
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"e2e-a@test.com","password":"test1234","tenantName":"Dup","tenantSlug":"dup"}')
STATUS=$(echo "$RESP" | tail -1)
report "Duplicate registration rejected" "$([ "$STATUS" = "409" ] && echo pass || echo fail)"

# Login
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"e2e-a@test.com","password":"test1234"}')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
TOKEN_A=$(echo "$BODY" | jq -r '.accessToken')
report "Login success" "$([ "$STATUS" = "200" ] && echo pass || echo fail)"

# --- Scenario 2: Provider ---
echo "--- Scenario 2: Provider ---"

RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/providers" \
  -H "Authorization: Bearer $TOKEN_A" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-provider","type":"anthropic","baseUrl":"https://api.anthropic.com","authToken":"sk-ant-test-key","models":["claude-sonnet-4-6"]}')
STATUS=$(echo "$RESP" | tail -1)
report "Create provider" "$([ "$STATUS" = "200" ] && echo pass || echo fail)"

# Verify token not exposed
BODY=$(curl -s "$BASE_URL/api/providers" -H "Authorization: Bearer $TOKEN_A")
HAS_KEY=$(echo "$BODY" | jq -r '.[].authToken // empty')
report "Auth token masked in GET" "$([ -z "$HAS_KEY" ] && echo pass || echo fail)"

# Cross-tenant isolation
BODY=$(curl -s "$BASE_URL/api/providers" -H "Authorization: Bearer $TOKEN_B")
COUNT=$(echo "$BODY" | jq '. | length')
report "Cross-tenant provider isolation" "$([ "$COUNT" = "0" ] && echo pass || echo fail)"

# --- Scenario 3: Session ---
echo "--- Scenario 3: Session Creation ---"

RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/sessions" \
  -H "Authorization: Bearer $TOKEN_A" \
  -H "Content-Type: application/json" \
  -d '{"workDir":"/workspace"}')
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
SESSION_ID=$(echo "$BODY" | jq -r '.sessionId')
report "Create session" "$([ "$STATUS" = "200" ] && echo pass || echo fail)"

# --- Scenario 5: Data Isolation ---
echo "--- Scenario 5: Data Isolation ---"

BODY=$(curl -s "$BASE_URL/api/sessions" -H "Authorization: Bearer $TOKEN_A")
COUNT=$(echo "$BODY" | jq '. | length')
report "Tenant A sees own sessions" "$([ "$COUNT" -ge "1" ] && echo pass || echo fail)"

BODY=$(curl -s "$BASE_URL/api/sessions" -H "Authorization: Bearer $TOKEN_B")
COUNT=$(echo "$BODY" | jq '. | length')
report "Tenant B sees no sessions" "$([ "$COUNT" = "0" ] && echo pass || echo fail)"

RESP=$(curl -s -w "\n%{http_code}" "$BASE_URL/api/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $TOKEN_B")
STATUS=$(echo "$RESP" | tail -1)
report "Cross-tenant session access denied" "$([ "$STATUS" = "404" ] && echo pass || echo fail)"

# --- Scenario 6: Container Lifecycle ---
echo "--- Scenario 6: Container Lifecycle ---"

# Delete session
RESP=$(curl -s -w "\n%{http_code}" -X DELETE "$BASE_URL/api/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $TOKEN_A")
STATUS=$(echo "$RESP" | tail -1)
report "Delete session" "$([ "$STATUS" = "200" ] && echo pass || echo fail)"

# --- Gateway Health ---
echo "--- Gateway Health ---"

RESP=$(curl -s "$BASE_URL/api/status")
STATUS=$(echo "$RESP" | jq -r '.status')
report "Gateway status OK" "$([ "$STATUS" = "ok" ] && echo pass || echo fail)"

# --- Orchestrator Health ---
echo "--- Orchestrator Health ---"

RESP=$(curl -s "http://127.0.0.1:3457/internal/health")
STATUS=$(echo "$RESP" | jq -r '.status')
report "Orchestrator status OK" "$([ "$STATUS" = "ok" ] && echo pass || echo fail)"

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
```

### Wait-for-Ready Script

`scripts/e2e-wait-for-ready.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "Waiting for services to be ready..."
MAX_WAIT=120
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  if curl -sf http://127.0.0.1:3456/api/status > /dev/null 2>&1 && \
     curl -sf http://127.0.0.1:3457/internal/health > /dev/null 2>&1; then
    echo "All services ready after ${ELAPSED}s"
    exit 0
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  echo "  ... waiting (${ELAPSED}s)"
done

echo "ERROR: Services not ready after ${MAX_WAIT}s"
exit 1
```

### Chat Helper Script

`scripts/e2e-chat.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

TOKEN=$1
SESSION_ID=$2
MESSAGE=$3
BASE_WS="ws://127.0.0.1:3456/ws/$SESSION_ID?token=$TOKEN"

# Use websocat or fall back to a simple node script
if command -v websocat &> /dev/null; then
  # Send message and listen for 60s
  (echo "{\"type\":\"user_message\",\"content\":\"$MESSAGE\"}"; sleep 60) | \
    timeout 65 websocat "$BASE_WS" 2>/dev/null || true
elif command -v node &> /dev/null; then
  node -e "
    const WebSocket = require('ws');
    const ws = new WebSocket('$BASE_WS');
    ws.on('open', () => {
      ws.send(JSON.stringify({type:'user_message',content:'$MESSAGE'}));
      setTimeout(() => { ws.close(); process.exit(0); }, 60000);
    });
    ws.on('message', (data) => { console.log(data.toString()); });
    ws.on('error', (e) => { console.error(e.message); process.exit(1); });
  "
else
  echo "Error: install websocat (brew install websocat) or node"
  exit 1
fi
```

---

## README — Multi-Tenant SaaS Deployment

This section serves as the README for the multi-tenant mode of cc-haha.

### What Is This?

cc-haha can run in two modes:

- **`local`** (default): Single-user CLI/desktop mode, identical to the current experience. No Docker, no PostgreSQL required.
- **`saas`**: Multi-tenant cloud service mode. Multiple organizations share the same deployment, with logical data isolation, Docker-containerized agent sessions, and JWT-based authentication.

Mode is controlled by the `CC_MODE` environment variable.

### Architecture

```
User Browser / IM Client
       │
       ▼
   Gateway (Bun)        ← JWT auth, rate limiting, API routing, WebSocket proxy
       │
       ├──► PostgreSQL  ← Tenant-scoped data storage
       │
       └──► Orchestrator (Bun)  ← Docker container lifecycle
                │
                └──► Agent Container (per session)
                     └──► LLM Provider API
```

### Quick Start (Local Docker)

```bash
# Prerequisites: Docker 24+, Docker Compose v2+, Bun 1.1+

# 1. Clone and enter project
cd cc-haha

# 2. Build and start all services
docker compose -f docker-compose.e2e.yml up --build -d

# 3. Wait for readiness
./scripts/e2e-wait-for-ready.sh

# 4. Run E2E tests
./scripts/e2e-test.sh

# 5. Open web UI
open http://127.0.0.1:2024

# 6. Teardown
docker compose -f docker-compose.e2e.yml down -v
```

### Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `CC_MODE` | Yes | `local` or `saas` | `local` |
| `DATABASE_URL` | saas | PostgreSQL connection string | — |
| `JWT_PRIVATE_KEY_PATH` | saas | Path to RS256 private key | — |
| `JWT_PUBLIC_KEY_PATH` | saas | Path to RS256 public key | — |
| `ENCRYPTION_KEY_PATH` | saas | Path to AES-256 encryption key | — |
| `JWT_ACCESS_TTL` | saas | Access token lifetime | `15m` |
| `JWT_REFRESH_TTL` | saas | Refresh token lifetime | `7d` |
| `ORCHESTRATOR_URL` | saas | Internal URL for Orchestrator | `http://127.0.0.1:3457` |
| `DOCKER_HOST` | saas | Docker daemon socket | `unix:///var/run/docker.sock` |
| `AGENT_IMAGE` | saas | Agent container image name | `cc-haha-agent:latest` |
| `GATEWAY_SDK_URL` | saas | URL containers use for SDK WS | `ws://127.0.0.1:3456` |
| `SERVER_PORT` | both | Gateway HTTP port | `3456` |
| `SERVER_HOST` | both | Gateway bind address | `127.0.0.1` |

### API Reference

#### Authentication

```
POST /api/auth/register     Register new tenant + user
POST /api/auth/login        Login with email/password
POST /api/auth/refresh      Refresh access token
POST /api/auth/social       Social OAuth (Google/GitHub)
```

#### Sessions

```
GET    /api/sessions                List sessions for current tenant/user
POST   /api/sessions                Create new session
GET    /api/sessions/:id            Get session details
PATCH  /api/sessions/:id            Update session (title, etc.)
DELETE /api/sessions/:id            Stop and delete session
GET    /api/sessions/:id/messages   Get conversation messages
WS     /ws/:sessionId               Real-time chat WebSocket
```

#### Providers

```
GET    /api/providers               List providers for current tenant
POST   /api/providers               Add provider config (BYOK)
PUT    /api/providers/:id           Update provider
DELETE /api/providers/:id           Delete provider
```

#### Settings

```
GET    /api/settings                Get tenant settings
PATCH  /api/settings                Update tenant settings
```

#### System

```
GET    /api/status                  Health check (public)
GET    /health                      Simple health check
```

### WebSocket Protocol

Connect: `wss://<host>/ws/<sessionId>?token=<jwt>`

Client → Server messages:

```json
{ "type": "user_message", "content": "text" }
{ "type": "permission_response", "requestId": "...", "allowed": true }
{ "type": "set_permission_mode", "mode": "default" }
{ "type": "stop_generation" }
{ "type": "ping" }
```

Server → Client messages:

```json
{ "type": "connected", "sessionId": "..." }
{ "type": "content_start", "blockType": "text|tool_use", "toolName": "..." }
{ "type": "content_delta", "text": "..." }
{ "type": "tool_use_complete", "toolName": "...", "toolUseId": "...", "input": {} }
{ "type": "tool_result", "toolUseId": "...", "content": {}, "isError": false }
{ "type": "permission_request", "requestId": "...", "toolName": "...", "input": {} }
{ "type": "message_complete", "usage": { "input_tokens": 0, "output_tokens": 0 } }
{ "type": "status", "state": "idle|thinking|streaming|permission_pending", "verb": "..." }
{ "type": "error", "message": "...", "code": "..." }
{ "type": "session_title_updated", "sessionId": "...", "title": "..." }
{ "type": "pong" }
```

### Development

```bash
# Run in saas mode locally (without Docker containers for Gateway/Orchestrator)
CC_MODE=saas \
DATABASE_URL=postgres://cc_haha:password@127.0.0.1:5432/cc_haha \
JWT_PRIVATE_KEY_PATH=./keys/private.pem \
JWT_PUBLIC_KEY_PATH=./keys/public.pem \
ENCRYPTION_KEY_PATH=./keys/encryption.key \
bun run src/gateway/index.ts

# Run Orchestrator locally
ORCHESTRATOR_URL=http://127.0.0.1:3457 \
DOCKER_HOST=unix:///var/run/docker.sock \
AGENT_IMAGE=cc-haha-agent:latest \
GATEWAY_SDK_URL=ws://127.0.0.1:3456 \
bun run src/orchestrator/index.ts

# Run database migrations
DATABASE_URL=postgres://cc_haha:password@127.0.0.1:5432/cc_haha \
bun run src/db/migrate.ts

# Run tests (saas mode)
DATABASE_URL=postgres://cc_haha:password@127.0.0.1:5432/cc_haha_test \
CC_MODE=saas \
bun test src/server/__tests__/
```

### Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| Gateway won't start | `docker compose logs gateway` | Verify DATABASE_URL and key paths |
| Orchestrator won't start | `docker compose logs orchestrator` | Verify Docker socket mount |
| Container creation fails | `docker compose logs orchestrator` | Check agent image exists: `docker images cc-haha-agent` |
| WebSocket disconnects | Browser console / `docker compose logs gateway` | Verify JWT not expired; check session still active |
| Permission prompts not received | WebSocket messages in browser DevTools | Verify permission mode not set to `bypass` |
| Cross-tenant data leak | DB query directly | Verify RLS policies: `SELECT * FROM pg_policies` |
| Port conflicts | `lsof -i :3456 -i :3457 -i :5432` | Stop conflicting services or change ports in compose file |
