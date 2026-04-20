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
