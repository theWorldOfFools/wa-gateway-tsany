import type { Db } from '../db/index.js';
import type { Tenant } from '../domain.js';

interface TenantRow {
  id: string;
  name: string;
  created_at: Date;
}

const mapTenant = (row: TenantRow): Tenant => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at
});

export async function createTenant(db: Db, id: string, name: string): Promise<Tenant> {
  const result = await db.query<TenantRow>(
    'INSERT INTO tenants (id, name) VALUES ($1, $2) RETURNING *',
    [id, name]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create tenant');
  return mapTenant(row);
}

export async function getTenant(db: Db, id: string): Promise<Tenant | null> {
  const result = await db.query<TenantRow>('SELECT * FROM tenants WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? mapTenant(row) : null;
}
