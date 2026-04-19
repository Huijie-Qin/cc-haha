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
     - `CC_HAHA_SKIP_DOTENV` = 1
     - `CLAUDE_CODE_ENABLE_TASKS` = 1
   - **Volume mount**: tenant workspace volume → /workspace
   - **Network**: internal Docker network (can reach Gateway SDK endpoint + LLM provider APIs; cannot reach other containers or host)
   - **CLI args**: `--print --verbose --sdk-url ws://gateway:3456/sdk/{sessionId}?token={sdkToken} --session-id {sessionId} --input-format stream-json --output-format stream-json`
   - **Resource limits**: CPU shares, memory cap (per plan tier), no --privileged
   - **Security**: `--no-new-privileges`, read-only rootfs (writable /tmp, /workspace), non-root user (UID 1000)
   - **Auto-remove** on exit

2. Start container, wait for SDK WebSocket connection from CLI

3. Return container info to Gateway: `{ containerId, status: 'active' }`

### Workspace Volumes

- Each tenant gets a named Docker volume: `tenant-{tenantId}-workspace`
- Mounted at `/workspace` in every container for that tenant
- Persistent across sessions — user can resume conversations and see their files
- Enterprise option: mount external storage (S3, NFS) instead

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
