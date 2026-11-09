#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const failures = [];

const rootPackage = readJson('package.json');
const releaseVersion = rootPackage.version;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) {
  failures.push(`package.json version is not a valid release version: ${releaseVersion}`);
}

expectJsonVersion('frontend/package.json', releaseVersion);
expectJsonVersion('packages/client/package.json', releaseVersion);
expectJsonVersion('package-lock.json', releaseVersion);
expectJsonPath('package-lock.json', ['packages', '', 'version'], releaseVersion);
expectJsonPath('package-lock.json', ['packages', 'packages/client', 'version'], releaseVersion);
expectJsonVersion('frontend/package-lock.json', releaseVersion);
expectJsonPath('frontend/package-lock.json', ['packages', '', 'version'], releaseVersion);

expectRegexValue('packages/python/pyproject.toml', /^version = "([^"]+)"$/m, releaseVersion);
expectRegexValue('deploy/helm/siftgate/Chart.yaml', /^version:\s*([^\s]+)$/m, releaseVersion);
expectRegexValue('deploy/helm/siftgate/Chart.yaml', /^appVersion:\s*"([^"]+)"$/m, releaseVersion);
expectRegexValue(
  'deploy/kubernetes/base/deployment.yaml',
  /image:\s*ghcr\.io\/seanbabalala\/ai-gateway:([^\s]+)/,
  releaseVersion,
);
expectRegexValue('src/openapi/setup-openapi.ts', /\.setVersion\('([^']+)'\)/, releaseVersion);
expectFileIncludes('README.md', `Current release: **v${releaseVersion}`);
expectFileIncludes('README.md', `img.shields.io/badge/release-v${releaseVersion}-`);
expectFileIncludes('README.md', `/releases/tag/v${releaseVersion}`);
expectFileIncludes('CHANGELOG.md', `## ${releaseVersion} -`);
expectFileIncludes('docs/BASELINE.md', `Release: **v${releaseVersion}**`);
expectFileIncludes('test/unit/release-version-sync.spec.ts', `expect(rootPackage.version).toBe('${releaseVersion}')`);

if (failures.length > 0) {
  console.error('Release version check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release version check passed for v${releaseVersion}.`);

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf8'));
}

function expectJsonVersion(relPath, expected) {
  const actual = readJson(relPath).version;
  if (actual !== expected) {
    failures.push(`${relPath}: version is ${actual}, expected ${expected}`);
  }
}

function expectJsonPath(relPath, parts, expected) {
  let current = readJson(relPath);
  for (const part of parts) current = current?.[part];
  if (current !== expected) {
    failures.push(`${relPath}: ${parts.join('.')} is ${current}, expected ${expected}`);
  }
}

function expectRegexValue(relPath, pattern, expected) {
  const text = fs.readFileSync(path.join(root, relPath), 'utf8');
  const actual = text.match(pattern)?.[1];
  if (actual !== expected) {
    failures.push(`${relPath}: matched version is ${actual ?? '<missing>'}, expected ${expected}`);
  }
}

function expectFileIncludes(relPath, expectedText) {
  const text = fs.readFileSync(path.join(root, relPath), 'utf8');
  if (!text.includes(expectedText)) {
    failures.push(`${relPath}: missing "${expectedText}"`);
  }
}
