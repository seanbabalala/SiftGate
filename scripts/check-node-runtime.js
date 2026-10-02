#!/usr/bin/env node
'use strict';

// Dependency-free: safe to run before npm ci. No registry credentials belong in .npmrc.
const fs = require('node:fs');
const path = require('node:path');

const NODE_MAJOR = 22;
const NODE_MIN_MINOR = 13;
const NODE_RANGE = '>=22.13.0 <23';

function supportsNode(version) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return Boolean(parts && Number(parts[1]) === NODE_MAJOR && Number(parts[2]) >= NODE_MIN_MINOR);
}

function checkNodeContract(root, version = process.versions.node) {
  const failures = [];
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  expect(supportsNode(version), `Use Node ${NODE_RANGE}; current runtime is ${version}`);
  expect(read('.nvmrc').trim() === String(NODE_MAJOR), '.nvmrc must select the Node 22 release line');
  for (const prefix of ['', 'frontend/']) {
    const pkg = JSON.parse(read(`${prefix}package.json`));
    const lock = JSON.parse(read(`${prefix}package-lock.json`));
    expect(pkg.engines?.node === NODE_RANGE, `${prefix}package.json engines.node must be ${NODE_RANGE}`);
    expect(lock.packages?.['']?.engines?.node === NODE_RANGE, `${prefix}package-lock.json root engines must match`);
    expect(read(`${prefix}.npmrc`).trim() === 'engine-strict=true',
      `${prefix}.npmrc must contain only engine-strict=true (never registry credentials)`);
  }
  const dockerfile = read('Dockerfile');
  expect(/^ARG NODE_IMAGE=node:22-alpine(?:@sha256:[a-f0-9]{64})?$/m.test(dockerfile),
    'Dockerfile default NODE_IMAGE must use Node 22 Alpine');
  for (const stage of dockerfile.split(/^FROM /m).slice(1)) {
    expect(stage.startsWith('${NODE_IMAGE} '), 'All Docker stages must inherit NODE_IMAGE');
    const install = stage.indexOf('RUN npm ci');
    if (install !== -1) {
      expect(/^COPY (?:frontend\/)?\.npmrc \.\/$/m.test(stage.slice(0, install)),
        'Each Docker npm ci stage must copy its credential-free .npmrc first');
    }
  }
  for (const file of fs.readdirSync(path.join(root, '.github/workflows')).filter(f => /\.ya?ml$/.test(f))) {
    const text = read(`.github/workflows/${file}`);
    const setups = (text.match(/uses: actions\/setup-node@/g) || []).length;
    const selectors = (text.match(/node-version-file:\s*['"]?\.nvmrc['"]?\s*$/gm) || []).length;
    expect(!/^\s*node-version:/m.test(text), `${file} must read .nvmrc instead of hardcoding a Node version`);
    expect(setups === selectors, `${file} must configure every setup-node step from .nvmrc`);
  }
  return failures;
}

if (require.main === module) {
  try {
    const failures = checkNodeContract(path.resolve(__dirname, '..'));
    if (failures.length) throw new Error(failures.join('\n'));
    console.log(`Node runtime contract passed (${process.versions.node}; ${NODE_RANGE}).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkNodeContract, supportsNode, NODE_RANGE };
