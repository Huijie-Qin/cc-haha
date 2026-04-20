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
