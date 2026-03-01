#!/usr/bin/env node
import { autoClicker, buttonProfileStore } from './core_binary.mjs';
/**
 * VLM Auto-Clicker — Start script
 *
 * Watches for IDE accept/apply buttons and clicks them automatically.
 * Uses OpenRouter for VLM teacher (first learn), then Tesseract OCR runs free locally.
 *
 * Usage:
 *   node start.js                          # defaults: vscode, poll 1.5s
 *   node start.js --ide cursor             # cursor IDE
 *   node start.js --dry-run                # detect but don't click
 *   node start.js --debug                  # save screenshots + log OCR
 *   node start.js --poll 2000              # poll every 2s
 *
 * Env:
 *   OPENROUTER_API_KEY  — required for first learning pass (VLM teacher)
 *   VLM_MODEL           — optional, default: openai/gpt-4o-mini
 */

import fs from 'fs';
import path from 'path';

// ─── Parse args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (typeof fallback === 'boolean') return true;
  return args[idx + 1] || fallback;
}

const ide = getArg('ide', 'vscode');
const dryRun = getArg('dry-run', false);
const debug = getArg('debug', false);
const pollMs = parseInt(getArg('poll', '1500'), 10);

// ─── Find API key ───────────────────────────────────────────────────────────

let apiKey = process.env.OPENROUTER_API_KEY;

// Check common .env locations if not set
if (!apiKey) {
  const envPaths = [
    path.join(process.cwd(), '.env'),
    'C:\\AI OS\\.env',
    path.join(process.env.USERPROFILE || '', '.env')
  ];
  for (const envPath of envPaths) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/OPENROUTER_API_KEY\s*=\s*(.+)/);
      if (match) {
        apiKey = match[1].trim();
        console.log(`[start] Found API key in ${envPath}`);
        break;
      }
    } catch { /* skip */ }
  }
}

const hasExistingProfile = buttonProfileStore.hasProfile(ide);
if (!apiKey && !hasExistingProfile) {
  console.error('[start] No OPENROUTER_API_KEY found and no learned profile exists for this IDE.');
  console.error('[start] Set OPENROUTER_API_KEY for the first learning pass.');
  process.exit(1);
}

const model = process.env.VLM_MODEL || 'openai/gpt-4o-mini';

// ─── Configure and start ────────────────────────────────────────────────────

console.log(`[start] VLM Auto-Clicker starting`);
console.log(`[start]   IDE: ${ide}`);
console.log(`[start]   Model: ${model} (via OpenRouter)`);
console.log(`[start]   Poll: ${pollMs}ms`);
console.log(`[start]   Dry run: ${dryRun}`);
console.log(`[start]   Debug: ${debug}`);
if (!apiKey && hasExistingProfile) {
  console.log(`[start]   Mode: OCR-only (existing profile for ${ide}, no VLM key needed)`);
}
console.log('');

autoClicker.configure({
  enabled: true,
  ide,
  pollIntervalMs: pollMs,
  vlm: {
    model,
    apiKey,
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    maxCallsPerDay: 20,
    maxCallsPerSession: 10
  },
  debug: {
    dryRun,
    saveScreenshots: debug,
    logOcrResults: debug
  }
});

await autoClicker.start();

// ─── Graceful shutdown ──────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\n[start] Shutting down...');
  await autoClicker.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await autoClicker.stop();
  process.exit(0);
});

// Keep alive
console.log('[start] Running. Ctrl+C to stop.');
