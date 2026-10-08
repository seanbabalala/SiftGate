'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'dist/alerts/alert-connector-runtime.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(path.join(root, 'src/alerts/alert-connector-runtime.js'), target);
