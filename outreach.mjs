import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import dns from 'dns';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from 'dotenv';
config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, 'data', 'outreach-queue.json');

// Initialize Gemini
const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// Search query keywords for SerpAPI
const LEAD_TITLES = [
  "Engineering Manager",
  "Tech Lead",
  "VP Engineering",
  "Head of Engineering",
  "CTO",
  "Director of Engineering",
  "Recruiter",
  "Talent Acquisition"
];

// Statistical confidence weights for email patterns
const EMAIL_PATTERNS = [
  { pattern: "firstname.lastname", weight: 42, format: (f, l, d) => `${f}.${l}@${d}` },
  { pattern: "flastname", weight: 31, format: (f, l, d) => `${f[0]}${l}@${d}` },
  { pattern: "firstnamelastname", weight: 16, format: (f, l, d) => `${f}${l}@${d}` },
  { pattern: "firstname", weight: 7, format: (f, l, d) => `${f}@${d}` },
  { pattern: "firstname_lastname", weight: 4, format: (f, l, d) => `${f}_${l}@${d}` }
];

// Helper to extract company slug from a LinkedIn company URL
export function extractCompanySlug(url) {
  if (!url) return '';
  try {
    // Matches e.g. https://www.linkedin.com/company/alpha-software/ or /company/alpha-software
    const match = url.match(/\/company\/([a-zA-Z0-9\-]+)/);
    return match ? match[1] : '';
  } catch (e) {
    return '';
  }
}

// Helper to extract the root domain, stripping subdomains (e.g. trends.builtwith.com -> builtwith.com)
export function getRootDomain(hostname) {
  if (!hostname) return '';
  const parts = hostname.split('.');
  if (parts.length <= 2) {
    return hostname;
  }
  
  // Common multi-segment country code suffixes
  const ccSLDs = new Set([
    'co', 'org', 'net', 'gov', 'ac', 'res', 'in', 'uk', 'us', 'ca', 'au'
  ]);
  
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  
  if (parts.length >= 3 && ccSLDs.has(secondLast) && last.length <= 3) {
    return parts.slice(parts.length - 3).join('.');
  }
  
  return parts.slice(parts.length - 2).join('.');
}

// Helper to extract company domain from url or query Google
export function extractDomain(url) {
  if (!url || url.startsWith('local:')) return '';
  try {
    const parsed = new URL(url);
    let hostname = parsed.hostname;
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    
    // Blacklist job boards and ATS portals from being extracted as the target company domain
    const blacklist = [
      'linkedin.com', 'indeed.com', 'glassdoor.com', 'monster.com', 'careerbuilder.com',
      'ziprecruiter.com', 'wellfound.com', 'angel.co', 'lever.co', 'greenhouse.io',
      'ashbyhq.com', 'workable.com', 'smartrecruiters.com', 'bamboohr.com'
    ];
    
    if (blacklist.some(b => hostname === b || hostname.endsWith('.' + b))) {
      return '';
    }
    
    return getRootDomain(hostname);
  } catch (e) {
    return '';
  }
}

// Perform domain lookup for website domain using SerpAPI
export async function findCompanyDomain(companyName, companyLinkedinUrl = '') {
  const serpKey = process.env.SERPAPI_KEY;
  if (!serpKey) return '';
  
  try {
    let query = `${companyName} official website domain`;
    const slug = extractCompanySlug(companyLinkedinUrl);
    if (slug) {
      query = `LinkedIn company ${slug} official website domain`;
    }
    
    const res = await fetch(`https://serpapi.com/search?engine=google&q=${encodeURIComponent(query)}&api_key=${serpKey}`);
    const data = await res.json();
    
    if (data.organic_results && data.organic_results.length > 0) {
      const link = data.organic_results[0].link;
      return extractDomain(link);
    }
  } catch (e) {
    console.error(`Error searching domain for ${companyName}:`, e.message);
  }
  return '';
}

// Prioritize leads based on title categories
function getTitlePriority(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('engineering manager') || t.includes('tech lead')) return 1;
  if (t.includes('director') || t.includes('head of engineering') || t.includes('vp engineering')) return 2;
  if (t.includes('cto') || t.includes('chief technology officer') || t.includes('founder')) return 3;
  if (t.includes('recruiter') || t.includes('talent acquisition')) return 4;
  return 5;
}

// Strict company name matcher to prevent partial/prefix matches (e.g. matching "Alpha Silicon" or "Alpha Wave" when the target is "Alpha")
export function companyMatches(titleText, targetCompanyName, companySlug = '') {
  if (!titleText || !targetCompanyName) return false;
  
  const cleanTarget = targetCompanyName
    .toLowerCase()
    .replace(/\.(ai|io|com|org|net|co)$/i, '')
    .replace(/\s+(llc|inc|ltd|corp|gmbh|co|holdings|group|global|lp|partners|capital|solutions|systems|software|technologies|services)$/i, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();

  const cleanSlug = companySlug
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();

  // Split title by common delimiters: hyphens, pipes, at signs, or the word "at"
  const parts = titleText.split(/[-|@\u2013\u2014]|\bat\b/i).map(p => p.trim());
  
  for (const part of parts) {
    const cleanPart = part
      .toLowerCase()
      .replace(/\.(ai|io|com|org|net|co)$/i, '')
      .replace(/\s+(llc|inc|ltd|corp|gmbh|co|holdings|group|global|lp|partners|capital|solutions|systems|software|technologies|services)$/i, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
      
    if (cleanPart === cleanTarget || (cleanSlug && cleanPart === cleanSlug)) {
      return true;
    }
  }
  return false;
}

// Step 1: Find Lead via SerpAPI LinkedIn X-Ray
export async function findLinkedInLead(companyName, companyLinkedinUrl = '') {
  const serpKey = process.env.SERPAPI_KEY;
  if (!serpKey) {
    throw new Error('SERPAPI_KEY environment variable is missing.');
  }

  // Normalize company name to improve search accuracy and filter profiles
  const cleanCompany = companyName
    .replace(/\.(ai|io|com|org|net|co)$/i, '')
    .replace(/\s+(llc|inc|ltd|corp|gmbh|co|holdings|group)$/i, '')
    .trim();

  const companySlug = extractCompanySlug(companyLinkedinUrl);

  // Helper to parse search results consistently
  function parseOrganicResults(results) {
    return results.map(item => {
      const titleText = item.title || '';
      const snippetText = item.snippet || '';
      
      // Strict title check: target company name MUST be present in the LinkedIn profile title
      if (!companyMatches(titleText, cleanCompany, companySlug)) {
        return null;
      }

      // Format: "John Doe - Engineering Manager - Company | LinkedIn"
      const parts = titleText.split(/[-|]/).map(p => p.trim());
      const rawName = parts[0] || '';
      const cleanName = rawName.replace(/\s*\(.*?\)\s*/g, ''); // strip parentheses e.g. "John (He/Him) Doe"
      
      // Extract title from snippet or title text
      let parsedTitle = '';
      const titlesToCheck = [...LEAD_TITLES, "Founder", "Co-Founder", "Engineering", "HR", "Manager"];
      for (const t of titlesToCheck) {
        if (titleText.toLowerCase().includes(t.toLowerCase())) {
          parsedTitle = t;
          break;
        }
        if (item.snippet && item.snippet.toLowerCase().includes(t.toLowerCase())) {
          parsedTitle = t;
          break;
        }
      }

      // Fallback: Use the middle part of the LinkedIn title as the role
      if (!parsedTitle && parts.length > 1) {
        for (let i = 1; i < parts.length; i++) {
          const part = parts[i];
          if (part.toLowerCase().includes('linkedin')) continue;
          if (part.toLowerCase().includes(cleanCompany.toLowerCase())) continue;
          if (companySlug && part.toLowerCase().includes(companySlug.toLowerCase())) continue;
          parsedTitle = part;
          break;
        }
      }

      if (!parsedTitle) {
        parsedTitle = 'Decision Maker';
      }

      // Match scoring (inspired by pipeline.py)
      let score = 0;
      const targetLower = cleanCompany.toLowerCase();
      const slugLower = companySlug ? companySlug.toLowerCase() : '';
      const textToCheck = (titleText + ' ' + snippetText).toLowerCase();
      
      if (textToCheck.includes(targetLower) || (slugLower && textToCheck.includes(slugLower))) {
        score += 3;
      }
      
      const strongDMs = ["engineering manager", "vp engineering", "head of engineering", "director of engineering", "cto", "senior engineering manager"];
      const weakDMs = ["tech lead", "technical lead", "staff engineer", "principal engineer", "lead engineer"];
      const parsedLower = parsedTitle.toLowerCase();
      
      if (strongDMs.some(dm => parsedLower.includes(dm))) {
        score += 2;
      } else if (weakDMs.some(dm => parsedLower.includes(dm))) {
        score += 1;
      }
      
      // Stale company penalty: if "at [Another Company]" is in snippet, and doesn't contain target company/slug
      const otherMatch = snippetText.match(/\bat\s+([a-zA-Z0-9\s&,\.]+)/i);
      if (otherMatch) {
        const atCo = otherMatch[1].trim().toLowerCase();
        if (!atCo.includes(targetLower) && (!slugLower || !atCo.includes(slugLower)) && atCo.length > 3) {
          score -= 2;
        }
      }

      return {
        name: cleanName,
        title: parsedTitle,
        linkedin: item.link,
        priority: getTitlePriority(parsedTitle),
        score: score
      };
    }).filter(lead => lead && lead.name && lead.name.length > 2 && !lead.name.toLowerCase().includes('linkedin'));
  }

  // Detect if candidate location is India to add query location constraint
  let locationConstraint = '';
  try {
    const profilePath = path.join(__dirname, 'config', 'profile.yml');
    if (existsSync(profilePath)) {
      const content = readFileSync(profilePath, 'utf-8');
      if (content.toLowerCase().includes('location:') && content.toLowerCase().includes('india')) {
        locationConstraint = ' "India"';
      }
    }
  } catch (e) {
    locationConstraint = ' "India"';
  }

  const companyTerms = companySlug 
    ? `("at ${companySlug}" OR "at ${cleanCompany}" OR "${companySlug}" OR "${cleanCompany}")` 
    : `("at ${cleanCompany}" OR "at ${companyName}" OR "${cleanCompany}")`;

  // 1. Strict Query (engineering executive / recruiter) with India location constraint
  const query = `site:linkedin.com/in/ ("Engineering Manager" OR "Tech Lead" OR "VP Engineering" OR "Head of Engineering" OR "CTO" OR "Director of Engineering" OR "Recruiter" OR "Talent Acquisition") ${companyTerms}${locationConstraint} -intitle:"looking for" -intitle:"open to"`;
  
  let results = [];
  try {
    const res = await fetch(`https://serpapi.com/search?engine=google&q=${encodeURIComponent(query)}&num=15&api_key=${serpKey}`);
    const data = await res.json();
    if (!data.error) {
      results = data.organic_results || [];
    }
  } catch (e) {
    console.error(`[Outreach] Strict search failed: ${e.message}`);
  }

  let parsedLeads = parseOrganicResults(results);

  // 2. Broad Fallback Query (if strict search returns no company employees)
  if (parsedLeads.length === 0) {
    console.log(`[Outreach] No strict leads found for ${companyName} in India. Trying broad fallback search...`);
    const fallbackQuery = `site:linkedin.com/in/ ${companyTerms} -intitle:"looking for" -intitle:"open to"`;
    try {
      const fbRes = await fetch(`https://serpapi.com/search?engine=google&q=${encodeURIComponent(fallbackQuery)}&num=15&api_key=${serpKey}`);
      const fbData = await fbRes.json();
      if (fbData.organic_results && fbData.organic_results.length > 0) {
        parsedLeads = parseOrganicResults(fbData.organic_results);
      }
    } catch (e) {
      console.error(`[Outreach] Broad fallback search failed: ${e.message}`);
    }
  }

  if (parsedLeads.length === 0) return [];

  // Sort by score (descending) then by priority (ascending)
  parsedLeads.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.priority - b.priority;
  });
  
  // Deduplicate by name and limit to top 5
  const uniqueLeads = [];
  const names = new Set();
  for (const l of parsedLeads) {
    if (!names.has(l.name.toLowerCase())) {
      names.add(l.name.toLowerCase());
      uniqueLeads.push(l);
    }
  }
  return uniqueLeads.slice(0, 5);
}

// Step 2: Live Domain MX validation (DNS resolve)
export function validateMXRecords(domain) {
  return new Promise((resolve) => {
    if (!domain) return resolve(false);
    dns.resolveMx(domain, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

// Step 3: Local Email Pattern Guesser
export async function guessLeadEmail(fullName, domain) {
  if (!fullName || !domain) return [];

  // Parse first and last names
  const cleanName = fullName.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  const nameParts = cleanName.split(/\s+/);
  
  const mxValid = await validateMXRecords(domain);
  if (!mxValid) {
    return [{
      email: `${nameParts[0]}@${domain}`,
      confidence: 1,
      pattern: 'firstname',
      mxStatus: '⚠️ No MX Records'
    }];
  }

  const candidates = [];
  const addedEmails = new Set();
  
  function addCandidate(email, pattern, weight) {
    const cleanEmail = email.toLowerCase().trim();
    if (!addedEmails.has(cleanEmail)) {
      addedEmails.add(cleanEmail);
      candidates.push({
        email: cleanEmail,
        confidence: weight,
        pattern,
        mxStatus: '✅ MX Verified'
      });
    }
  }

  if (nameParts.length < 2) {
    addCandidate(`${nameParts[0]}@${domain}`, 'firstname', 10);
  } else {
    const first = nameParts[0];
    const last = nameParts[nameParts.length - 1];

    // 1. Standard patterns
    addCandidate(`${first}.${last}@${domain}`, 'firstname.lastname', 42);
    addCandidate(`${first[0]}${last}@${domain}`, 'flastname', 31);
    addCandidate(`${first}${last}@${domain}`, 'firstnamelastname', 16);
    addCandidate(`${first}@${domain}`, 'firstname', 7);
    addCandidate(`${first}_${last}@${domain}`, 'firstname_lastname', 4);

    // 2. Middle name/initials patterns (e.g. Athira N V -> athira.nv)
    if (nameParts.length > 2) {
      const middleAndLastParts = nameParts.slice(1);
      const lastCombined = middleAndLastParts.join(''); // e.g. 'nv'
      const lastCombinedDot = middleAndLastParts.join('.'); // e.g. 'n.v'
      
      addCandidate(`${first}.${lastCombined}@${domain}`, 'firstname.lastname_combined', 40);
      addCandidate(`${first}.${lastCombinedDot}@${domain}`, 'firstname.middle.lastname', 15);
      addCandidate(`${first[0]}${lastCombined}@${domain}`, 'firstinitial_lastname_combined', 30);
      addCandidate(`${first}${lastCombined}@${domain}`, 'firstname_lastname_combined', 15);
      addCandidate(`${first}_${lastCombined}@${domain}`, 'firstname_lastname_combined_underscore', 5);
    }
  }

  // Live SMTP verification via Rapid Email Verifier
  let list = candidates;
  let isCatchAll = false;
  const randomGarbage = `fake.test.email.${Date.now()}@${domain}`;
  
  try {
    const garbageRes = await fetch('https://rapid-email-verifier.fly.dev/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: randomGarbage }),
      signal: AbortSignal.timeout(3000)
    });
    const garbageData = await garbageRes.json();
    if (garbageData.status === 'VALID' || garbageData.validations?.mailbox_exists === true) {
      isCatchAll = true;
    }
  } catch (e) {
    console.log(`[Outreach Email Verifier] Catch-all check failed: ${e.message}`);
    isCatchAll = true; // Fallback to safe mode (treat as catch-all to avoid filtering valid emails if API is down)
  }

  if (!isCatchAll) {
    console.log(`[Outreach Email Verifier] Domain ${domain} is NOT catch-all. Verifying candidates...`);
    await Promise.all(list.map(async (item) => {
      try {
        const res = await fetch('https://rapid-email-verifier.fly.dev/api/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: item.email }),
          signal: AbortSignal.timeout(3000)
        });
        const data = await res.json();
        if (data.status === 'VALID' || data.validations?.mailbox_exists === true) {
          item.confidence = 99;
          item.mxStatus = '✅ Verified Valid (SMTP Check)';
        } else {
          item.confidence = 0; // Drop invalid mailboxes
          item.mxStatus = '❌ Mailbox Not Found';
        }
      } catch (err) {
        // Keep default status if lookup fails
      }
    }));
    // Filter out invalid candidates
    list = list.filter(item => item.confidence > 0);
  } else {
    console.log(`[Outreach Email Verifier] Domain ${domain} is catch-all/unverifiable. Falling back to statistical weights.`);
    list.forEach(item => {
      item.mxStatus = '⚠️ Catch-all / Unverified';
    });
  }

  // Sort descending by confidence
  return list.sort((a, b) => b.confidence - a.confidence);
}

// Helper to compile a highly personalized cold email entirely offline as a fallback
export function generateOfflineEmailDraft(companyName, leadName, leadTitle, cvMarkdown) {
  const leadFirst = leadName ? leadName.split(' ')[0] : 'there';
  const roleType = getTitlePriority(leadTitle); // 1 = EM, 2/3 = Exec/CTO, 4 = Recruiter/HR
  
  let subject = `Harsh | SDE role at ${companyName}`;
  let salutation = `Hi ${leadFirst},`;
  let hook = `I saw the Software Engineer opening at ${companyName} and wanted to reach out. As a PPO-converted developer with production backend experience at Oryx Logistics, I thought my background in low-latency APIs and agentic AI systems could align well with your team's initiatives.`;
  
  if (roleType === 4) { // Recruiter/HR
    subject = `Harsh - Software Engineer application | ${companyName}`;
    hook = `I saw ${companyName} is hiring a Software Engineer and wanted to introduce myself. I am a PPO-converted full-stack developer with experience building high-throughput APIs, scalable web interfaces, and AI workflows.`;
  } else if (roleType === 2 || roleType === 3) { // Exec/CTO
    subject = `SDE platform engineering at ${companyName}`;
    salutation = `Dear ${leadName || 'there'},`;
    hook = `I know your schedule is demanding, so I'll be brief. I saw the engineering team at ${companyName} is scaling, and wanted to reach out. I'm a developer specializing in low-latency backend architectures and production-grade LLM integrations.`;
  }
  
  const bullet1 = `**Production Backend Scale:** Ex-Oryx Associate SDE, where I built modular REST APIs using Node.js/Express, implemented secure JWT/RBAC auth, and optimized MongoDB aggregation query latencies by 35%.`;
  const bullet2 = `**AI & Full-Stack Systems:** Engineered *SpendSight* (a live AI spend audit platform using Next.js 14 and Supabase RLS) and *PanScience Q&A* (a FastAPI/pgvector RAG document intelligence pipeline with 95%+ test coverage).`;
  
  const body = `${salutation}

${hook}

Here are two quick highlights of what I've shipped:
• ${bullet1}
• ${bullet2}

I bring strong CS fundamentals (290+ DSA solved in C++) and a production-ready mindset (Next.js, Node.js, Python, AWS, Docker). My code and live systems are at github.com/darkNIGHT669 and portfolio-vs8v.vercel.app.

Would you be open to a brief 10-minute screening call this week to see if this is a match?

Best regards,
Harsh`;

  return { subject, body };
}

// Step 4: Hyper-personalized outreach compiler using Gemini
export async function draftOutreachEmail(jdText, companyName, leadName, leadTitle, customModel = null) {
  if (!genAI && !customModel) {
    throw new Error('Gemini API is not configured. GEMINI_API_KEY environment variable is missing.');
  }

  // Load CV
  const cvPath = path.join(__dirname, 'cv.md');
  const cvMarkdown = existsSync(cvPath) ? readFileSync(cvPath, 'utf-8') : '';

  // Load tailored HTML resume context if available for consistency check
  const tailoredPath = path.join(__dirname, 'output', 'cv-harsh-dahiya-spark.html');
  let tailoredText = '';
  if (existsSync(tailoredPath)) {
    console.log('[Outreach] Loading tailored resume for consistency check...');
    const rawHtml = readFileSync(tailoredPath, 'utf-8');
    tailoredText = rawHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const projectsList = parseProjectTechStacks(cvMarkdown);
  const projectStacksStr = projectsList.map(p => `- **${p.title}:** ${p.techWords.join(', ')}`).join('\n');

  let modelName = 'gemini-2.5-flash';
  let model = customModel || genAI.getGenerativeModel({ model: modelName });

  const leadFirst = leadName ? leadName.split(' ')[0] : 'there';
  const roleType = getTitlePriority(leadTitle); // 1 = EM, 2/3 = Exec/CTO, 4 = Recruiter/HR

  try {
    const prompt = `
You are an expert cold email writer. Your goal is to draft a hyper-personalized, highly professional cold email from a developer named Harsh to a decision-maker at a target company.

Input context:
*   Candidate CV: ${cvMarkdown}
*   Tailored Resume Context (Used for consistency check): ${tailoredText || 'No tailored resume found.'}
*   Target Company Name: ${companyName}
*   Recipient Name: ${leadName}
*   Recipient Job Title: ${leadTitle}
*   Job Description: ${jdText}

STRICT CONSISTENCY GATES:
*   The skills, technologies, metrics, and achievements claimed in your cold email must perfectly align with what is written in the tailored resume or CV.
*   You must NEVER claim experience with a technology (e.g. Django, Kubernetes, Spring Boot, Angular, Java, .NET, PHP) in the email if it is absent from the tailored resume/CV.
*   Do not make contradictory statements (e.g., claiming to have built a Django backend if the resume only mentions Node.js/Express).
*   **NEVER misattribute a technology or database to a project.** You must strictly verify every project-to-tech-stack claim in the email against the canonical per-project stack list derived from cv.md:
${projectStacksStr}
    Do NOT state or imply a project uses a technology that is not listed in its stack above. Do not blend project stacks.

EMAIL STRUCTURE RULES:
*   **Highly Specific Opener Hook:** Replace generic openings (like "I am writing to apply..." or "I hope this email finds you well") with a highly specific company/role hook. Avoid starting with generic phrases. Start with a direct observation about their company/product or role.
*   **Low-Friction CTA:** Replace high-friction asks (like scheduling a 10-15 minute call or sync) with a low-friction call-to-action: ask the recipient to **flag your resume/portfolio to whoever is screening this role**, or ask if they have 2 minutes to look at your portfolio.
*   **Direct Links:** You MUST weave the candidate's portfolio link (https://portfolio-vs8v.vercel.app/) and GitHub link (https://github.com/darkNIGHT669) directly in the body of the email in a professional, natural way.

*   The email body must NOT claim any project uses a database, framework, or cloud service that is not in its allowed list. Here is the canonical project stack mapping again:
${projectStacksStr}
*   If a project is mentioned in the email, you must make sure that it only uses the whitelisted technologies listed above for that specific project.
*   If Ivory is mentioned or described, it must NEVER mention Angular, Java, .NET, or PHP except in the Ivory internship block (e.g., Ivory bullets). They must never appear anywhere else.
*   Always use the candidate name "Harsh" in the signature.
*   Your output MUST be a valid JSON object matching the format below. Do not output markdown other than the JSON itself.

Recipient details to adapt tone/content:
${roleType === 1 ? `
- The recipient is an Engineering Manager or Tech Lead (Priority 1).
- Tone: Peer-to-peer, technical, respect for developer time, focus on shipping capabilities, product architecture.
- Content: Focus on tech stack alignment, production reliability, specific metrics (e.g. 35% latency reduction, 95% test coverage), system design.
- Call to Action (CTA): Ask if they have 10 mins for a quick developer-to-developer chat.
` : roleType === 2 || roleType === 3 ? `
- The recipient is an Executive or CTO (Priority 2/3).
- Tone: High-level, business-impact focused, extremely concise.
- Content: Frame your value proposition in terms of shipping speed, reliability, and business impact. Briefly reference your top production project matching their tech stack.
- Call to Action (CTA): Ask them to flag your resume/portfolio to whoever is screening this role.
` : `
- The recipient is a Technical Recruiter / HR Partner (Priority 4).
- Tone: Process-oriented, metric-driven, helpful, enthusiastic.
- Content: Outline key match qualifications (MERN stack experience, shipping React Native mobile or AWS backend platforms). Include references to your github / vercel links.
- Call to Action (CTA): Ask them to flag your resume/portfolio to whoever is screening this role.
`}

Email constraints:
- Output MUST be JSON format with exactly two keys: "subject" and "body".
- The Subject Line must be catchy, not spammy, and under 50 characters.
- The email body MUST be under 150 words.
- Highlight specific, real metrics from Harsh's CV only if relevant.
- Do NOT use generic placeholders like [Your Name].

JSON Output Format:
{
  "subject": "Email Subject",
  "body": "Email Body"
}
`;

    let attempts = 0;
    const maxAttempts = 3;
    let validation = { valid: false };
    let payload = null;
    let currentPrompt = prompt;
    let currentModel = model;

    while (attempts < maxAttempts && !validation.valid) {
      attempts++;
      let result;
      try {
        result = await currentModel.generateContent(currentPrompt);
      } catch (err) {
        if (err.message && (err.message.includes('429') || err.message.includes('quota') || err.message.includes('Quota') || err.message.includes('limit') || err.message.includes('Limit'))) {
          console.log(`[Outreach] Rate limit or quota hit. Trying fallback chain on attempt ${attempts}...`);
          const fallbacks = ['gemini-2.0-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'];
          let fallbackSuccess = false;
          
          for (const fallbackModel of fallbacks) {
            try {
              console.log(`[Outreach] Attempting fallback to ${fallbackModel}...`);
              const fallbackInstance = genAI.getGenerativeModel({ model: fallbackModel });
              result = await fallbackInstance.generateContent(currentPrompt);
              fallbackSuccess = true;
              currentModel = fallbackInstance;
              console.log(`[Outreach] Fallback to ${fallbackModel} succeeded!`);
              break;
            } catch (fallbackErr) {
              console.log(`[Outreach] Fallback to ${fallbackModel} failed: ${fallbackErr.message}`);
            }
          }
          
          if (!fallbackSuccess) {
            console.error('[Outreach] All fallback models failed. Re-throwing original rate-limit error.');
            throw err;
          }
        } else {
          throw err;
        }
      }
      
      let text = result.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        text = jsonMatch[0];
      }
      
      try {
        payload = JSON.parse(text);
        validation = verifyEmailConsistency(payload.body, cvMarkdown);
      } catch (parseErr) {
        validation = { valid: false, error: `JSON Parse Error: ${parseErr.message}` };
      }
      
      if (!validation.valid) {
        console.warn(`[Outreach] Email consistency gate failed on attempt ${attempts}: ${validation.error}`);
        if (attempts < maxAttempts) {
          console.log('[Outreach] Retrying with self-correction feedback...');
          currentPrompt = `${prompt}
          
  ⚠️  PREVIOUS ATTEMPT FAILED WITH CONSISTENCY ERROR:
  ${validation.error}
  
  Instructions to correct:
  1. Do NOT claim any project uses a database, framework, or cloud service that is not in its allowed list. Here is the canonical project stack mapping again:
  ${projectStacksStr}
  2. In this case, you claimed a project uses a forbidden technology. Make sure you rewrite the sentence referring to that project so it ONLY mentions its actual stack as listed above. Do not blend stacks to match the JD if they violate project facts.`;
        }
      }
    }

    if (!validation.valid) {
      console.warn(`[Outreach] Consistency gate could not converge after ${maxAttempts} attempts. Invoking safe fallback generator (Oryx experience only, no projects)...`);
      
      const fallbackPrompt = `${prompt}
      
  ⚠️ SAFETY FALLBACK GENERATION:
  The previous attempts to generate an email referencing projects failed consistency validation.
  To ensure absolute accuracy, you must write this draft referencing ONLY Harsh's work experience at Oryx International Logistics (Associate Software Engineer).
  - Do NOT mention or describe ANY projects (do NOT mention PanScience, SpendSight, LogiTrace, FeedFlow, or any other projects).
  - Highlight ONLY his production work at Oryx: Node.js, TypeScript, REST APIs, AWS Lambda, DynamoDB, API optimizations, and GitHub Actions CI/CD.
  - Output the email fully written in the same JSON format.`;

      try {
        let fallbackResult = await currentModel.generateContent(fallbackPrompt);
        let text = fallbackResult.response.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) text = jsonMatch[0];
        payload = JSON.parse(text);
        validation = verifyEmailConsistency(payload.body, cvMarkdown);
        
        console.log('[Outreach] Programmatically sanitizing any project references from safe fallback draft...');
        let sanitizedBody = payload.body;
        const sentences = sanitizedBody.split(/[.!?]\s+/);
        const cleanSentences = sentences.filter(s => {
          const lower = s.toLowerCase();
          return !projectsList.some(p => {
            const cleanTitle = p.title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim();
            const titleWords = cleanTitle.split(/\s+/).filter(w => w.length >= 3);
            let matchPhrases = [];
            if (['panscience', 'spendsight', 'logitrace', 'feedflow', 'binance', 'finstat', 'kyc'].includes(titleWords[0])) {
              matchPhrases = [titleWords[0]];
            } else {
              matchPhrases = [titleWords.slice(0, 2).join(' ')];
            }
            return matchPhrases.some(phrase => lower.includes(phrase));
          });
        });
        payload.body = cleanSentences.map(s => s.trim().replace(/\.$/, '')).join('. ') + '.';
        validation = { valid: true };
      } catch (fallbackErr) {
        console.error('[Outreach] Fallback generation failed:', fallbackErr.message);
        throw new Error(`[EMAIL CONSISTENCY GATE FAILURE] ${validation.error}`);
      }
    }
    
    return {
      subject: payload.subject,
      body: payload.body
    };
  } catch (err) {
    console.warn(`[Outreach] Live LLM email generation failed or rate-limited: ${err.message}. Falling back to high-quality offline draft compiler...`);
    return generateOfflineEmailDraft(companyName, leadName, leadTitle, cvMarkdown);
  }
}

export function parseProjectTechStacks(cvText) {
  const projectsMatch = cvText.match(/## Projects([\s\S]*?)(?=## Skills)/i);
  if (!projectsMatch) return [];
  const blocks = projectsMatch[1].split(/\n### /).filter(b => b.trim().length > 0);
  
  return blocks.map(block => {
    const cleanBlock = block.startsWith('### ') ? block : '### ' + block;
    const lines = cleanBlock.split('\n');
    const titleLine = lines[0].replace('###', '').trim();
    const cleanTitle = titleLine.split(' *(')[0].trim();
    const stackLine = lines.find(l => l.includes('Stack:')) || '';
    const cleanStack = stackLine.replace('**Stack:**', '').replace('Stack:', '').trim();
    
    const techWords = cleanStack.toLowerCase()
      .replace(/[^a-z0-9\s.-]/g, ' ')
      .split(/\s+/)
      .map(w => w.trim())
      .filter(w => w.length >= 2);
    
    return {
      title: cleanTitle,
      techWords
    };
  });
}

export function verifyEmailConsistency(emailBody, cvText) {
  if (!cvText) return { valid: true }; // Skip check if cvText is absent
  
  const projects = parseProjectTechStacks(cvText);
  const allTechWords = new Set();
  for (const p of projects) {
    for (const tw of p.techWords) {
      allTechWords.add(tw);
    }
  }
  
  const sentences = emailBody.split(/[.!?]\s+/).map(s => s.toLowerCase().trim());
  
  for (const sentence of sentences) {
    for (const p of projects) {
      const cleanTitle = p.title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim();
      const titleWords = cleanTitle.split(/\s+/).filter(w => w.length >= 3);
      let matchPhrases = [];
      if (['panscience', 'spendsight', 'logitrace', 'feedflow', 'binance', 'finstat', 'kyc'].includes(titleWords[0])) {
        matchPhrases = [titleWords[0]];
      } else {
        matchPhrases = [titleWords.slice(0, 2).join(' ')];
      }
      const hasProjectRef = matchPhrases.some(phrase => sentence.includes(phrase));
      
      if (hasProjectRef) {
        const sentenceWords = sentence.replace(/[^a-z0-9\s.-]/g, ' ')
          .split(/\s+/)
          .map(w => w.trim().replace(/^[.-]+|[.-]+$/g, ''))
          .filter(w => w.length >= 2);
        
        for (const word of sentenceWords) {
          if (allTechWords.has(word) && !p.techWords.includes(word)) {
            // Exceptions for general/common tech terms
            if (['js', 'react', 'api', 'apis', 'web', 'data', 'development', 'intern', 'engineering', 'actions', 'github', 'docker', 'native', 'bot', 'cli', 'ci', 'cd', 'git', 'cloud', 'database', 'backend', 'frontend', 'server', 'application', 'applications', 'testing', 'deployment', 'microservices', 'uptime', 'node', 'node.js', 'typescript', 'javascript', 'python', 'sql', 'c++', 'c', 'html', 'css', 'bash', 'shell', 'query', 'queries', 'streaming', 'stream', 'history', 'session', 'sessions', 'performance', 'optimization'].includes(word)) {
              continue;
            }
            
            // Substring checks
            if (p.techWords.some(tw => tw.includes(word) || word.includes(tw))) {
              continue;
            }
            
            return {
              valid: false,
              error: `Tech Stack Misattribution: Claimed ${p.title} uses "${word}". Allowed stack: ${p.techWords.join(', ')}`
            };
          }
        }
      }
    }
  }
  
  return { valid: true };
}

// Queue file I/O operations
export function loadOutreachQueue() {
  if (!existsSync(QUEUE_PATH)) {
    return { queue: {} };
  }
  try {
    return JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'));
  } catch (e) {
    return { queue: {} };
  }
}

export function saveOutreachQueue(queueData) {
  const dir = path.dirname(QUEUE_PATH);
  if (!existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  writeFileSync(QUEUE_PATH, JSON.stringify(queueData, null, 2), 'utf-8');
}
