'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { checkResults } = require('../../scripts/check-ci-test-results');
const commit = 'a'.repeat(40);

function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-shards-'));
  try {
    for (const kind of ['unit', 'e2e']) for (let shard = 1; shard <= 4; shard++) {
      const directory = path.join(root, `ci-tests-${kind}-${shard}`);
      fs.mkdirSync(directory);
      const discovery = [1, 2, 3, 4].map(n => `/synthetic/${kind}-${n}.ts`);
      const result = { success: true, numFailedTestSuites: 0, numFailedTests: 0, numPendingTestSuites: 0,
        numPendingTests: 0, numRuntimeErrorTestSuites: 0, numTodoTests: 0, numTotalTests: 1,
        numPassedTests: 1, numTotalTestSuites: 1, numPassedTestSuites: 1,
        testResults: [{ name: discovery[shard - 1], status: 'passed', assertionResults: [{ status: 'passed' }] }] };
      fs.writeFileSync(path.join(directory, 'identity.json'), JSON.stringify({ kind, shard, totalShards: 4, commit }));
      fs.writeFileSync(path.join(directory, 'discovery.json'), JSON.stringify(discovery));
      fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(result));
    }
    callback(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('all suites from all shards are accounted for', () => fixture(root => {
  assert.deepEqual(checkResults(root, commit, { unit: 4, e2e: 4 }), [
    { kind: 'unit', suites: 4, tests: 4, skipped: 0 }, { kind: 'e2e', suites: 4, tests: 4, skipped: 0 },
  ]);
}));

for (const [name, change] of [
  ['skipped test', result => { result.numPendingTests = 1; }],
  ['failed assertion', result => { result.testResults[0].assertionResults[0].status = 'failed'; }],
  ['duplicate suite', result => { result.testResults[0].name = '/synthetic/unit-2.ts'; }],
  ['undiscovered suite', result => { result.testResults[0].name = '/synthetic/foreign.ts'; }],
  ['inflated count', result => { result.numTotalTests = result.numPassedTests = 2; }],
]) test(`reject ${name}`, () => fixture(root => {
  const file = path.join(root, 'ci-tests-unit-1/results.json');
  const result = JSON.parse(fs.readFileSync(file)); change(result); fs.writeFileSync(file, JSON.stringify(result));
  assert.throws(() => checkResults(root, commit, { unit: 4, e2e: 4 }));
}));

test('missing shard, wrong commit and reduced test count fail closed', () => fixture(root => {
  assert.throws(() => checkResults(root, 'b'.repeat(40), { unit: 4, e2e: 4 }));
  assert.throws(() => checkResults(root, commit, { unit: 5, e2e: 4 }));
  fs.unlinkSync(path.join(root, 'ci-tests-e2e-4/results.json'));
  assert.throws(() => checkResults(root, commit, { unit: 4, e2e: 4 }));
}));
