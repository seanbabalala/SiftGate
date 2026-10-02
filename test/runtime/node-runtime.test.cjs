'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { checkNodeContract, supportsNode } = require('../../scripts/check-node-runtime');

const root = path.resolve(__dirname, '../..');

test('only the supported Node 22 range is accepted', () => {
  for (const version of ['20.19.0', '22.0.0', '22.12.9', '23.0.0', '24.12.0', '22', '22.13.0-rc.1']) {
    assert.equal(supportsNode(version), false, version);
  }
  for (const version of ['22.13.0', '22.23.2', 'v22.23.3']) assert.equal(supportsNode(version), true, version);
});

test('committed runtime policy stays aligned across manifests, Docker and workflows', () => {
  assert.deepEqual(checkNodeContract(root, '22.23.2'), []);
  assert.ok(checkNodeContract(root, '24.12.0').some(message => message.includes('current runtime')));
});

test('npm actually enforces the committed engine-strict setting before installing', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-engine-install-'));
  try {
    fs.copyFileSync(path.join(root, '.npmrc'), path.join(fixture, '.npmrc'));
    const pkg = { name: 'siftgate-engine-fixture', version: '1.0.0', engines: { node: '>=99' } };
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(fixture, 'package-lock.json'), JSON.stringify({
      name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg },
    }));
    const result = spawnSync('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--cache', path.join(fixture, 'cache')], { cwd: fixture, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EBADENGINE/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

for (const [file, change, expected] of [
  ['.nvmrc', () => '20\n', '.nvmrc'],
  ['package.json', text => text.replace('>=22.13.0 <23', '>=20'), 'package.json engines'],
  ['frontend/package-lock.json', text => text.replace('>=22.13.0 <23', '>=20'), 'root engines'],
  ['.npmrc', () => 'engine-strict=false\n', '.npmrc'],
  ['Dockerfile', text => text.replace('ARG NODE_IMAGE=node:22-alpine', 'ARG NODE_IMAGE=node:20-alpine'), 'NODE_IMAGE'],
  ['Dockerfile', text => text.replace('COPY frontend/.npmrc ./\n', ''), 'npm ci stage'],
  ['.github/workflows/ci.yml', text => text.replace('node-version-file: .nvmrc', 'node-version: 20'), 'hardcoding'],
]) {
  test(`reject runtime drift in ${file}: ${expected}`, () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-node-contract-'));
    try {
      for (const item of ['.nvmrc', '.npmrc', 'package.json', 'package-lock.json', 'frontend/.npmrc',
        'frontend/package.json', 'frontend/package-lock.json', 'Dockerfile']) {
        fs.mkdirSync(path.dirname(path.join(fixture, item)), { recursive: true });
        fs.copyFileSync(path.join(root, item), path.join(fixture, item));
      }
      fs.cpSync(path.join(root, '.github/workflows'), path.join(fixture, '.github/workflows'), { recursive: true });
      fs.writeFileSync(path.join(fixture, file), change(fs.readFileSync(path.join(fixture, file), 'utf8')));
      assert.ok(checkNodeContract(fixture, '22.23.2').some(message => message.includes(expected)));
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
}
