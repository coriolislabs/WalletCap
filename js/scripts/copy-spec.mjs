// SPDX-License-Identifier: Apache-2.0
// The package ships spec/schema.sql and spec/upgrade.sql, the one copy of the ledger's rule,
// which lives at the repository's root. This copies them in before tests and packing.
import { copyFileSync, mkdirSync } from 'node:fs';

const from = new URL('../../spec/', import.meta.url);
const to = new URL('../spec/', import.meta.url);
mkdirSync(to, { recursive: true });
for (const name of ['schema.sql', 'upgrade.sql']) copyFileSync(new URL(name, from), new URL(name, to));
