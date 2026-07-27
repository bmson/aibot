import { loadConfig } from '@assistant/config';
import { defineConfig } from 'drizzle-kit';

const config = loadConfig();

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: config.DATABASE_URL,
  },
});
