# VLM Auto-Clicker

**Stop clicking Accept. Start building.**

When Copilot, Cursor, Windsurf or Antigravity generates code, it shows a diff with Accept / Accept All / Apply / Run buttons. You have to click them. Every time. All day.

VLM Auto-Clicker watches your screen and clicks them for you.

## How it works

**First run** — takes a screenshot, sends it to a vision AI (GPT-4o-mini via OpenRouter, fractions of a cent) to learn what your Accept button looks like. Happens once.

**Every 1.5 seconds after that** — free local OCR (Tesseract.js) scans for the button. When it sees it, it clicks it. No cloud. No cost. No latency.

```
VLM Teacher (cloud, once)    →    teaches button appearance
OCR Student (local, forever) →    detects + clicks automatically
```

## Requirements

- **Windows** (uses PowerShell for screen capture and mouse control)
- **Node.js 18+**
- **OpenRouter API key** — for the one-time learning pass only. Free after that.
  Get one at openrouter.ai (free tier available)

## Setup (2 minutes)

1. Clone or download the repo: `github.com/fashionshowphotos/vlm-auto-clicker`
2. In the repo folder: `npm install`
3. Set your OpenRouter key: add `OPENROUTER_API_KEY=sk-or-...` to your environment
4. Open the repo folder in VS Code — the extension finds it automatically
5. Run command: **VLM Auto-Clicker: Start**

> If VS Code says it can't find the project, set `vlmAutoClicker.rootPath` to the full path of the repo folder in your VS Code settings.

## Supported buttons

Accept · Accept All · Apply · Apply All · Accept Changes · Accept Block · Run · Run All · Confirm · Checkout

## Commands

| Command | What it does |
|---|---|
| `VLM Auto-Clicker: Start` | Start watching and clicking |
| `VLM Auto-Clicker: Stop` | Stop |
| `VLM Auto-Clicker: Restart` | Restart |
| `VLM Auto-Clicker: Status` | Show current state |

## Settings

| Setting | Default | Description |
|---|---|---|
| `vlmAutoClicker.rootPath` | _(auto)_ | Path to repo root if not auto-detected |
| `vlmAutoClicker.autoStart` | false | Start automatically when VS Code opens |

## License

Free for personal and non-commercial use.
Commercial use requires a licence — see github.com/fashionshowphotos/vlm-auto-clicker
