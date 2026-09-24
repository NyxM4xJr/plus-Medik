import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

/**
 * Postgres en memoria con todas las migraciones del repo aplicadas en orden.
 * Nunca se conecta a Supabase: sirve para probar el SQL real sin db push.
 */
export async function createTestDatabase(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { pgcrypto, pg_trgm } });

  // Roles y esquema que Supabase trae de fábrica.
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema if not exists extensions;
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    } catch (error) {
      throw new Error(`migration ${file}: ${error instanceof Error ? error.message : error}`);
    }
  }

  return db;
}
