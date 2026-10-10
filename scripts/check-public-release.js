#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const failures = [];
const internalCompanyTermPattern = new RegExp(
  `\\b(?:${['c', 't', 'r', 'i', 'p'].join('')}|${['t', 'r', 'i', 'p'].join('')})\\b`,
  'i',
);

const requiredFiles = [
  'LICENSE',
  'README.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'docs/OPEN_CORE.md',
  'docs/RELEASE_CHECKLIST.md',
  'gateway.config.example.yaml',
  '.env.example',
  '.gitignore',
  '.dockerignore',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/workflows/ci.yml',
];

const forbiddenTrackedPathPatterns = [
  { name: 'local runtime config or backup', pattern: /(^|\/)gateway\.config\.ya?ml(?:\..+)?$/ },
  { name: 'local environment file', pattern: /(^|\/)\.env(?:\..+)?$/ },
  { name: 'macOS metadata', pattern: /(^|\/)\.DS_Store$/ },
  { name: 'dependency directory', pattern: /(^|\/)node_modules\// },
  { name: 'backend build output', pattern: /^dist\// },
  { name: 'runtime plugin build output', pattern: /^dist-runtime-plugins\// },
  { name: 'frontend build output', pattern: /^frontend\/dist\// },
  { name: 'coverage output', pattern: /(^|\/)coverage\// },
  { name: 'local data directory', pattern: /^data\// },
  { name: 'local browser artifacts', pattern: /^\.playwright-cli\// },
  { name: 'local development directory', pattern: /^\.local-dev\// },
  { name: 'local agent notes', pattern: /^\.claude\// },
  { name: 'private agent note', pattern: /^CLAUDE\.md$/ },
  { name: 'private workspace', pattern: /^siftgate-cloud\// },
  { name: 'private planning doc', pattern: /^CLOUD_DEVELOPMENT_(PLAN|PROMPTS)\.md$/ },
  { name: 'local generated output', pattern: /^output\// },
  { name: 'local public-skills cache', pattern: /^public-skills\// },
  { name: 'private review records', pattern: /^private-records\// },
  { name: 'Git history archive', pattern: /\.bundle$/i },
  { name: 'unreviewed design reference', pattern: /^frontend\/sample\.(png|jpe?g|webp)$/i },
];

// Credential formats, all test files, extensionless files and Git history are
// scanned by the pinned scanner (npm run security:scan). Do not maintain a
// weaker token-regex/whole-test-directory exemption here.
const forbiddenTextRules = [
  { name: 'local macOS home path', pattern: /\/Users\/[A-Za-z0-9._-]+/ },
];

const forbiddenAllTextRules = [
  { name: 'internal company term', pattern: internalCompanyTermPattern },
  { name: 'internal coding-plan example id', pattern: new RegExp(['ada', 'coding', 'plan'].join('-'), 'i') },
  { name: 'internal coding-plan example name', pattern: new RegExp(['ADA', 'Coding', 'Plan'].join(' ')) },
  { name: 'internal provider env prefix', pattern: new RegExp(['ADA', 'CLAUDE'].join('_'), 'i') },
];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) {
    failures.push(`Missing required public repository file: ${file}`);
  }
}

const trackedFiles = git(['ls-files']);
for (const file of trackedFiles) {
  if (file.endsWith('/.env.example') || file === '.env.example') continue;
  for (const rule of forbiddenTrackedPathPatterns) {
    if (rule.pattern.test(file)) {
      failures.push(`${file}: tracked ${rule.name}`);
    }
  }
}

scanTrackedTextFiles(trackedFiles);
checkPackageMetadata('package.json', { rootPackage: true });
checkPackageMetadata('packages/client/package.json', { rootPackage: false });

const gitignore = readIfExists('.gitignore');
for (const requiredIgnore of [
  'gateway.config.yaml',
  '.env',
  'siftgate-cloud/',
  'dist/',
  'dist-runtime-plugins/',
  'coverage/',
  'node_modules/',
]) {
  if (!gitignore.includes(requiredIgnore)) {
    failures.push(`.gitignore should include ${requiredIgnore}`);
  }
}

if (failures.length > 0) {
  console.error('Public release check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Public release check passed (${trackedFiles.length} tracked files scanned).`);

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function readIfExists(relPath) {
  const abs = path.join(root, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

function scanTrackedTextFiles(files) {
  for (const file of files) {
    if (!isScannableTextPath(file)) continue;

    const text = readIfExists(file);
    for (const rule of forbiddenAllTextRules) {
      if (rule.pattern.test(text)) {
        failures.push(`${file}: forbidden ${rule.name}`);
      }
    }
    for (const rule of forbiddenTextRules) {
      if (rule.pattern.test(text)) {
        failures.push(`${file}: forbidden ${rule.name}`);
      }
    }
  }
}

function isScannableTextPath(file) {
  const data = fs.readFileSync(path.join(root, file));
  return !data.includes(0); // Include dotfiles/extensionless text, never raw binary.
}

function checkPackageMetadata(relPath, options) {
  const text = readIfExists(relPath);
  if (!text) return;

  const pkg = JSON.parse(text);
  if (!pkg.license) {
    failures.push(`${relPath}: missing license field`);
  }

  if (options.rootPackage) {
    if (pkg.private !== true) {
      failures.push(`${relPath}: root package should keep private=true until npm publication is intentional`);
    }
    if (pkg.aiGatewayRelease?.distribution !== 'GitHub source and Docker image') {
      failures.push(`${relPath}: aiGatewayRelease.distribution should describe the public distribution channel`);
    }
  }
}
