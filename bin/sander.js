#!/usr/bin/env node
'use strict';
const { main } = require('../dist/cli/main.js');
main(process.argv.slice(2)).catch((err) => {
  console.error(`sander: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
