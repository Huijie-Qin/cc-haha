# Multi-Tenant Phase 1: Extract DB Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PostgreSQL abstraction layer that existing services can use when `CC_MODE=saas`, while preserving current file-based behavior under `CC_MODE=local`.

**Architecture:** A new `src/db/` module provides typed query helpers that always include `tenantId`. When `CC_MODE=local` (default), the DB module is not used and all services continue with their current file-based implementations. A compatibility shim injects a static `RequestContext` with `tenantId='local'` and `userId='local'` in local mode.

**Tech Stack:** Bun, TypeScript, PostgreSQL (via `pg` or Bun's built-in `Bun.postgres()`), SQL migrations

**Spec reference:** `docs/superpowers/specs/2026-04-19-multi-tenant-service-design.md` — Phase 1: Extract DB Layer

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/db/client.ts` | PostgreSQL connection pool singleton |
| Create | `src/db/migrate.ts` | Migration runner — applies numbered SQL files on startup |
| Create | `src/db/queries/tenants.ts` | Typed queries for `tenants` table |
| Create | `src/db/queries/users.ts` | Typed queries for `users` table |
| Create | `src/db/queries/sessions.ts` | Typed queries for `sessions` table |
| Create | `src/db/queries/providerConfigs.ts` | Typed queries for `provider_configs` table |
| Create | `src/db/queries/conversationMessages.ts` | Typed queries for `conversation_messages` table |
| Create | `src/db/queries/auditLogs.ts` | Typed queries for `audit_logs` table |
| Create | `src/db/queries/tenantUsage.ts` | Typed queries for `tenant_usage` table |
| Create | `src/db/queries/teams.ts` | Typed queries for `teams` + `team_members` tables |
| Create | `src/db/queries/index.ts` | Re-exports all query modules |
| Create | `src/db/migrations/001_create_tenants.sql` | Migration: tenants table |
| Create | `src/db/migrations/002_create_users.sql` | Migration: users table |
| Create | `src/db/migrations/003_create_provider_configs.sql` | Migration: provider_configs table |
| Create | `src/db/migrations/004_create_sessions.sql` | Migration: sessions table |
| Create | `src/db/migrations/005_create_conversation_messages.sql` | Migration: conversation_messages table |
| Create | `src/db/migrations/006_create_audit_logs.sql` | Migration: audit_logs table |
| Create | `src/db/migrations/007_create_tenant_usage.sql` | Migration: tenant_usage table |
| Create | `src/db/migrations/008_create_teams.sql` | Migration: teams + team_members tables |
| Create | `src/db/migrations/009_create_indexes.sql` | Migration: performance indexes |
| Modify | `src/server/middleware/auth.ts` | Add `CC_MODE`-aware auth: JWT in saas, API key in local |
| Create | `src/server/middleware/context.ts` | `RequestContext` type + extraction from JWT/local shim |
| Modify | `src/server/router.ts` | Add `api/auth` routes (saas only) |
| Create | `src/server/api/auth.ts` | Auth API handlers: register, login, refresh |
| Create | `src/server/services/authService.ts` | JWT creation, password hashing, token refresh |
| Modify | `src/server/index.ts` | Load DB client + run migrations on startup (saas mode) |
| Modify | `package.json` | Add `jsonwebtoken` (or `jose`), `bcrypt`, `pg` dependencies |
| Create | `src/db/__tests__/client.test.ts` | DB client tests |
| Create | `src/db/__tests__/migrate.test.ts` | Migration runner tests |
| Create | `src/db/__tests__/queries/tenants.test.ts` | Tenant query tests |
| Create | `src/db/__tests__/queries/users.test.ts` | User query tests |
| Create | `src/db/__tests__/queries/sessions.test.ts` | Session query tests |
| Create | `src/server/__tests__/auth.test.ts` | Auth middleware + auth API tests |

---

## Task 1: Add Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install PostgreSQL and auth dependencies**

Run:
```bash
bun add pg jose bcrypt
bun add -d @types/pg @types/bcrypt
```

- [ ] **Step 2: Verify installation**

Run:
```bash
bun --version && bun -e "const pg = require('pg'); console.log('pg:', typeof pg.Pool)"
```
Expected: Version printed, `pg: function`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: add pg, jose, bcrypt dependencies for multi-tenant DB layer"
```

---

## Task 2: PostgreSQL Client Singleton

**Files:**
- Create: `src/db/client.ts`
- Create: `src/db/__tests__/client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/db/__tests__/client.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { getDbClient, closeDbClient, isDbConnected } from '../client.js'

describe('DB Client', () => {
  afterEach(async () => {
    await closeDbClient()
  })

  test('isDbConnected returns false when no client initialized', () => {
    expect(isDbConnected()).toBe(false)
  })

  test('getDbClient throws when DATABASE_URL not set', () => {
    const original = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    expect(() => getDbClient()).toThrow('DATABASE_URL not configured')
    process.env.DATABASE_URL = original
  })

  test('getDbClient returns a pool when DATABASE_URL is set', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test'
    const client = getDbClient()
    expect(client).toBeDefined()
    expect(typeof client.query).toBe('function')
  })

  test('getDbClient returns same instance on repeated calls', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test'
    const a = getDbClient()
    const b = getDbClient()
    expect(a).toBe(b)
  })

  test('closeDbClient resets the singleton', async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test'
    getDbClient()
    await closeDbClient()
    expect(isDbConnected()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/db/__tests__/client.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

```typescript
// src/db/client.ts
import pg from 'pg'

let pool: pg.Pool | null = null

export function getDbClient(): pg.Pool {
  if (pool) return pool

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL not configured. Set CC_MODE=local or provide DATABASE_URL.')
  }

  pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })

  pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message)
  })

  return pool
}

export function isDbConnected(): boolean {
  return pool !== null
}

export async function closeDbClient(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/db/__tests__/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/client.ts src/db/__tests__/client.test.ts
git commit -m "feat: add PostgreSQL client singleton for multi-tenant DB"
```

---

## Task 3: Migration Runner

**Files:**
- Create: `src/db/migrate.ts`
- Create: `src/db/migrations/001_create_tenants.sql` through `009_create_indexes.sql`
- Create: `src/db/__tests__/migrate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/db/__tests__/migrate.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { getDbClient, closeDbClient } from '../client.js'
import { runMigrations, getAppliedMigrations } from '../migrate.js'

// This test requires a real PostgreSQL — skip if no DATABASE_URL
const dbUrl = process.env.DATABASE_URL
describe.skipIf(!dbUrl)('Migration Runner', () => {
  beforeAll(() => {
    getDbClient()
  })

  afterAll(async () => {
    await closeDbClient()
  })

  test('runMigrations creates the migrations table', async () => {
    await runMigrations()
    const applied = await getAppliedMigrations()
    expect(applied.length).toBeGreaterThan(0)
  })

  test('runMigrations is idempotent', async () => {
    await runMigrations()
    await runMigrations()
    const applied = await getAppliedMigrations()
    // Should not double-apply
    const counts: Record<string, number> = {}
    for (const m of applied) {
      counts[m] = (counts[m] || 0) + 1
    }
    for (const [name, count] of Object.entries(counts)) {
      expect(count).toBe(1)
    }
  })
})
```

- [ ] **Step 2: Write migration SQL files**

`src/db/migrations/001_create_tenants.sql`:
```sql
CREATE TABLE IF NOT EXISTS tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free',
  settings    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
```

`src/db/migrations/002_create_users.sql`:
```sql
CREATE TABLE IF NOT EXISTS users (
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
```

`src/db/migrations/003_create_provider_configs.sql`:
```sql
CREATE TABLE IF NOT EXISTS provider_configs (
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
```

`src/db/migrations/004_create_sessions.sql`:
```sql
CREATE TABLE IF NOT EXISTS sessions (
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
```

`src/db/migrations/005_create_conversation_messages.sql`:
```sql
CREATE TABLE IF NOT EXISTS conversation_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  role              TEXT NOT NULL,
  content           JSONB NOT NULL,
  model             TEXT,
  parent_tool_use_id TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);
```

`src/db/migrations/006_create_audit_logs.sql`:
```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  user_id     UUID,
  action      TEXT NOT NULL,
  resource    TEXT,
  details     JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now()
);
```

`src/db/migrations/007_create_tenant_usage.sql`:
```sql
CREATE TABLE IF NOT EXISTS tenant_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  date            DATE NOT NULL,
  input_tokens    BIGINT DEFAULT 0,
  output_tokens   BIGINT DEFAULT 0,
  request_count   INT DEFAULT 0,
  UNIQUE(tenant_id, date)
);
```

`src/db/migrations/008_create_teams.sql`:
```sql
CREATE TABLE IF NOT EXISTS teams (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  description     TEXT,
  lead_agent_id   TEXT,
  lead_session_id UUID REFERENCES sessions(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS team_members (
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
```

`src/db/migrations/009_create_indexes.sql`:
```sql
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_user ON sessions(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_session ON conversation_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_tenant ON conversation_messages(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tenant_usage_tenant_date ON tenant_usage(tenant_id, date);
```

- [ ] **Step 3: Write migration runner**

```typescript
// src/db/migrate.ts
import { readdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getDbClient } from './client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, 'migrations')

export async function runMigrations(): Promise<void> {
  const db = getDbClient()

  // Create migrations tracking table
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id        SERIAL PRIMARY KEY,
      name      TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `)

  // Get already-applied migrations
  const { rows } = await db.query('SELECT name FROM _migrations ORDER BY name')
  const applied = new Set(rows.map((r: { name: string }) => r.name))

  // Read migration files
  const files = await readdir(MIGRATIONS_DIR)
  const sqlFiles = files
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of sqlFiles) {
    if (applied.has(file)) continue

    const sql = await Bun.file(join(MIGRATIONS_DIR, file)).text()
    console.log(`[DB] Applying migration: ${file}`)

    await db.query('BEGIN')
    try {
      await db.query(sql)
      await db.query('INSERT INTO _migrations (name) VALUES ($1)', [file])
      await db.query('COMMIT')
      console.log(`[DB] Applied: ${file}`)
    } catch (err) {
      await db.query('ROLLBACK')
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export async function getAppliedMigrations(): Promise<string[]> {
  const db = getDbClient()
  const { rows } = await db.query('SELECT name FROM _migrations ORDER BY name')
  return rows.map((r: { name: string }) => r.name)
}
```

- [ ] **Step 4: Run test**

Run: `bun test src/db/__tests__/migrate.test.ts`
Expected: PASS (if DATABASE_URL set) or SKIP (if not)

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate.ts src/db/migrations/ src/db/__tests__/migrate.test.ts
git commit -m "feat: add PostgreSQL migration runner with full schema"
```

---

## Task 4: Query Helpers — Tenants

**Files:**
- Create: `src/db/queries/tenants.ts`
- Create: `src/db/__tests__/queries/tenants.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/db/__tests__/queries/tenants.test.ts
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { getDbClient, closeDbClient } from '../../client.js'
import { runMigrations } from '../../migrate.js'
import { createTenant, getTenant, getTenantBySlug } from '../../queries/tenants.js'

const dbUrl = process.env.DATABASE_URL
describe.skipIf(!dbUrl)('Tenant Queries', () => {
  beforeAll(async () => {
    getDbClient()
    await runMigrations()
  })

  afterAll(async () => {
    await closeDbClient()
  })

  test('createTenant inserts and returns tenant', async () => {
    const tenant = await createTenant({ name: 'Test Corp', slug: 'test-corp' })
    expect(tenant.id).toBeDefined()
    expect(tenant.name).toBe('Test Corp')
    expect(tenant.slug).toBe('test-corp')
    expect(tenant.plan).toBe('free')
  })

  test('getTenant retrieves by id', async () => {
    const created = await createTenant({ name: 'Get Test', slug: 'get-test' })
    const fetched = await getTenant(created.id)
    expect(fetched).toBeDefined()
    expect(fetched!.name).toBe('Get Test')
  })

  test('getTenantBySlug retrieves by slug', async () => {
    await createTenant({ name: 'Slug Test', slug: 'slug-test' })
    const fetched = await getTenantBySlug('slug-test')
    expect(fetched).toBeDefined()
    expect(fetched!.name).toBe('Slug Test')
  })

  test('getTenant returns null for missing id', async () => {
    const fetched = await getTenant('00000000-0000-0000-0000-000000000000')
    expect(fetched).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/db/__tests__/queries/tenants.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

```typescript
// src/db/queries/tenants.ts
import { getDbClient } from '../client.js'

export type Tenant = {
  id: string
  name: string
  slug: string
  plan: string
  settings: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

export type CreateTenantInput = {
  name: string
  slug: string
  plan?: string
  settings?: Record<string, unknown>
}

export async function createTenant(input: CreateTenantInput): Promise<Tenant> {
  const db = getDbClient()
  const { rows } = await db.query(
    `INSERT INTO tenants (name, slug, plan, settings)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.name, input.slug, input.plan || 'free', JSON.stringify(input.settings || {})]
  )
  return rows[0]
}

export async function getTenant(id: string): Promise<Tenant | null> {
  const db = getDbClient()
  const { rows } = await db.query('SELECT * FROM tenants WHERE id = $1', [id])
  return rows[0] || null
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const db = getDbClient()
  const { rows } = await db.query('SELECT * FROM tenants WHERE slug = $1', [slug])
  return rows[0] || null
}
```

- [ ] **Step 4: Run test**

Run: `bun test src/db/__tests__/queries/tenants.test.ts`
Expected: PASS (if DATABASE_URL set with clean DB)

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/tenants.ts src/db/__tests__/queries/tenants.test.ts
git commit -m "feat: add tenant query helpers with typed CRUD"
```

---

## Task 5: Query Helpers — Users

**Files:**
- Create: `src/db/queries/users.ts`
- Create: `src/db/__tests__/queries/users.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/db/__tests__/queries/users.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { getDbClient, closeDbClient } from '../../client.js'
import { runMigrations } from '../../migrate.js'
import { createTenant } from '../../queries/tenants.js'
import { createUser, getUser, getUserByEmail } from '../../queries/users.js'

const dbUrl = process.env.DATABASE_URL
describe.skipIf(!dbUrl)('User Queries', () => {
  let tenantId: string

  beforeAll(async () => {
    getDbClient()
    await runMigrations()
    const tenant = await createTenant({ name: 'User Test', slug: 'user-test' })
    tenantId = tenant.id
  })

  afterAll(async () => {
    await closeDbClient()
  })

  test('createUser inserts and returns user', async () => {
    const user = await createUser({
      tenantId,
      email: 'alice@test.com',
      passwordHash: 'hashed_pw',
      displayName: 'Alice',
      role: 'owner',
    })
    expect(user.id).toBeDefined()
    expect(user.email).toBe('alice@test.com')
    expect(user.role).toBe('owner')
    expect(user.tenant_id).toBe(tenantId)
  })

  test('getUserByEmail finds user within tenant', async () => {
    const user = await getUserByEmail(tenantId, 'alice@test.com')
    expect(user).toBeDefined()
    expect(user!.displayName).toBe('Alice')
  })

  test('getUserByEmail returns null for wrong tenant', async () => {
    const otherTenant = await createTenant({ name: 'Other', slug: 'other-tenant-x' })
    const user = await getUserByEmail(otherTenant.id, 'alice@test.com')
    expect(user).toBeNull()
  })

  test('getUser retrieves by id', async () => {
    const created = await createUser({
      tenantId,
      email: 'bob@test.com',
      displayName: 'Bob',
    })
    const fetched = await getUser(created.id)
    expect(fetched).toBeDefined()
    expect(fetched!.email).toBe('bob@test.com')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/db/__tests__/queries/users.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

```typescript
// src/db/queries/users.ts
import { getDbClient } from '../client.js'

export type User = {
  id: string
  tenant_id: string
  email: string
  password_hash: string | null
  display_name: string | null
  role: string
  auth_providers: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

export type CreateUserInput = {
  tenantId: string
  email: string
  passwordHash?: string
  displayName?: string
  role?: string
}

export async function createUser(input: CreateUserInput): Promise<User> {
  const db = getDbClient()
  const { rows } = await db.query(
    `INSERT INTO users (tenant_id, email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.tenantId, input.email, input.passwordHash || null, input.displayName || null, input.role || 'member']
  )
  return rows[0]
}

export async function getUser(id: string): Promise<User | null> {
  const db = getDbClient()
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id])
  return rows[0] || null
}

export async function getUserByEmail(tenantId: string, email: string): Promise<User | null> {
  const db = getDbClient()
  const { rows } = await db.query(
    'SELECT * FROM users WHERE tenant_id = $1 AND email = $2',
    [tenantId, email]
  )
  return rows[0] || null
}
```

- [ ] **Step 4: Run test**

Run: `bun test src/db/__tests__/queries/users.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/users.ts src/db/__tests__/queries/users.test.ts
git commit -m "feat: add user query helpers with tenant scoping"
```

---

## Task 6: Query Helpers — Sessions, Provider Configs, Other Tables

**Files:**
- Create: `src/db/queries/sessions.ts`
- Create: `src/db/queries/providerConfigs.ts`
- Create: `src/db/queries/conversationMessages.ts`
- Create: `src/db/queries/auditLogs.ts`
- Create: `src/db/queries/tenantUsage.ts`
- Create: `src/db/queries/teams.ts`
- Create: `src/db/queries/index.ts`

Follow the same TDD pattern as Tasks 4-5 for each query module. Each module follows this structure:

- `sessions.ts`: `createSession`, `getSession`, `listSessions(tenantId, userId)`, `updateSession`, `deleteSession`
- `providerConfigs.ts`: `createProviderConfig`, `listProviderConfigs(tenantId)`, `getProviderConfig`, `activateProvider(tenantId, providerId)`, `deleteProviderConfig`
- `conversationMessages.ts`: `addMessage`, `getSessionMessages(sessionId, tenantId)`, `getRecentMessages(sessionId, tenantId, limit)`
- `auditLogs.ts`: `logAuditEvent`, `listAuditLogs(tenantId, options)`
- `tenantUsage.ts`: `upsertDailyUsage`, `getUsage(tenantId, dateRange)`
- `teams.ts`: `createTeam`, `getTeam`, `listTeams(tenantId)`, `addTeamMember`, `removeTeamMember`

Each query always includes `tenantId` in WHERE clauses for isolation.

`src/db/queries/index.ts`:
```typescript
export * from './tenants.js'
export * from './users.js'
export * from './sessions.js'
export * from './providerConfigs.js'
export * from './conversationMessages.js'
export * from './auditLogs.js'
export * from './tenantUsage.js'
export * from './teams.js'
```

- [ ] **Step: Write each query module with tests, run, commit per module**

Commit message pattern: `feat: add {module} query helpers`

---

## Task 7: Request Context and Auth Middleware

**Files:**
- Create: `src/server/middleware/context.ts`
- Modify: `src/server/middleware/auth.ts`
- Create: `src/server/__tests__/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/__tests__/auth.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { extractRequestContext, type RequestContext } from '../middleware/context.js'

describe('Request Context', () => {
  beforeEach(() => {
    delete process.env.CC_MODE
  })

  test('local mode returns static context', () => {
    process.env.CC_MODE = 'local'
    const ctx = extractRequestContext(new Request('http://localhost/api/sessions'))
    expect(ctx.tenantId).toBe('local')
    expect(ctx.userId).toBe('local')
    expect(ctx.role).toBe('owner')
  })

  test('saas mode without JWT returns null', () => {
    process.env.CC_MODE = 'saas'
    const ctx = extractRequestContext(new Request('http://localhost/api/sessions'))
    expect(ctx).toBeNull()
  })

  test('default mode (no CC_MODE) returns local context', () => {
    const ctx = extractRequestContext(new Request('http://localhost/api/sessions'))
    expect(ctx.tenantId).toBe('local')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/__tests__/auth.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

```typescript
// src/server/middleware/context.ts
export type RequestContext = {
  tenantId: string
  userId: string
  role: 'owner' | 'admin' | 'member'
}

const LOCAL_CONTEXT: RequestContext = {
  tenantId: 'local',
  userId: 'local',
  role: 'owner',
}

export function isSaasMode(): boolean {
  return process.env.CC_MODE === 'saas'
}

export function extractRequestContext(req: Request): RequestContext | null {
  if (!isSaasMode()) {
    return LOCAL_CONTEXT
  }

  // In saas mode, extract from JWT — will be implemented in Phase 2
  // For now, return null to indicate auth is required but not yet implemented
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }

  // Phase 2 will replace this with JWT verification
  return null
}

export function localContext(): RequestContext {
  return LOCAL_CONTEXT
}
```

- [ ] **Step 4: Update auth middleware**

Modify `src/server/middleware/auth.ts`:
```typescript
import { isSaasMode, extractRequestContext } from './context.js'

/**
 * Authentication middleware
 *
 * CC_MODE=local: validates against ANTHROPIC_API_KEY (current behavior)
 * CC_MODE=saas: validates JWT and extracts RequestContext (Phase 2)
 */

export function validateAuth(req: Request): { valid: boolean; error?: string } {
  // In saas mode, JWT auth will be handled by context extraction (Phase 2)
  // For now, keep the existing API key validation for local mode
  const authHeader = req.headers.get('Authorization')

  if (!authHeader) {
    return { valid: false, error: 'Missing Authorization header' }
  }

  const [scheme, token] = authHeader.split(' ')

  if (scheme !== 'Bearer' || !token) {
    return { valid: false, error: 'Invalid Authorization format. Use: Bearer <token>' }
  }

  // In saas mode, the token is a JWT — validation happens via extractRequestContext in Phase 2
  if (isSaasMode()) {
    const ctx = extractRequestContext(req)
    if (!ctx) {
      return { valid: false, error: 'Invalid or expired JWT' }
    }
    return { valid: true }
  }

  // Local mode: validate against ANTHROPIC_API_KEY
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { valid: false, error: 'Server ANTHROPIC_API_KEY not configured' }
  }

  if (token !== apiKey) {
    return { valid: false, error: 'Invalid API key' }
  }

  return { valid: true }
}

export function requireAuth(req: Request): Response | null {
  const { valid, error } = validateAuth(req)
  if (!valid) {
    return Response.json({ error: 'Unauthorized', message: error }, { status: 401 })
  }
  return null
}
```

- [ ] **Step 5: Run test**

Run: `bun test src/server/__tests__/auth.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/middleware/context.ts src/server/middleware/auth.ts src/server/__tests__/auth.test.ts
git commit -m "feat: add CC_MODE-aware request context and auth middleware"
```

---

## Task 8: Server Startup — DB Init for SaaS Mode

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add DB initialization on server startup**

Add to `src/server/index.ts` at the top of `startServer()`:

```typescript
import { isSaasMode } from './middleware/context.js'

// Inside startServer(), after ProviderService.setServerPort(port):
if (isSaasMode()) {
  const { getDbClient } = await import('../db/client.js')
  const { runMigrations } = await import('../db/migrate.js')
  console.log('[Server] SaaS mode — connecting to PostgreSQL...')
  const db = getDbClient()
  await runMigrations()
  console.log('[Server] Database migrations applied')
  // Verify connection
  const result = await db.query('SELECT 1')
  if (!result.rows.length) {
    throw new Error('Database connection test failed')
  }
  console.log('[Server] Database connected')
}
```

Note: the `await import()` dynamic import ensures the DB module is only loaded in saas mode, so local mode requires zero PostgreSQL dependencies at runtime.

- [ ] **Step 2: Test that local mode still works without DATABASE_URL**

Run: `CC_MODE=local bun run src/server/index.ts &`
Wait 2 seconds, then:
```bash
curl -s http://127.0.0.1:3456/health | head -1
```
Expected: `{"status":"ok",...}`
Kill the server process.

- [ ] **Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: add DB initialization on server startup (saas mode only)"
```

---

## Task 9: Integration Test — Full Phase 1 Smoke Test

**Files:**
- Create: `src/db/__tests__/integration.test.ts`

- [ ] **Step 1: Write full integration test**

```typescript
// src/db/__tests__/integration.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { getDbClient, closeDbClient } from '../client.js'
import { runMigrations } from '../migrate.js'
import * as queries from '../queries/index.js'

const dbUrl = process.env.DATABASE_URL
describe.skipIf(!dbUrl)('Phase 1 Integration', () => {
  beforeAll(async () => {
    getDbClient()
    await runMigrations()
  })

  afterAll(async () => {
    await closeDbClient()
  })

  test('full CRUD lifecycle: tenant → user → session → message', async () => {
    // Create tenant
    const tenant = await queries.createTenant({ name: 'Integration Corp', slug: 'int-corp' })
    expect(tenant.id).toBeDefined()

    // Create user
    const user = await queries.createUser({
      tenantId: tenant.id,
      email: 'dev@int-corp.com',
      displayName: 'Dev',
      role: 'owner',
    })
    expect(user.tenant_id).toBe(tenant.id)

    // Create session
    const session = await queries.createSession({
      tenantId: tenant.id,
      userId: user.id,
      workDir: '/workspace',
    })
    expect(session.tenant_id).toBe(tenant.id)

    // Add conversation message
    await queries.addMessage({
      sessionId: session.id,
      tenantId: tenant.id,
      role: 'user',
      content: { text: 'Hello' },
    })

    // Retrieve messages
    const messages = await queries.getSessionMessages(session.id, tenant.id)
    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe('user')

    // List sessions for tenant
    const sessions = await queries.listSessions(tenant.id, user.id)
    expect(sessions.length).toBe(1)

    // Audit log
    await queries.logAuditEvent({
      tenantId: tenant.id,
      userId: user.id,
      action: 'session.created',
      resource: `session/${session.id}`,
    })

    const logs = await queries.listAuditLogs(tenant.id, { limit: 10 })
    expect(logs.length).toBe(1)
  })

  test('tenant isolation: tenant B cannot see tenant A data', async () => {
    const tenantA = await queries.createTenant({ name: 'Corp A', slug: 'corp-a' })
    const tenantB = await queries.createTenant({ name: 'Corp B', slug: 'corp-b' })

    await queries.createProviderConfig({
      tenantId: tenantA.id,
      name: 'A provider',
      type: 'anthropic',
    })

    const bProviders = await queries.listProviderConfigs(tenantB.id)
    expect(bProviders.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run integration test**

Run: `DATABASE_URL=postgres://cc_haha:password@localhost:5432/cc_haha_test bun test src/db/__tests__/integration.test.ts`
Expected: PASS (requires running PostgreSQL)

- [ ] **Step 3: Commit**

```bash
git add src/db/__tests__/integration.test.ts
git commit -m "test: add Phase 1 integration test (tenant CRUD, isolation)"
```

---

## Self-Review Checklist

After completing all tasks, verify:

- [ ] `CC_MODE=local` — server starts without DATABASE_URL, all existing tests pass
- [ ] `CC_MODE=saas` with DATABASE_URL — server connects to PostgreSQL, runs migrations
- [ ] All query helpers enforce tenant_id scoping — no query can return cross-tenant data
- [ ] Auth middleware works in both modes — API key for local, JWT placeholder for saas
- [ ] Dynamic imports ensure DB module is never loaded in local mode
