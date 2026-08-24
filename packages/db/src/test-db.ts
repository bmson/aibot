import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for test database preparation.');
if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to reset a test database with NODE_ENV=production.');
}

const target = new URL(databaseUrl);
const database = decodeURIComponent(target.pathname.replace(/^\//, ''));
if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(database) || !database.endsWith('_test')) {
  throw new Error('The test database name must end in _test.');
}

target.pathname = '/postgres';
const admin = postgres(target.toString(), { max: 1, onnotice: () => {} });

try {
  // Tests are integration-heavy and some terminal paths write notifications.
  // Reusing a previous run lets a failed cleanup affect the next assertion, so
  // reset only the explicit, suffix-validated test database before migrations.
  await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${database}"`);
} finally {
  await admin.end({ timeout: 5 });
}
