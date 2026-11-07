#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Stand-in for the awal CLI binary, for the tests only. It never signs or
// sends anything: for a passthrough command it echoes what it was asked,
// so the test can see the command reached awal unchanged.
process.stdout.write(`awal ${process.argv.slice(2).join(' ')}\n`);
