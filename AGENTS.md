# AGENTS.md — VLM Auto-Clicker

## Goal

Keep VLM Auto-Clicker shippable. Every change must leave the project in a state where `npm test` passes and `node start.js` runs correctly.

## Mandatory Verification

```bash
npm test          # Must pass all 16 tests before any commit or PR
```

Do not skip tests. Do not mark work as complete until all 16 tests pass.

## Critical Truths

- **Teacher-student pattern**: A cloud VLM (GPT-4o-mini via OpenRouter) teaches button appearance once. A local OCR engine (Tesseract.js) runs free forever after.
- **VLM is only called for learning** — on first run or when OCR confidence drops below threshold. It is never in the hot loop.
- **OCR runs locally forever after** — every 1.5 seconds via Tesseract.js with image preprocessing (negate, greyscale, upscale, normalise, sharpen). Zero ongoing cost.

## Orchestrator

This project is started and supervised by the Coherent Light Orchestrator (`2 - AI Bridge/orchestrator.cjs`).

- **Your actor ID** is in `process.env.PANDORA_ACTOR_ID` (default: `vlm-1`). Use it in Bus `from:` / `to:` fields.
- **Health:** The orchestrator tracks VLM as a long-running child process. If it dies, it auto-restarts with backoff.
- **Start everything:** `node orchestrator.cjs` from `2 - AI Bridge/`. Do not start VLM manually in production.

## VS Code Extension

Extension ID: `coherent-light.vlm-auto-clicker-vscode`

Install with `npm run vscode:install`.

## State Machine

```
DISABLED → LEARNING → WATCHING → DETECTED → CLICKING → COOLDOWN → WATCHING
```

- **DISABLED** — Auto-clicker is off.
- **LEARNING** — VLM teacher is analyzing the screen to learn button appearance.
- **WATCHING** — OCR student is polling the screen every cycle.
- **DETECTED** — A button label matched with sufficient confidence.
- **CLICKING** — Simulating a mouse click on the detected button.
- **COOLDOWN** — Brief pause after clicking to avoid duplicate clicks.
- Returns to **WATCHING** after cooldown.
