import type { Db } from '../db/index.js';
import type { User } from '../domain.js';

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  name: string | null;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

const mapUser = (row: UserRow): User => ({
  id: row.id,
  tenantId: row.tenant_id,
  email: row.email,
  name: row.name,
  passwordHash: row.password_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastLoginAt: row.last_login_at
});

export interface CreateUserInput {
  id: string;
  tenantId: string;
  email: string;
  name?: string | null;
  passwordHash: string;
}

export async function createUser(db: Db, input: CreateUserInput): Promise<User> {
  const result = await db.query<UserRow>(
    `INSERT INTO users (id, tenant_id, email, name, password_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.id, input.tenantId, input.email, input.name ?? null, input.passwordHash]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create user');
  return mapUser(row);
}

export async function getUserByEmail(db: Db, email: string): Promise<User | null> {
  const result = await db.query<UserRow>(
    'SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1',
    [email]
  );
  const row = result.rows[0];
  return row ? mapUser(row) : null;
}

export async function getUserById(db: Db, id: string): Promise<User | null> {
  const result = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? mapUser(row) : null;
}

export async function updateUserPassword(
  db: Db,
  userId: string,
  passwordHash: string
): Promise<void> {
  await db.query(
    `UPDATE users
     SET password_hash = $2, updated_at = now()
     WHERE id = $1`,
    [userId, passwordHash]
  );
}

export async function markUserLogin(db: Db, userId: string): Promise<void> {
  await db.query(
    `UPDATE users
     SET last_login_at = now(), updated_at = now()
     WHERE id = $1`,
    [userId]
  );
}
