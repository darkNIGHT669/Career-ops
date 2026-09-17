#!/usr/bin/env node
/**
 * groq-eval.mjs — Groq-powered Job Offer Evaluator for career-ops
 *
 * An alternative evaluator script using Groq's OpenAI-compatible API.
 * Reads evaluation logic from modes/oferta.md + modes/_shared.md,
 * reads the user's resume from cv.md, and evaluates a Job Description
 * passed as a command-line argument.
 *
 * Usage:
 *   node groq-eval.mjs "Paste full JD text here"
 *   node groq-eval.mjs --file ./jds/my-job.txt
 *   node groq-eval.mjs --model llama-3.3-70b-versatile "<JD text>"
 *
 * Requires:
 *   GROQ_API_KEY in .env (or environment variable)
 *   AI_MODEL or GROQ_MODEL in .env (defaults to llama-3.3-70b-versatile)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Bootstrap: load .env before anything else
// ---------------------------------------------------------------------------
try {
  const { config } = await import('dotenv');
  config();
} catch {
  // dotenv is optional — fall back to process.env if not installed
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  // Primary evaluation logic lives in these two mode files
  shared:      join(ROOT, 'modes', '_shared.md'),
  oferta:      join(ROOT, 'modes', 'oferta.md'),
  // Canonical skill path
  evaluate:    join(ROOT, '.claude', 'skills', 'career-ops', 'SKILL.md'),
  cv:          join(ROOT, 'cv.md'),
  profile:     join(ROOT, 'modes', '_profile.md'),
  profileYml:  join(ROOT, 'config', 'profile.yml'),
  reports:     join(ROOT, 'reports'),
  tracker:     join(ROOT, 'data', 'applications.md'),
  trackerAdditions: join(ROOT, 'batch', 'tracker-additions'),
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║             career-ops — Groq Evaluator                         ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer using Groq's OpenAI-compatible API.

  USAGE
    node groq-eval.mjs "<JD text>"
    node groq-eval.mjs --file ./jds/my-job.txt
    node groq-eval.mjs --model llama-3.3-70b-versatile "<JD text>"

  OPTIONS
    --file <path>    Read JD from a file instead of inline text
    --model <name>   Groq model to use (default: llama-3.3-70b-versatile or AI_MODEL)
    --no-save        Do not save report to reports/ directory
    --help           Show this help

  SETUP
    1. Get an API key at https://console.groq.com/keys
    2. Add GROQ_API_KEY=<your-key> to .env
    3. Add AI_MODEL=llama-3.3-70b-versatile to .env
    4. Run: npm install   (installs dotenv if not already present)

  EXAMPLES
    node groq-eval.mjs "We are looking for a Senior AI Engineer..."
    node groq-eval.mjs --file ./jds/openai-swe.txt
`);
  process.exit(0);
}

// Parse flags
let jdText = '';
let modelName = process.env.AI_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
let saveReport = true;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const filePath = args[++i];
    if (!existsSync(filePath)) {
      console.error(`❌  File not found: ${filePath}`);
      process.exit(1);
    }
    jdText = readFileSync(filePath, 'utf-8').trim();
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (!args[i].startsWith('--')) {
    jdText += (jdText ? '\n' : '') + args[i];
  }
}

if (!jdText) {
  console.error('❌  No Job Description provided. Run with --help for usage.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------
const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error(`
❌  GROQ_API_KEY not found.

   1. Get an API key at https://console.groq.com/keys
   2. Add it to .env:   GROQ_API_KEY=your_key_here
   3. Or export it:     export GROQ_API_KEY=your_key_here
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

function nextReportNumber() {
  if (!existsSync(PATHS.reports)) return '001';
  const files = readdirSync(PATHS.reports)
    .filter(f => /^\d{3}-/.test(f))
    .map(f => parseInt(f.slice(0, 3)))
    .filter(n => !isNaN(n));
  if (files.length === 0) return '001';
  return String(Math.max(...files) + 1).padStart(3, '0');
}

function validateEvaluationShape(text) {
  const issues = [];
  const requiredBlocks = [
    ['A', /(?:^|\n)#{1,3}\s*(?:A[).:-]?|Block A\b)/im],
    ['B', /(?:^|\n)#{1,3}\s*(?:B[).:-]?|Block B\b)/im],
    ['C', /(?:^|\n)#{1,3}\s*(?:C[).:-]?|Block C\b)/im],
    ['D', /(?:^|\n)#{1,3}\s*(?:D[).:-]?|Block D\b)/im],
    ['E', /(?:^|\n)#{1,3}\s*(?:E[).:-]?|Block E\b)/im],
    ['F', /(?:^|\n)#{1,3}\s*(?:F[).:-]?|Block F\b)/im],
    ['G', /(?:^|\n)#{1,3}\s*(?:G[).:-]?|Block G\b)/im],
  ];

  for (const [label, pattern] of requiredBlocks) {
    if (!pattern.test(text)) issues.push(`missing Block ${label}`);
  }

  const summary = text.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
  if (!summary) {
    issues.push('missing SCORE_SUMMARY block');
  } else {
    const summaryBlock = summary[1];
    for (const key of ['COMPANY', 'ROLE', 'ARCHETYPE', 'LEGITIMACY']) {
      const field = summaryBlock.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mi'));
      const value = field?.[1]?.trim() ?? '';
      if (!value || (key !== 'COMPANY' && value.toLowerCase() === 'unknown')) {
        issues.push(`SCORE_SUMMARY ${key} is required`);
      }
    }

    const score = summaryBlock.match(/^\s*SCORE:\s*([0-9]+(?:\.[0-9]+)?)/mi);
    const scoreValue = score ? Number(score[1]) : NaN;
    if (!Number.isFinite(scoreValue) || scoreValue < 0 || scoreValue > 5) {
      issues.push('SCORE_SUMMARY score must be a number between 0 and 5');
    }
  }

  if (issues.length > 0) {
    throw new Error(`Groq returned an invalid career-ops report: ${issues.join('; ')}`);
  }
}

function slugifyCompany(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

function tsvSafe(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function normalizedTrackerScore(value) {
  const clean = tsvSafe(value);
  if (!clean || clean === '?') return 'N/A';
  return /\/5$/i.test(clean) ? clean : `${clean}/5`;
}

// ---------------------------------------------------------------------------
// Load context files
// ---------------------------------------------------------------------------
console.log('\n📂  Loading context files...');

const sharedContext  = readFile(PATHS.shared,      'modes/_shared.md');
const ofertaLogic    = readFile(PATHS.oferta,      'modes/oferta.md');
const cvContent      = readFile(PATHS.cv,          'cv.md');
const profileContent = readFile(PATHS.profile,     'modes/_profile.md');
const profileYml     = readFile(PATHS.profileYml,  'config/profile.yml');

// ---------------------------------------------------------------------------
// Build the system prompt (mirrors the Claude skill router logic)
// ---------------------------------------------------------------------------
const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

═══════════════════════════════════════════════════════
SYSTEM CONTEXT (_shared.md)
═══════════════════════════════════════════════════════
${sharedContext}

═══════════════════════════════════════════════════════
EVALUATION MODE (oferta.md)
═══════════════════════════════════════════════════════
${ofertaLogic}

═══════════════════════════════════════════════════════
CANDIDATE RESUME (cv.md)
═══════════════════════════════════════════════════════
${cvContent}

═══════════════════════════════════════════════════════
CANDIDATE PROFILE & TARGETS (config/profile.yml)
═══════════════════════════════════════════════════════
${profileYml}

═══════════════════════════════════════════════════════
USER ARCHETYPES & NARRATIVE (_profile.md)
═══════════════════════════════════════════════════════
${profileContent}

═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS CLI SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - For Block D (Comp research): provide salary estimates based on your training data, clearly noted as estimates.
   - For Block G (Legitimacy): analyze the JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the script, not by you.
2. Generate Blocks A through G in full, in English, unless the JD is in another language.
3. At the very end, output a machine-readable summary block in this exact format:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

// ---------------------------------------------------------------------------
// Call Groq API
// ---------------------------------------------------------------------------
console.log(`🤖  Calling Groq (${modelName})... this may take 10-30 seconds.\n`);

let evaluationText;
try {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `\n\nJOB DESCRIPTION TO EVALUATE:\n\n${jdText}` }
      ],
      temperature: 0.4,
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  evaluationText = data.choices?.[0]?.message?.content;
  if (!evaluationText) {
    throw new Error('Groq returned an empty response or unexpected structure.');
  }
} catch (err) {
  const sanitizedMsg = (err.message || '').split(apiKey).join('[REDACTED]');
  console.error('❌  Groq API error:', sanitizedMsg);
  if (sanitizedMsg.includes('API_KEY')) {
    console.error('    Check your GROQ_API_KEY in .env');
  } else if (sanitizedMsg.includes('quota') || sanitizedMsg.includes('rate') || sanitizedMsg.includes('429')) {
    console.error('    You may have hit the Groq rate limit. Wait and retry.');
  }
  process.exit(1);
}

try {
  validateEvaluationShape(evaluationText);
} catch (err) {
  console.error('❌  Groq output failed validation:', err.message);
  console.error('    No report was saved. Retry, lower temperature, or check configuration.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Display evaluation
// ---------------------------------------------------------------------------
console.log('\n' + '═'.repeat(66));
console.log('  CAREER-OPS EVALUATION — powered by Groq');
console.log('═'.repeat(66) + '\n');
console.log(evaluationText);

// ---------------------------------------------------------------------------
// Parse score summary
// ---------------------------------------------------------------------------
const summaryMatch = evaluationText.match(
  /---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/
);

let company    = 'unknown';
let role       = 'unknown';
let score      = '?';
let archetype  = 'unknown';
let legitimacy = 'unknown';

if (summaryMatch) {
  const block = summaryMatch[1];
  const extract = (key) => {
    const prefix = `${key}:`;
    const lines = block.split('\n');
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(prefix)) {
        return trimmed.slice(prefix.length).trim();
      }
    }
    return 'unknown';
  };
  company    = extract('COMPANY');
  role       = extract('ROLE');
  score      = extract('SCORE');
  archetype  = extract('ARCHETYPE');
  legitimacy = extract('LEGITIMACY');
}

// ---------------------------------------------------------------------------
// Save report
// ---------------------------------------------------------------------------
if (saveReport) {
  let reportSaved = false;
  try {
    if (!existsSync(PATHS.reports)) {
      mkdirSync(PATHS.reports, { recursive: true });
    }

    const num         = nextReportNumber();
    const today       = new Date().toISOString().split('T')[0];
    const companySlug = slugifyCompany(company);
    const filename    = `${num}-${companySlug}-${today}.md`;
    const reportPath  = join(PATHS.reports, filename);
    const trackerPath = join(PATHS.trackerAdditions, `${num}-${companySlug}.tsv`);

    const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**Archetype:** ${archetype}
**Score:** ${score}/5
**Legitimacy:** ${legitimacy}
**PDF:** pending
**Tool:** Groq (${modelName})

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

    writeFileSync(reportPath, reportContent, 'utf-8');
    mkdirSync(PATHS.trackerAdditions, { recursive: true });
    const trackerFields = [
      String(parseInt(num, 10)),
      today,
      tsvSafe(company),
      tsvSafe(role),
      'Evaluated',
      normalizedTrackerScore(score),
      '❌',
      `[${num}](reports/${filename})`,
      'Groq evaluation',
    ];
    writeFileSync(trackerPath, `${trackerFields.join('\t')}\n`, 'utf-8');
    console.log(`\n✅  Report saved: reports/${filename}`);
    console.log(`📊  Tracker addition saved: batch/tracker-additions/${num}-${companySlug}.tsv`);
    reportSaved = true;
  } catch (err) {
    console.warn(`⚠️   Could not save report: ${err.message}`);
    process.exitCode = 1;
  }

  if (reportSaved) {
    try {
      const mergeOutput = execFileSync(process.execPath, [join(ROOT, 'merge-tracker.mjs')], {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (mergeOutput.trim()) console.log(mergeOutput.trim());
      console.log('📊  Tracker merged into data/applications.md.');
    } catch (err) {
      console.warn(`⚠️   Report saved, but could not merge tracker addition into data/applications.md: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');
