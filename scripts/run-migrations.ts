import { readFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'false' ? false : 'require'
});

const migrations = [
  '000_create_whatsapp_messages.sql',
  '001_create_broadcast_guard.sql',
  '002_add_atomic_lock_index.sql',
  '003_create_pending_responses.sql',
  '004_create_tavily_searches.sql',
  '005_create_whatsapp_auth_state.sql'
];

async function runMigrations() {
  console.log('Running migrations...');
  
  for (const migration of migrations) {
    const filePath = join(process.cwd(), 'migrations', migration);
    const migrationSQL = readFileSync(filePath, 'utf-8');
    
    console.log(`Running: ${migration}`);
    try {
      await sql.unsafe(migrationSQL);
      console.log(`✓ ${migration}`);
    } catch (error: any) {
      if (error.code === '42P07') {
        console.log(`⊘ ${migration} (already exists)`);
      } else {
        console.error(`✗ ${migration}:`, error.message);
        throw error;
      }
    }
  }
  
  console.log('All migrations completed!');
  await sql.end();
}

runMigrations().catch(error => {
  console.error('Migration failed:', error);
  process.exit(1);
});
