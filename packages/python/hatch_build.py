# SPDX-License-Identifier: Apache-2.0
"""Put the ledger's rule, spec/schema.sql and spec/upgrade.sql, inside the package.

The repository's spec/ is the one copy. Built from the repository, the wheel gets it at
walletcap/spec/ and the sdist at src/walletcap/spec/, so a wheel built from that sdist has it
too. Built from an sdist, the copy the sdist carries is packaged as it is, and nothing outside the
sdist is read, whatever sits two levels up.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

FILES = ("schema.sql", "upgrade.sql")


class SpecHook(BuildHookInterface):  # type: ignore[type-arg]
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        if self.target_name == "sdist":
            # Hatchling adds the repository's .gitignore to every sdist; it isn't the package's.
            force_include = build_data["force_include"]
            ignored = [path for path, target in force_include.items() if target == ".gitignore"]
            for source in ignored:
                del force_include[source]
        root = Path(self.root)
        packaged = root / "src" / "walletcap" / "spec"
        # An unpacked sdist (it has PKG-INFO) carries the rule, and builds from that copy alone.
        # It never looks above its own root: pip unpacks a source build under the temp folder, so
        # "two levels up" there is a place any local user can write a spec/ into.
        if (root / "PKG-INFO").is_file() or root.parent.name != "packages":
            if not all((packaged / name).is_file() for name in FILES):
                raise FileNotFoundError(
                    "walletcap's spec/schema.sql and spec/upgrade.sql are missing from the sdist"
                )
            return
        spec = root.parent.parent / "spec"
        if not all((spec / name).is_file() for name in FILES):
            raise FileNotFoundError("walletcap's spec/schema.sql and spec/upgrade.sql are missing")
        where = "walletcap/spec" if self.target_name == "wheel" else "src/walletcap/spec"
        for name in FILES:
            build_data["force_include"][str(spec / name)] = f"{where}/{name}"
