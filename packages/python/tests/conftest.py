"""The package reads spec/*.sql from inside itself; tests run from the source tree get a copy.

In the repository the copy comes from spec/, the one source. Where there is no spec/ two levels
up, the package's own copy (src/walletcap/spec, which the build puts there) is used as it is.
"""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
SPEC = ROOT / "src" / "walletcap" / "spec"
FILES = ("schema.sql", "upgrade.sql")
if all((REPO / "spec" / name).is_file() for name in FILES):
    SPEC.mkdir(exist_ok=True)
    for name in FILES:
        shutil.copyfile(REPO / "spec" / name, SPEC / name)
elif not all((SPEC / name).is_file() for name in FILES):
    raise FileNotFoundError(f"no spec/ at {REPO} and no packaged copy at {SPEC}")
