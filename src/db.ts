import postgres from 'postgres';

let sqlInstance: postgres.Sql | null = null;

export function initDb(): postgres.Sql {
  if (sqlInstance) return sqlInstance;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Missing DATABASE_URL environment variable');
  }

  // SSL: disabled if DATABASE_SSL=false (local dev), otherwise requires SSL (Railway/production)
  const ssl = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };

  sqlInstance = postgres(url, {
    ssl,
    max: 10,
    idle_timeout: 30,
  });

  console.log(`[${new Date().toISOString()}] Database client initialized`);
  return sqlInstance;
}

export function getDb(): postgres.Sql {
  if (!sqlInstance) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return sqlInstance;
}
