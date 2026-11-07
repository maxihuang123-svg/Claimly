import { existsSync, readFileSync } from 'node:fs';

// KEY=value lines from .env.local. Real environment variables win, so a deploy can override the file.
// Node only: on Cloudflare the same names are Worker variables and secrets (wrangler.toml).
export function readEnv(path) {
  const fromFile = existsSync(path) ? Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, value.replace(/^["']|["']$/g, '')])) : {};
  return { ...fromFile, ...process.env };
}
