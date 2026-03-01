# VLM Auto-Clicker

Vision-powered automation that detects and clicks Accept/Run/Apply buttons in IDE AI assistants. Uses a teacher-student architecture: cloud VLM teaches once, local OCR runs free forever.

## What It Does

When an AI coding assistant (Copilot, Cursor, Windsurf, Antigravity) generates code changes, it shows diff views with Accept/Apply/Run buttons that require manual clicking. This tool watches the screen and clicks them automatically.

## Architecture: Teacher-Student Pattern

```
VLM Teacher (cloud, rare)          OCR Student (local, every 1.5s)
  GPT-4o-mini via OpenRouter         Tesseract.js v7
  ~$0.0001 per call                  Free, ~200ms per scan
  Called on first run +               Runs every poll cycle
  when confidence drops               Uses learned button profiles
         │                                    │
         └── Teaches button appearance ──────►│
             (label, position, color)         │
                                              └── Detects + clicks buttons
```

## State Machine

```
DISABLED → LEARNING → WATCHING → DETECTED → CLICKING → COOLDOWN → WATCHING
```

## Core Modules

| File | Purpose |
|------|---------|
| `start.js` | Entry point — CLI args, API key, config |
| `core/auto_clicker.js` | Main state machine and poll loop |
| `core/ocr_detector.js` | Tesseract.js OCR with preprocessing + fuzzy matching |
| `core/vlm_teacher.js` | GPT-4o-mini vision API for learning button appearance |
| `core/screen_watcher.js` | Multi-monitor screenshot capture, crop, click |
| `core/button_profile_store.js` | Persisted learned button profiles |
| `core/event_bus.js` | Internal event publishing |

## OCR Preprocessing Pipeline

Dark-themed IDEs need image inversion for Tesseract to read text:

```
removeAlpha → negate → greyscale → 3x upscale → normalise → sharpen
```

## Install & Run

```bash
npm install                    # sharp, tesseract.js, screenshot-desktop
export OPENROUTER_API_KEY=sk-or-...   # Required for first learning pass only

node start.js                          # Default: vscode, poll 1.5s
node start.js --ide antigravity        # Antigravity IDE
node start.js --dry-run                # Detect but don't click
node start.js --debug                  # Save screenshots + log OCR
node start.js --poll 2000              # Poll every 2 seconds
```

## Core Protection (Binary)

Rebuild protected core bytecode:

```bash
npm run build:core-binary
```

## Development

```bash
npm test
```

## Supported Button Labels

Accept, Accept All, Apply, Apply All, Accept Changes, Accept Block, Run, Run All, Confirm, Checkout

## VS Code Extension

Extension ID: `coherent-light.vlm-auto-clicker-vscode`

### Commands

- **Start** — Start the auto-clicker
- **Stop** — Stop the auto-clicker
- **Restart** — Restart the auto-clicker
- **Status** — Show current state and stats
- **Run Tests** — Run the test suite
- **Open README** — Open this README in the editor
- **Open Project Root** — Open the project folder

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `vlmAutoClicker.rootPath` | Path to VLM Auto-Clicker project root | — |
| `vlmAutoClicker.runCommand` | Command to start the auto-clicker | `node start.js` |
| `vlmAutoClicker.testCommand` | Command to run tests | `npm test` |
| `vlmAutoClicker.autoStart` | Start automatically when VS Code opens | — |
| `vlmAutoClicker.showOutputOnStart` | Show output panel on start | — |

### Install

```bash
npm run vscode:install
```

## Smoke Tests

```bash
npm test              # 16 passed
node start.js --dry-run   # verify detection without clicking
```

## Requirements

- Node.js 18+
- Windows (uses PowerShell + .NET for screen capture and mouse control)
- OpenRouter API key (for initial VLM learning only — after that OCR runs free)
