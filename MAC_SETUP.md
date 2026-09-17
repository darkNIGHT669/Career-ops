# Career-Ops — Mac setup guide

Share this file (or this repo) with anyone who wants to run the project on a Mac.

Repo: https://github.com/darkNIGHT669/Career-ops

This is a customized Career-Ops workspace: job evaluations, tailored CV PDFs, and a local web dashboard. It does **not** apply to jobs for you. You review everything before sending.

## What you need

- A Mac
- An internet connection
- About 15–20 minutes
- Your own API keys (do not reuse someone else’s `.env`)

You will install:

1. Homebrew (recommended package manager for Mac)
2. Git
3. Node.js 20 or newer
4. This repo’s dependencies + Chromium (for PDF generation)

## 1. Install Homebrew (if you don’t have it)

Open **Terminal** (Spotlight → type `Terminal`) and paste:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

When it finishes, follow the “Next steps” it prints. On Apple Silicon Macs that usually looks like:

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Check:

```bash
brew --version
```

## 2. Install Git and Node.js

```bash
brew install git node
```

Confirm versions (Node should be **18+**, ideally **20+**):

```bash
git --version
node --version
npm --version
```

## 3. Clone the repo

```bash
cd ~
git clone https://github.com/darkNIGHT669/Career-ops.git
cd Career-ops
```

If the repo is **private**, the owner must add you as a collaborator first. Then GitHub will ask you to sign in when you clone.

## 4. Install project dependencies

```bash
npm install
npx playwright install chromium
```

`npm install` may take a few minutes. Playwright downloads a headless Chromium browser used to generate CV PDFs.

## 5. Create your local config

Copy the example env file, then edit `.env` with **your** keys:

```bash
cp .env.example .env
open -e .env
```

Minimum to evaluate jobs:

- `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey)

Optional:

- `GROQ_API_KEY` from [Groq Console](https://console.groq.com/keys) — alternative evaluator
- `SERPAPI_KEY` — LinkedIn / lead lookup
- Gmail app password — only if you will send outreach email from the dashboard

Copy the profile template and fill in **your** details:

```bash
cp config/profile.example.yml config/profile.yml
open -e config/profile.yml
```

Add your resume as Markdown in the project root:

```bash
touch cv.md
open -e cv.md
```

Paste your CV in Markdown (name, experience, projects, skills). There is an example at `examples/dual-track-engineer-instructor/cv.md`.

Optional job-scanner companies:

```bash
cp templates/portals.example.yml portals.yml
```

## 6. Verify setup

```bash
npm run doctor
```

Fix anything it flags (missing `cv.md`, `config/profile.yml`, Node, Playwright, etc.), then re-run.

## 7. Start the web dashboard

```bash
npm run dashboard:web
```

Open a browser and go to:

**http://localhost:3000**

Leave that Terminal window open while you use the app. Stop it with `Ctrl + C`.

## 8. First useful things to try

From another Terminal in the same folder:

```bash
# Evaluate a job description with Gemini
npm run gemini:eval -- "Paste the full job description here"

# Or with Groq (if GROQ_API_KEY is set)
npm run groq:eval -- "Paste the full job description here"
```

You can also paste a job URL or JD into an AI coding CLI opened **inside this folder**:

- [Claude Code](https://claude.ai/code)
- Gemini CLI / Codex / OpenCode, if you already use one

On first launch, tell it about your background. Then ask it to evaluate a role. It should write a report, tailor a CV PDF, and add a tracker row. You always decide whether to apply.

## Troubleshooting

| Problem | Fix |
|---|---|
| `command not found: brew` | Finish Homebrew’s “Next steps” (`eval "$(/opt/homebrew/bin/brew shellenv)"`) and open a new Terminal |
| `command not found: node` | `brew install node`, then open a new Terminal |
| `npm install` fails | `node --version` should be 18+. Then `rm -rf node_modules && npm install` |
| Playwright / PDF errors | `npx playwright install chromium` |
| Dashboard won’t open | Make sure `npm run dashboard:web` is still running and visit http://localhost:3000 |
| Gemini/Groq errors | Check `.env` has a real key, no quotes around the value, and you saved the file |
| Clone is denied | Repo is private — ask the owner to invite your GitHub username as a collaborator |

## What not to do

- Do not commit `.env`, `cv.md`, or `config/profile.yml` (they are gitignored on purpose)
- Do not share API keys in chat or screenshots
- Do not expect the tool to submit applications for you
