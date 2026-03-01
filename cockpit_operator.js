#!/usr/bin/env node
import { ocrDetector, screenWatcher } from './core_binary.mjs';
import sharp from 'sharp';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SCALE = 2;
const DEFAULT_THRESHOLD = 0.66;
const STATE_DIR = path.join(process.cwd(), 'state');
const LAST_SCAN_PNG = path.join(STATE_DIR, 'cockpit_operator_last_scan.png');
const LAST_SCAN_JSON = path.join(STATE_DIR, 'cockpit_operator_last_scan.json');

function usage() {
  console.log(`
Cockpit Operator (OCR + click/type)

Usage:
  node cockpit_operator.js focus "Cockpit"
  node cockpit_operator.js scan [--contains "refresh"]
  node cockpit_operator.js click "Refresh" [--threshold 0.66] [--dry-run]
  node cockpit_operator.js type "hello world" [--select-all]
  node cockpit_operator.js key ENTER
  node cockpit_operator.js click-type "DIRECTIVE" "test message" [--submit] [--dry-run]

Notes:
  - Uses full-screen OCR to find labels and click by text.
  - Writes latest scan artifacts to:
    - state/cockpit_operator_last_scan.png
    - state/cockpit_operator_last_scan.json
`.trim());
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function getFlag(args, flag) {
  return args.includes(flag);
}

function getOption(args, name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const s = a || '';
  const t = b || '';
  const dp = Array.from({ length: s.length + 1 }, () => new Array(t.length + 1).fill(0));
  for (let i = 0; i <= s.length; i++) dp[i][0] = i;
  for (let j = 0; j <= t.length; j++) dp[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[s.length][t.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  return 1 - dist / maxLen;
}

function unionBbox(words) {
  const x0 = Math.min(...words.map((w) => w.bbox.x0));
  const y0 = Math.min(...words.map((w) => w.bbox.y0));
  const x1 = Math.max(...words.map((w) => w.bbox.x1));
  const y1 = Math.max(...words.map((w) => w.bbox.y1));
  return { x0, y0, x1, y1 };
}

function scorePhrase(phrase, target) {
  const p = normalize(phrase);
  const t = normalize(target);
  if (!p || !t) return 0;
  if (p === t) return 1;
  if (p.includes(t) || t.includes(p)) return 0.93;
  return similarity(p, t) * 0.9;
}

function extractLinesFromBlocks(blocks, scale) {
  const lines = [];
  for (const block of blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const words = [];
        for (const word of line.words || []) {
          const text = String(word.text || '').trim();
          if (!text) continue;
          words.push({
            text,
            confidence: Number(word.confidence || 0),
            bbox: {
              x0: Math.round((word.bbox?.x0 || 0) / scale),
              y0: Math.round((word.bbox?.y0 || 0) / scale),
              x1: Math.round((word.bbox?.x1 || 0) / scale),
              y1: Math.round((word.bbox?.y1 || 0) / scale),
            },
          });
        }
        if (words.length === 0) continue;
        lines.push({
          text: words.map((w) => w.text).join(' '),
          words,
          bbox: unionBbox(words),
        });
      }
    }
  }
  return lines;
}

function buildCandidates(lines, target) {
  const out = [];
  for (const line of lines) {
    const ws = line.words;
    for (let i = 0; i < ws.length; i++) {
      for (let len = 1; len <= 4 && i + len <= ws.length; len++) {
        const chunk = ws.slice(i, i + len);
        const phrase = chunk.map((w) => w.text).join(' ');
        const score = scorePhrase(phrase, target);
        if (score < 0.4) continue;
        const bbox = unionBbox(chunk);
        out.push({
          phrase,
          score,
          bbox,
          lineText: line.text,
        });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

async function runOcrFullScreen() {
  ensureStateDir();
  const screenshot = await screenWatcher.capture();
  fs.writeFileSync(LAST_SCAN_PNG, screenshot);

  const meta = await sharp(screenshot).metadata();
  const processed = await sharp(screenshot)
    .removeAlpha()
    .negate()
    .greyscale()
    .resize(Math.round(meta.width * SCALE), Math.round(meta.height * SCALE), { kernel: 'lanczos3' })
    .normalise()
    .sharpen({ sigma: 1.2 })
    .toBuffer();

  await ocrDetector.initialize();
  const result = await ocrDetector.worker.recognize(processed, {}, { blocks: true });
  const lines = extractLinesFromBlocks(result.data?.blocks || [], SCALE);

  const payload = {
    captured_at: new Date().toISOString(),
    screen: { width: screenWatcher.screenWidth, height: screenWatcher.screenHeight },
    line_count: lines.length,
    lines: lines.map((l) => ({ text: l.text, bbox: l.bbox })),
  };
  fs.writeFileSync(LAST_SCAN_JSON, JSON.stringify(payload, null, 2));
  return { lines, payload };
}

async function cmdScan(args) {
  const contains = getOption(args, '--contains', null);
  const { lines, payload } = await runOcrFullScreen();
  console.log(`Scanned ${payload.line_count} OCR lines`);
  if (!contains) {
    for (const line of lines.slice(0, 25)) {
      console.log(`- ${line.text}`);
    }
    return 0;
  }

  const cands = buildCandidates(lines, contains);
  if (cands.length === 0) {
    console.log(`No match for "${contains}"`);
    return 2;
  }
  const best = cands[0];
  const cx = Math.round((best.bbox.x0 + best.bbox.x1) / 2);
  const cy = Math.round((best.bbox.y0 + best.bbox.y1) / 2);
  console.log(`Best match "${best.phrase}" score=${best.score.toFixed(3)} at ${cx},${cy}`);
  return 0;
}

async function cmdClick(args) {
  const target = args[1];
  if (!target) throw new Error('click requires a label string');
  const dryRun = getFlag(args, '--dry-run');
  const threshold = Number(getOption(args, '--threshold', `${DEFAULT_THRESHOLD}`));
  const { lines } = await runOcrFullScreen();
  const cands = buildCandidates(lines, target);
  if (cands.length === 0 || cands[0].score < threshold) {
    throw new Error(`No confident match for "${target}" (best=${cands[0]?.score?.toFixed(3) || 'n/a'}, threshold=${threshold})`);
  }
  const best = cands[0];
  const x = Math.round((best.bbox.x0 + best.bbox.x1) / 2);
  const y = Math.round((best.bbox.y0 + best.bbox.y1) / 2);

  if (dryRun) {
    console.log(`[dry-run] click "${best.phrase}" at ${x},${y} score=${best.score.toFixed(3)}`);
    return 0;
  }
  await screenWatcher.click(x, y, 2);
  console.log(`Clicked "${best.phrase}" at ${x},${y} score=${best.score.toFixed(3)}`);
  return 0;
}

function cmdFocus(args) {
  const title = args[1];
  if (!title) throw new Error('focus requires a window title substring');
  const escaped = title.replace(/'/g, "''");
  const out = execSync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; $ok=[Microsoft.VisualBasic.Interaction]::AppActivate('${escaped}'); if($ok){'OK'}else{'NO'}"`,
    { encoding: 'utf8', timeout: 8000 }
  ).trim();
  if (out !== 'OK') throw new Error(`Could not focus window containing title: ${title}`);
  console.log(`Focused window: ${title}`);
  return 0;
}

function cmdType(args) {
  const text = args[1];
  if (typeof text !== 'string') throw new Error('type requires text');
  const dryRun = getFlag(args, '--dry-run');
  const selectAll = getFlag(args, '--select-all');
  if (dryRun) {
    console.log(`[dry-run] type ${text.length} chars`);
    return 0;
  }
  const b64 = Buffer.from(text, 'utf16le').toString('base64');
  const selectAllSend = selectAll ? "[System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 80;" : '';
  execSync(
    `powershell -NoProfile -Command "$t=[System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t; Add-Type -AssemblyName System.Windows.Forms; ${selectAllSend} [System.Windows.Forms.SendKeys]::SendWait('^v')"`,
    { timeout: 10000 }
  );
  console.log(`Typed ${text.length} chars`);
  return 0;
}

function cmdKey(args) {
  const key = String(args[1] || '').toUpperCase();
  if (!key) throw new Error('key requires a key name (e.g., ENTER)');
  const dryRun = getFlag(args, '--dry-run');
  const map = {
    ENTER: '{ENTER}',
    TAB: '{TAB}',
    ESC: '{ESC}',
    ESCAPE: '{ESC}',
    F5: '{F5}',
  };
  const send = map[key];
  if (!send) throw new Error(`Unsupported key: ${key}`);
  if (dryRun) {
    console.log(`[dry-run] key ${key}`);
    return 0;
  }
  execSync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${send}')"`,
    { timeout: 8000 }
  );
  console.log(`Sent key ${key}`);
  return 0;
}

async function cmdClickType(args) {
  const label = args[1];
  const text = args[2];
  if (!label || typeof text !== 'string') {
    throw new Error('click-type requires: <label> <text>');
  }
  const dryRun = getFlag(args, '--dry-run');
  const submit = getFlag(args, '--submit');
  const selectAll = getFlag(args, '--select-all');
  const threshold = Number(getOption(args, '--threshold', `${DEFAULT_THRESHOLD}`));

  const { lines } = await runOcrFullScreen();
  const cands = buildCandidates(lines, label);
  if (cands.length === 0 || cands[0].score < threshold) {
    throw new Error(`No confident match for "${label}" (best=${cands[0]?.score?.toFixed(3) || 'n/a'}, threshold=${threshold})`);
  }
  const best = cands[0];
  const x = Math.round((best.bbox.x0 + best.bbox.x1) / 2);
  const y = Math.round((best.bbox.y0 + best.bbox.y1) / 2);

  if (dryRun) {
    console.log(`[dry-run] click-type "${best.phrase}" at ${x},${y}; type ${text.length} chars${submit ? '; submit ENTER' : ''}`);
    return 0;
  }

  await screenWatcher.click(x, y, 2);
  await new Promise((r) => setTimeout(r, 180));
  cmdType(['type', text, ...(selectAll ? ['--select-all'] : [])]);
  if (submit) {
    await new Promise((r) => setTimeout(r, 120));
    cmdKey(['key', 'ENTER']);
  }
  console.log(`click-type completed on "${best.phrase}"`);
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(0);
  }
  let code = 0;
  try {
    if (cmd === 'scan') code = await cmdScan(args);
    else if (cmd === 'click') code = await cmdClick(args);
    else if (cmd === 'focus') code = cmdFocus(args);
    else if (cmd === 'type') code = cmdType(args);
    else if (cmd === 'key') code = cmdKey(args);
    else if (cmd === 'click-type') code = await cmdClickType(args);
    else {
      usage();
      code = 2;
    }
  } finally {
    await ocrDetector.terminate().catch(() => {});
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
