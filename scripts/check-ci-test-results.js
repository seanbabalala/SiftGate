#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function checkResults(directory, commit, minimums = { unit: 4472, e2e: 818 }) {
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const summaries = [];
  for (const kind of ['unit', 'e2e']) {
    let expected;
    const seen = new Set();
    let tests = 0;
    for (let shard = 1; shard <= 4; shard++) {
      const root = path.join(directory, `ci-tests-${kind}-${shard}`);
      assert.deepEqual(read(path.join(root, 'identity.json')), { kind, shard, totalShards: 4, commit });
      const discovery = read(path.join(root, 'discovery.json'));
      assert.ok(Array.isArray(discovery) && discovery.length > 0 && discovery.every(file => typeof file === 'string'));
      assert.equal(new Set(discovery).size, discovery.length, 'Duplicate discovered suite');
      const sorted = discovery.slice().sort();
      if (expected) assert.deepEqual(sorted, expected, 'Shards disagree about full discovery');
      expected = sorted;
      const result = read(path.join(root, 'results.json'));
      assert.equal(result.success, true, 'A shard did not pass');
      for (const field of ['numFailedTestSuites', 'numFailedTests', 'numPendingTestSuites', 'numPendingTests',
        'numRuntimeErrorTestSuites', 'numTodoTests']) assert.equal(result[field], 0, `Nonzero ${field}`);
      assert.ok(result.numTotalTests > 0, 'Empty shard');
      assert.equal(result.numTotalTests, result.numPassedTests);
      assert.equal(result.numTotalTestSuites, result.numPassedTestSuites);
      assert.equal(result.testResults.length, result.numTotalTestSuites);
      let assertions = 0;
      for (const suite of result.testResults) {
        assert.equal(suite.status, 'passed');
        assert.ok(expected.includes(suite.name), 'Undiscovered suite was run');
        assert.ok(!seen.has(suite.name), 'Suite repeated across shards');
        seen.add(suite.name);
        assert.ok(suite.assertionResults.length > 0, 'Empty suite');
        for (const assertion of suite.assertionResults) assert.equal(assertion.status, 'passed');
        assertions += suite.assertionResults.length;
      }
      assert.equal(assertions, result.numTotalTests, 'Assertion accounting mismatch');
      tests += assertions;
    }
    assert.deepEqual([...seen].sort(), expected, 'Discovered suites missing from results');
    assert.ok(tests >= minimums[kind], `Test count fell below the accepted ${kind} baseline`);
    summaries.push({ kind, suites: seen.size, tests, skipped: 0 });
  }
  return summaries;
}

if (require.main === module) {
  const [, , directory, commit] = process.argv;
  try {
    assert.ok(directory && /^[a-f0-9]{40}$/.test(commit), 'Usage: check-ci-test-results.js <directory> <commit>');
    for (const result of checkResults(directory, commit)) {
      console.log(`${result.kind}: ${result.suites} suites, ${result.tests} tests passed, zero skipped; all four shards verified.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkResults };
