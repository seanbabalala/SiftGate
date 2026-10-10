#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');

const requiredFiles = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'docs/README.md',
  'docs/BASELINE.md',
  'docs/assets/brand/siftgate-logo.svg',
  'docs/assets/brand/siftgate-mark.svg',
  'docs/QUICKSTART.md',
  'docs/AGENT_GATEWAY.md',
  'docs/PRODUCTION.md',
  'docs/KUBERNETES.md',
  'docs/PROVIDER_CATALOG.md',
  'docs/SDKS.md',
  'docs/PLAYGROUND.md',
  'docs/MCP_GATEWAY.md',
  'docs/BATCH_API.md',
  'docs/CACHING.md',
  'docs/EVALUATION_FRAMEWORK.md',
  'docs/SECURITY.md',
  'docs/PUBLICATION_SECURITY.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config_help.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/i18n/en/README.md',
  'docs/i18n/zh/README.md',
  'docs/i18n/zh-TW/README.md',
  'docs/i18n/ja/README.md',
  'docs/i18n/ko/README.md',
  'docs/i18n/th/README.md',
  'docs/i18n/es/README.md',
];

const scanRoots = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'docs',
  '.github',
];

const privateRepoPattern = new RegExp(`${'siftgate'}[-_]${'cloud'}|/${'siftgate'}[-_]${'cloud'}`, 'i');
const privateKeyBlockPattern = new RegExp(['-----BEGIN ', '[A-Z ]*', 'PRIV' + 'ATE KEY-----'].join(''));
const knownInternalLabelPattern = new RegExp(
  `\\b(?:${['c', 't', 'r', 'i', 'p'].join('')}|${['token', 'flux'].join('')})\\b`,
  'i',
);

const forbiddenPatterns = [
  { name: 'internal reference repository identity', pattern: new RegExp(['relay', 'saas'].join('-'), 'i') },
  { name: 'private repo reference', pattern: privateRepoPattern },
  { name: 'OpenAI-style secret key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'Gateway secret key', pattern: /\bgw_sk_[A-Za-z0-9_]{16,}\b/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', pattern: privateKeyBlockPattern },
  { name: 'bearer token literal', pattern: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/ },
  { name: 'local macOS home path', pattern: /\/Users\/[A-Za-z0-9._-]+/ },
  { name: 'internal planning source', pattern: /\b(V2_EXECUTION_PROMPTS|OPEN_SOURCE_OPTIMIZATION_PLAN|PRODUCT_ROADMAP|GATEWAY_ROADMAP)\b/ },
  { name: 'known internal provider label', pattern: knownInternalLabelPattern },
  { name: 'private intranet planning phrase', pattern: /公司内网/ },
];

const failures = [];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) {
    failures.push(`Missing required documentation/community file: ${file}`);
  }
}

for (const file of collectFiles(scanRoots)) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(text)) {
      failures.push(`${rel}: forbidden ${rule.name}`);
    }
  }
  if (file.endsWith('.md')) {
    checkMarkdownLinks(file, text);
  }
}

const gitignore = fs.existsSync(path.join(root, '.gitignore'))
  ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
  : '';
if (!gitignore.includes('gateway.config.yaml')) {
  failures.push('.gitignore should ignore gateway.config.yaml');
}

if (isGitTracked('gateway.config.yaml')) {
  failures.push('gateway.config.yaml is tracked by git; keep local runtime config out of release commits.');
}

if (failures.length > 0) {
  console.error('Documentation check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Documentation check passed (${requiredFiles.length} required files, ${collectFiles(scanRoots).length} scanned files).`);

function collectFiles(entries) {
  const files = [];
  for (const entry of entries) {
    const abs = path.join(root, entry);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      files.push(abs);
      continue;
    }
    walk(abs, files);
  }
  return files.filter((file) => /\.(md|ya?ml)$/i.test(file));
}

function walk(dir, files) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      walk(abs, files);
    } else if (stat.isFile()) {
      files.push(abs);
    }
  }
}

function checkMarkdownLinks(file, text) {
  const markdownLinkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  const htmlHrefPattern = /href="([^"]+)"/g;
  for (const match of text.matchAll(markdownLinkPattern)) {
    checkLink(file, match[1]);
  }
  for (const match of text.matchAll(htmlHrefPattern)) {
    checkLink(file, match[1]);
  }
}

function checkLink(file, rawLink) {
  const link = rawLink.trim();
  if (
    !link ||
    link.startsWith('#') ||
    /^[a-z][a-z0-9+.-]*:/i.test(link)
  ) {
    return;
  }
  const withoutTitle = link.split(/\s+/)[0];
  const withoutAnchor = withoutTitle.split('#')[0];
  if (!withoutAnchor) return;
  const target = path.resolve(path.dirname(file), withoutAnchor);
  if (!target.startsWith(root)) {
    failures.push(`${path.relative(root, file)}: link escapes repository: ${link}`);
    return;
  }
  if (!fs.existsSync(target)) {
    failures.push(`${path.relative(root, file)}: broken link ${link}`);
  }
}

function isGitTracked(file) {
  try {
    execSync(`git ls-files --error-unmatch ${JSON.stringify(file)}`, {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch (_err) {
    return false;
  }
}
