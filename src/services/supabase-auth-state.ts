/**
 * PostgreSQL-backed Auth State for Baileys
 *
 * Replaces useMultiFileAuthState with database storage for better reliability.
 * Reduces file I/O which can cause issues with connection stability.
 */

import { AuthenticationCreds, SignalDataTypeMap, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { getDb } from '../db';

const AUTH_TABLE = 'whatsapp_auth_state';

async function ensureAuthTable(): Promise<boolean> {
  try {
    const sql = getDb();
    await sql`SELECT key FROM ${sql(AUTH_TABLE)} LIMIT 1`;
    return true;
  } catch (err: any) {
    if (err.code === '42P01') {
      console.log('[AUTH-DB] Auth table does not exist. Please create it with:');
      console.log(`
CREATE TABLE ${AUTH_TABLE} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
      `);
      return false;
    }
    console.error('[AUTH-DB] Error checking auth table:', err);
    return false;
  }
}

async function readData(key: string): Promise<any | null> {
  try {
    const sql = getDb();
    const rows = await sql<{ value: string }[]>`
      SELECT value FROM ${sql(AUTH_TABLE)} WHERE key = ${key}
    `;
    if (rows.length === 0) return null;
    return JSON.parse(rows[0].value, BufferJSON.reviver);
  } catch (err) {
    console.error(`[AUTH-DB] Error reading ${key}:`, err);
    return null;
  }
}

async function writeData(key: string, value: any): Promise<void> {
  try {
    const sql = getDb();
    const serialized = JSON.stringify(value, BufferJSON.replacer);
    await sql`
      INSERT INTO ${sql(AUTH_TABLE)} (key, value, updated_at)
      VALUES (${key}, ${serialized}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  } catch (err) {
    console.error(`[AUTH-DB] Error writing ${key}:`, err);
  }
}

async function removeData(key: string): Promise<void> {
  try {
    const sql = getDb();
    await sql`DELETE FROM ${sql(AUTH_TABLE)} WHERE key = ${key}`;
  } catch (err) {
    console.error(`[AUTH-DB] Error deleting ${key}:`, err);
  }
}

export async function useSupabaseAuthState(): Promise<{
  state: { creds: AuthenticationCreds; keys: any };
  saveCreds: () => Promise<void>;
} | null> {
  const tableExists = await ensureAuthTable();
  if (!tableExists) {
    console.error('[AUTH-DB] Cannot use DB auth state - table not available');
    return null;
  }

  console.log('[AUTH-DB] Using PostgreSQL-backed auth state');

  let creds = await readData('creds');
  if (!creds) {
    console.log('[AUTH-DB] No existing credentials, initializing new ones');
    creds = initAuthCreds();
    await writeData('creds', creds);
  } else {
    console.log('[AUTH-DB] Loaded existing credentials from database');
  }

  const keys = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Promise<{ [key: string]: SignalDataTypeMap[T] }> => {
      const result: { [key: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        const data = await readData(`${type}-${id}`);
        if (data) result[id] = data;
      }
      return result;
    },

    set: async (data: any): Promise<void> => {
      const tasks: Promise<void>[] = [];
      for (const category in data) {
        for (const id in data[category]) {
          const value = data[category][id];
          const key = `${category}-${id}`;
          tasks.push(value ? writeData(key, value) : removeData(key));
        }
      }
      await Promise.all(tasks);
    },
  };

  const saveCreds = async (): Promise<void> => {
    await writeData('creds', creds);
  };

  return { state: { creds, keys }, saveCreds };
}

export async function isSupabaseAuthAvailable(): Promise<boolean> {
  try {
    const sql = getDb();
    await sql`SELECT key FROM ${sql(AUTH_TABLE)} LIMIT 1`;
    return true;
  } catch (err: any) {
    return err.code !== '42P01' ? false : false;
  }
}

export async function migrateFileAuthToSupabase(authFolder: string): Promise<boolean> {
  const fs = await import('fs').then(m => m.promises);
  const path = await import('path');

  try {
    const credsPath = path.join(authFolder, 'creds.json');
    try {
      const credsData = await fs.readFile(credsPath, 'utf-8');
      const creds = JSON.parse(credsData, BufferJSON.reviver);
      await writeData('creds', creds);
      console.log('[AUTH-DB] Migrated credentials to database');
    } catch (err: any) {
      if (err.code !== 'ENOENT') console.error('[AUTH-DB] Error reading creds.json:', err);
    }

    const files = await fs.readdir(authFolder);
    let migratedCount = 0;

    for (const file of files) {
      if (file === 'creds.json' || !file.endsWith('.json')) continue;
      try {
        const data = await fs.readFile(path.join(authFolder, file), 'utf-8');
        await writeData(file.slice(0, -5), JSON.parse(data, BufferJSON.reviver));
        migratedCount++;
      } catch (err) {
        console.error(`[AUTH-DB] Error migrating ${file}:`, err);
      }
    }

    console.log(`[AUTH-DB] Migrated ${migratedCount} key files to database`);
    return true;
  } catch (err) {
    console.error('[AUTH-DB] Migration failed:', err);
    return false;
  }
}
