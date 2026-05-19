#!/usr/bin/env node

/**
 * After `npm install -g`, automatically install the skill into every detected AI coding tool.
 *
 * Prefer `npx skills add` (Vercel Labs) so the skill is registered across all tools at once.
 * If that fails, fall back to manually copying the skill into the Claude Code skills directory.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillSrc = join(__dirname, '..', 'skills', 'aigateway');

if (!existsSync(skillSrc)) {
  process.exit(0);
}

// Try installing into every tool via the skills CLI
try {
  execFileSync('npx', ['skills', 'add', skillSrc, '-g', '-y', '--copy'], {
    stdio: 'inherit',
    timeout: 30000,
    cwd: join(__dirname, '..'),
  });
  console.log('✔ aigateway skill installed via skills CLI (all detected tools)');
  process.exit(0);
} catch {
  // skills CLI unavailable or failed — fall back
}

// Fallback: copy manually into Claude Code
const dest = join(homedir(), '.claude', 'skills', 'aigateway');
mkdirSync(dirname(dest), { recursive: true });
cpSync(skillSrc, dest, { recursive: true, force: true });
console.log(`✔ aigateway skill installed to ${dest} (fallback)`);
