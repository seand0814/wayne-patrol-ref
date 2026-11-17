// `node --test tests/` resolves this directory to tests/index.js (Node 22 does
// not expand a directory argument), so load every *.test.mjs file from here.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort()) {
  import(pathToFileURL(path.join(__dirname, f)).href);
}
