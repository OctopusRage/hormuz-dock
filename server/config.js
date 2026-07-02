import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const REPOS_DIR = path.join(DATA_DIR, 'repos');
export const DB_FILE = path.join(DATA_DIR, 'db.json');
export const PORT = process.env.PORT || 4100;

// Compose files we accept, in order of preference. docker-compose.yml is required
// by spec but we tolerate the common alternatives too.
export const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];
