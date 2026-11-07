# SPDX-License-Identifier: Apache-2.0
"""walletcap's version, from its installed metadata.

From a source checkout that isn't installed, it is read from the pyproject.toml beside src/.
"""

from __future__ import annotations

import tomllib
from importlib import metadata
from pathlib import Path


def version() -> str:
    try:
        return metadata.version("walletcap")
    except metadata.PackageNotFoundError:
        pyproject = Path(__file__).resolve().parents[2] / "pyproject.toml"
        if pyproject.is_file():
            with pyproject.open("rb") as file:
                return str(tomllib.load(file)["project"]["version"])
        return "0+unknown"
