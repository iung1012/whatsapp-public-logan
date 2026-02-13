/**
 * Supabase-backed Auth State for Baileys
 *
 * Replaces useMultiFileAuthState with database storage for better reliability.
 * Reduces file I/O which can cause issues with connection stability.
 */

import { AuthenticationCreds, SignalDataTypeMap, initAuthCreds, proto, BufferJSON } from '@whiskeysockets/baileys';
import { getSupabaseClient } from '../supabase';

const AUTH_TABLE = 'whatsapp_auth_state';

interface AuthStateRow {
  key: string;
  value: string;
  updated_at: string;
}

/**
 * Create the auth state table if it doesn't exist
 * This is a one-time setup - the table persists across restarts
 */
async function ensureAuthTable(): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error('[AUTH-DB] Supabase client not available');
    return false;
  }

  try {
    // Check if table exists by trying to select from it
    const { error } = await supabase
      .from(AUTH_TABLE)
      .select('key')
      .limit(1);

    if (error && error.code === '42P01') {
      // Table doesn't exist - it needs to be created via SQL
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

    return true;
  } catch (err) {
    console.error('[AUTH-DB] Error checking auth table:', err);
    return false;
  }
}

/**
 * Read a value from the auth state table
 */
async function readData(key: string): Promise<any | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from(AUTH_TABLE)
      .select('value')
      .eq('key', key)
      .single();

    if (error || !data) return null;

    return JSON.parse(data.value, BufferJSON.reviver);
  } catch (err) {
    console.error(`[AUTH-DB] Error reading ${key}:`, err);
    return null;
  }
}

/**
 * Write a value to the auth state table
 */
async function writeData(key: string, value: any): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const serialized = JSON.stringify(value, BufferJSON.replacer);

    const { error } = await supabase
      .from(AUTH_TABLE)
      .upsert({
        key,
        value: serialized,
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' });

    if (error) {
      console.error(`[AUTH-DB] Error writing ${key}:`, error);
    }
  } catch (err) {
    console.error(`[AUTH-DB] Error writing ${key}:`, err);
  }
}

/**
 * Delete a value from the auth state table
 */
async function removeData(key: string): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase
      .from(AUTH_TABLE)
      .delete()
      .eq('key', key);

    if (error) {
      console.error(`[AUTH-DB] Error deleting ${key}:`, error);
    }
  } catch (err) {
    console.error(`[AUTH-DB] Error deleting ${key}:`, err);
  }
}

/**
 * Use Supabase as the auth state storage
 * Drop-in replacement for useMultiFileAuthState
 */
export async function useSupabaseAuthState(): Promise<{
  state: { creds: AuthenticationCreds; keys: any };
  saveCreds: () => Promise<void>;
} | null> {
  // Check if table exists
  const tableExists = await ensureAuthTable();
  if (!tableExists) {
    console.error('[AUTH-DB] Cannot use Supabase auth state - table not available');
    return null;
  }

  console.log('[AUTH-DB] Using Supabase-backed auth state');

  // Load or initialize credentials
  let creds = await readData('creds');
  if (!creds) {
    console.log('[AUTH-DB] No existing credentials, initializing new ones');
    creds = initAuthCreds();
    await writeData('creds', creds);
  } else {
    console.log('[AUTH-DB] Loaded existing credentials from database');
  }

  // Create the keys store with database backing
  const keys = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Promise<{ [key: string]: SignalDataTypeMap[T] }> => {
      const result: { [key: string]: SignalDataTypeMap[T] } = {};

      for (const id of ids) {
        const key = `${type}-${id}`;
        const data = await readData(key);
        if (data) {
          result[id] = data;
        }
      }

      return result;
    },

    set: async (data: any): Promise<void> => {
      const tasks: Promise<void>[] = [];

      for (const category in data) {
        for (const id in data[category]) {
          const value = data[category][id];
          const key = `${category}-${id}`;

          if (value) {
            tasks.push(writeData(key, value));
          } else {
            tasks.push(removeData(key));
          }
        }
      }

      await Promise.all(tasks);
    }
  };

  // Function to save credentials
  const saveCreds = async (): Promise<void> => {
    await writeData('creds', creds);
  };

  return {
    state: { creds, keys },
    saveCreds
  };
}

/**
 * Check if Supabase auth state is available
 */
export async function isSupabaseAuthAvailable(): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) return false;

  try {
    const { error } = await supabase
      .from(AUTH_TABLE)
      .select('key')
      .limit(1);

    return !error || error.code !== '42P01';
  } catch {
    return false;
  }
}

/**
 * Migrate existing file-based auth to Supabase
 * Run this once to move your auth from files to database
 */
export async function migrateFileAuthToSupabase(authFolder: string): Promise<boolean> {
  const fs = await import('fs').then(m => m.promises);
  const path = await import('path');

  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error('[AUTH-DB] Supabase client not available for migration');
    return false;
  }

  try {
    // Check if creds.json exists
    const credsPath = path.join(authFolder, 'creds.json');

    try {
      const credsData = await fs.readFile(credsPath, 'utf-8');
      const creds = JSON.parse(credsData, BufferJSON.reviver);
      await writeData('creds', creds);
      console.log('[AUTH-DB] Migrated credentials to Supabase');
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[AUTH-DB] Error reading creds.json:', err);
      }
    }

    // Migrate app-state-sync keys
    const files = await fs.readdir(authFolder);
    let migratedCount = 0;

    for (const file of files) {
      if (file === 'creds.json') continue;
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(authFolder, file);
        const data = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(data, BufferJSON.reviver);

        // Extract key name from filename (remove .json)
        const keyName = file.slice(0, -5);
        await writeData(keyName, parsed);
        migratedCount++;
      } catch (err) {
        console.error(`[AUTH-DB] Error migrating ${file}:`, err);
      }
    }

    console.log(`[AUTH-DB] Migrated ${migratedCount} key files to Supabase`);
    return true;
  } catch (err) {
    console.error('[AUTH-DB] Migration failed:', err);
    return false;
  }
}
