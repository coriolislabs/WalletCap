"""The package reads spec/*.sql from inside itself; tests run from the source tree get a copy."""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
SPEC = ROOT / "src" / "walletcap" / "spec"
SPEC.mkdir(exist_ok=True)
for name in ("schema.sql", "upgrade.sql"):
    shutil.copyfile(REPO / "spec" / name, SPEC / name)
