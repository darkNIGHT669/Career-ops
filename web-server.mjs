import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import nodemailer from 'nodemailer';
import { 
  findLinkedInLead, 
  guessLeadEmail, 
  draftOutreachEmail, 
  loadOutreachQueue, 
  saveOutreachQueue, 
  extractDomain, 
  findCompanyDomain 
} from './outreach.mjs';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Parse the applications.md markdown table
function parseApplicationsTable() {
  const filePath = path.join(__dirname, 'data', 'applications.md');
  if (!fs.existsSync(filePath)) {
    return [];
  }
  
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const apps = [];
  
  for (const line of lines) {
    if (!line.includes('|')) continue;
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 10) continue;
    
    const numStr = parts[1];
    if (numStr === '#' || numStr === '---' || !/^\d+$/.test(numStr)) continue;
    
    // Parse Markdown link: [7](reports/007-spark-2026-07-01.md) -> reports/007-spark-2026-07-01.md
    let reportUrl = '';
    const linkMatch = parts[8].match(/\[.*?\]\((.*?)\)/);
    if (linkMatch) {
      reportUrl = linkMatch[1];
    }
    
    apps.push({
      num: parseInt(numStr),
      date: parts[2],
      company: parts[3],
      role: parts[4],
      score: parts[5],
      status: parts[6],
      pdf: parts[7],
      reportUrl: reportUrl,
      notes: parts[9]
    });
  }
  
  // Sort descending by number
  return apps.sort((a, b) => b.num - a.num);
}

// Find the latest report in reports/ directory
function getLatestReport() {
  const reportsDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      name: f,
      time: fs.statSync(path.join(reportsDir, f)).mtimeMs
    }))
    .sort((a, b) => b.time - a.time);
    
  return files.length > 0 ? files[0].name : null;
}

function updateApplicationStatusInMd(num, newStatus) {
  const filePath = path.join(__dirname, 'data', 'applications.md');
  if (!fs.existsSync(filePath)) return;
  
  let content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|')) continue;
    const parts = line.split('|');
    if (parts.length < 10) continue;
    
    if (parseInt(parts[1].trim()) === num) {
      parts[6] = ` ${newStatus} `;
      lines[i] = parts.join('|');
      break;
    }
  }
  
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

function extractUrlFromReport(reportRelativePath) {
  if (!reportRelativePath) return '';
  const reportPath = path.join(__dirname, reportRelativePath.replace(/^\.\.\//, ''));
  if (!fs.existsSync(reportPath)) return '';
  try {
    const content = fs.readFileSync(reportPath, 'utf-8');
    const match = content.match(/\*\*URL:\*\*\s*(.*)/i);
    return match ? match[1].trim() : '';
  } catch (e) {
    return '';
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  // Serve static UI Dashboard
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'dashboard', 'web', 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Dashboard source file not found.');
    }
    return;
  }

  // GET /api/applications
  if (url.pathname === '/api/applications' && method === 'GET') {
    try {
      const apps = parseApplicationsTable();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apps));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/report?url=...
  if (url.pathname === '/api/report' && method === 'GET') {
    const reportUrl = url.searchParams.get('url');
    if (!reportUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing report URL param' }));
      return;
    }
    
    // Normalize relative path if needed, e.g. "reports/..." or "../reports/..."
    const cleanPath = reportUrl.replace(/^\.\.\//, '');
    const reportPath = path.join(__dirname, cleanPath);
    
    if (fs.existsSync(reportPath)) {
      const content = fs.readFileSync(reportPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Report file not found: ${cleanPath}` }));
    }
    return;
  }

  // GET /api/cv
  if (url.pathname === '/api/cv' && method === 'GET') {
    const cvPath = path.join(__dirname, 'cv.md');
    if (fs.existsSync(cvPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: fs.readFileSync(cvPath, 'utf-8') }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cv.md not found' }));
    }
    return;
  }

  // POST /api/cv
  if (url.pathname === '/api/cv' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const cvPath = path.join(__dirname, 'cv.md');
        fs.writeFileSync(cvPath, payload.content, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST /api/evaluate
  if (url.pathname === '/api/evaluate' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { company, role, jd } = payload;
        
        // Write JD to a temporary file
        const tempJdName = `temp-web-eval.txt`;
        const tempJdPath = path.join(__dirname, 'jds', tempJdName);
        fs.writeFileSync(tempJdPath, `Role Title: ${role}\nCompany: ${company}\n\n${jd}`, 'utf-8');
        
        console.log(`Running evaluation on ${company} — ${role}...`);
        
        // Run gemini-eval
        execSync(`node gemini-eval.mjs --file ./jds/${tempJdName} --model gemini-3.1-flash-lite`, { stdio: 'inherit' });
        
        // Find the newly generated report
        const latestReportFile = getLatestReport();
        if (!latestReportFile) {
          throw new Error('No report was generated by gemini-eval.');
        }
        
        const reportPath = path.join(__dirname, 'reports', latestReportFile);
        const reportContent = fs.readFileSync(reportPath, 'utf-8');
        
        // Extract score from report
        // Pattern: **Score:** X.X/5 or Score: X.X/5
        const scoreMatch = reportContent.match(/\*\*Score:\*\*\s*([0-9.]+)\/5/i) || reportContent.match(/Score:\s*([0-9.]+)\/5/i);
        const score = scoreMatch ? scoreMatch[1] : '?.?';
        
        // Automatically compile tailored resume for the evaluated job description in the background (asynchronously)
        console.log(`Asynchronously tailoring resume for ${company} — ${role}...`);
        try {
          const tailorProc = spawn('node', ['scratch/tailor_cv.mjs', `./jds/${tempJdName}`], {
            detached: true,
            stdio: 'ignore'
          });
          tailorProc.unref();
        } catch (tailorErr) {
          console.error('Async auto-tailoring spawn failed:', tailorErr);
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          score,
          reportContent,
          reportUrl: `reports/${latestReportFile}`
        }));
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST /api/tailor
  if (url.pathname === '/api/tailor' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { source, jd, extraDetails } = payload;
        
        let targetJdPath = '';
        if (source === 'new') {
          targetJdPath = path.join(__dirname, 'jds', 'temp-web-tailor.txt');
          fs.writeFileSync(targetJdPath, jd, 'utf-8');
        } else if (source === 'recent') {
          targetJdPath = path.join(__dirname, 'jds', 'temp-web-eval.txt');
          if (!fs.existsSync(targetJdPath)) {
            targetJdPath = path.join(__dirname, 'jds', 'temp-web-tailor.txt');
          }
        }

        const tempExtraPath = path.join(__dirname, 'jds', 'temp-web-extra.txt');
        fs.writeFileSync(tempExtraPath, extraDetails || '', 'utf-8');
        
        console.log(`Compiling tailored resume using JD from: ${targetJdPath} and extra details from: ${tempExtraPath}`);
        execSync(`node scratch/tailor_cv.mjs "${targetJdPath}" "${tempExtraPath}"`, { stdio: 'inherit' });
        
        const pdfPath = path.join(__dirname, 'output', 'cv-harsh-dahiya-spark.pdf');
        const stats = fs.statSync(pdfPath);
        const sizeStr = `${(stats.size / 1024).toFixed(1)} KB`;
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, size: sizeStr }));
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // GET /api/download-pdf
  if (url.pathname === '/api/download-pdf' && method === 'GET') {
    const pdfPath = path.join(__dirname, 'output', 'cv-harsh-dahiya-spark.pdf');
    if (fs.existsSync(pdfPath)) {
      let filename = 'Harsh_Resume.pdf';
      try {
        const apps = parseApplicationsTable();
        if (apps.length > 0) {
          apps.sort((a, b) => b.num - a.num);
          const latest = apps[0];
          const numPadded = String(latest.num).padStart(3, '0');
          
          let suffix = '';
          const htmlPath = path.join(__dirname, 'output', 'cv-harsh-dahiya-spark.html');
          if (fs.existsSync(htmlPath)) {
            const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
            const matches = [...htmlContent.matchAll(/class=['"]competency-tag['"][^>]*>([\s\S]*?)<\/span>/gi)];
            const tags = matches.map(m => m[1].replace(/<[^>]*>/g, '').trim());
            
            const namingSkills = [
              'django', 'fastapi', 'flask', 'react native', 'expo', 'angular',
              'next.js', 'nextjs', 'aws', 'docker', 'kubernetes', 'arduino',
              'embedded', 'c++', 'typescript', 'python', 'node.js', 'nodejs',
              'mongodb', 'postgresql', 'mysql', 'redis', 'react'
            ];
            
            const found = namingSkills.find(skill => 
              tags.some(tag => {
                const cleanTag = tag.toLowerCase().replace(/[^a-z0-9\s.-]/g, '');
                return cleanTag === skill || cleanTag.includes(skill);
              })
            );
            
            if (found) {
              const cleanSuffix = found
                .split(/[\s.-]+/)
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join('')
                .replace(/\+/g, 'P'); // c++ -> CPP
              suffix = `_${cleanSuffix}`;
            }
          }
          filename = `Harsh_Resume_${numPadded}${suffix}.pdf`;
        }
      } catch (err) {
        console.error('Error determining dynamic resume download filename:', err);
      }

      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(fs.readFileSync(pdfPath));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('PDF Resume file not found. Run tailoring first.');
    }
    return;
  }

  // GET /api/download-html
  if (url.pathname === '/api/download-html' && method === 'GET') {
    const htmlPath = path.join(__dirname, 'output', 'cv-harsh-dahiya-spark.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('HTML Resume file not found. Run tailoring first.');
    }
    return;
  }

  // GET /api/outreach/list
  if (url.pathname === '/api/outreach/list' && method === 'GET') {
    try {
      const apps = parseApplicationsTable();
      const showAll = url.searchParams.get('all') === 'true';
      const matches = apps.filter(app => {
        if (showAll) return true;
        const scoreVal = parseFloat(app.score.split('/')[0]);
        return !isNaN(scoreVal) && scoreVal >= 4.2;
      });

      const queueData = loadOutreachQueue();
      const merged = matches.map(app => {
        const queueItem = queueData.queue[app.num] || {};
        const url = extractUrlFromReport(app.reportUrl);
        return {
          ...app,
          url,
          lead: queueItem.lead || null,
          leads: queueItem.leads || [],
          domain: queueItem.domain || extractDomain(url) || '',
          companyLinkedin: queueItem.companyLinkedin || '',
          emails: queueItem.emails || [],
          bestEmail: queueItem.bestEmail || '',
          draft: queueItem.draft || null,
          outreachStatus: queueItem.status || 'Ready'
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(merged));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/outreach/find-lead
  if (url.pathname === '/api/outreach/find-lead' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { num, company, reportUrl, companyLinkedin } = JSON.parse(body);
        
        console.log(`[Outreach] Searching lead for ${company} with LinkedIn URL: ${companyLinkedin || 'None'}...`);
        const leads = await findLinkedInLead(company, companyLinkedin);
        
        const url = extractUrlFromReport(reportUrl);
        let domain = extractDomain(url);
        if (!domain) {
          domain = await findCompanyDomain(company, companyLinkedin);
        }

        const queueData = loadOutreachQueue();

        if (leads && leads.length > 0 && domain) {
          console.log(`[Outreach] Found ${leads.length} leads for ${company} at ${domain}`);
          
          const leadsWithEmails = [];
          for (const l of leads) {
            const emails = await guessLeadEmail(l.name, domain);
            const bestEmail = emails[0] ? emails[0].email : '';
            leadsWithEmails.push({
              lead: l,
              emails,
              bestEmail,
              draft: null,
              status: 'Lead Found'
            });
          }
          
          queueData.queue[num] = {
            ...queueData.queue[num],
            company,
            domain,
            companyLinkedin,
            leads: leadsWithEmails,
            lead: leadsWithEmails[0].lead,
            emails: leadsWithEmails[0].emails,
            bestEmail: leadsWithEmails[0].bestEmail,
            status: queueData.queue[num]?.status === 'Sent' ? 'Sent' : 'Lead Found'
          };
          saveOutreachQueue(queueData);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, item: queueData.queue[num] }));
        } else {
          console.log(`[Outreach] No lead or domain found for ${company}.`);
          queueData.queue[num] = {
            ...queueData.queue[num],
            company,
            domain: domain || 'Not Found',
            leads: [],
            lead: { name: 'Not Found', title: 'N/A', linkedin: '' },
            emails: [],
            bestEmail: '',
            status: 'No Lead Found'
          };
          saveOutreachQueue(queueData);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Could not resolve lead name or company domain.', item: queueData.queue[num] }));
        }
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST /api/outreach/draft
  if (url.pathname === '/api/outreach/draft' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { num, company, leadName, leadTitle, reportUrl, jdText } = JSON.parse(body);
        
        let jdToUse = '';
        if (reportUrl) {
          const cleanPath = reportUrl.replace(/^\.\.\//, '');
          const reportPath = path.join(__dirname, cleanPath);
          if (fs.existsSync(reportPath)) {
            jdToUse = fs.readFileSync(reportPath, 'utf-8');
          }
        }
        
        if (!jdToUse && jdText) {
          jdToUse = jdText;
        }
        
        if (!jdToUse) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing both reportUrl and direct jdText in request body.' }));
          return;
        }
        
        console.log(`[Outreach] Drafting email for ${leadName} at ${company}...`);
        const draft = await draftOutreachEmail(jdToUse, company, leadName, leadTitle);
        
        const queueData = loadOutreachQueue();
        if (queueData.queue[num]) {
          const item = queueData.queue[num];
          if (item.leads && item.leads.length > 0) {
            const leadItem = item.leads.find(l => l.lead.name === leadName);
            if (leadItem) {
              leadItem.draft = draft;
              leadItem.status = leadItem.status === 'Sent' ? 'Sent' : 'Drafted';
            }
          }
          item.draft = draft;
          item.status = item.status === 'Sent' ? 'Sent' : 'Drafted';
          saveOutreachQueue(queueData);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, draft }));
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST /api/outreach/send
  if (url.pathname === '/api/outreach/send' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { num, to, subject, body: emailBody } = JSON.parse(body);
        
        const gmailUser = process.env.GMAIL_SENDER_EMAIL;
        const gmailPass = process.env.GMAIL_APP_PASSWORD;
        
        if (!gmailUser || !gmailPass) {
          throw new Error('Gmail SMTP credentials missing. Set GMAIL_SENDER_EMAIL and GMAIL_APP_PASSWORD in .env');
        }

        console.log(`[Outreach] Sending email to ${to}...`);
        
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: gmailUser,
            pass: gmailPass
          }
        });

        const senderDisplayName = process.env.SENDER_NAME || 'Harsh Dahiya';
        const mailOptions = {
          from: `"${senderDisplayName}" <${gmailUser}>`,
          to,
          subject,
          text: emailBody,
          replyTo: gmailUser
        };

        await transporter.sendMail(mailOptions);
        console.log(`[Outreach] Delivered successfully to ${to}`);
        
        // Update statuses
        const queueData = loadOutreachQueue();
        if (queueData.queue[num]) {
          const item = queueData.queue[num];
          if (item.leads && item.leads.length > 0) {
            const leadItem = item.leads.find(l => l.bestEmail === to || (l.emails && l.emails.some(e => e.email === to)));
            if (leadItem) {
              leadItem.status = 'Sent';
              leadItem.bestEmail = to;
            }
          }
          item.status = 'Sent';
          item.bestEmail = to; // save edited email if user changed it
          saveOutreachQueue(queueData);
        }
        
        // Update applications.md status to 'Applied'
        updateApplicationStatusInMd(num, 'Applied');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Endpoint not found.');
});

server.listen(PORT, () => {
  console.log(`\n🚀 Career-Ops Web Center dashboard running at: http://localhost:${PORT}`);
  console.log(`Press Ctrl+C to stop the server\n`);
});
