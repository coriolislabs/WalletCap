// SPDX-License-Identifier: Apache-2.0
// The package ships spec/schema.sql and spec/upgrade.sql, the one copy of the ledger's rule,
// which lives at the repository's root. The build copies them into dist/spec/, where the ledger
// reads them (new URL('./spec/schema.sql', import.meta.url) from dist/ledger.js).
import { copyFileSync, mkdirSync } from 'node:fs';

const from = new URL('../../spec/', import.meta.url);
const to = new URL('../dist/spec/', import.meta.url);
mkdirSync(to, { recursive: true });
for (const name of ['schema.sql', 'upgrade.sql']) copyFileSync(new URL(name, from), new URL(name, to));
