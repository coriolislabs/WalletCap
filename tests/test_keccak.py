# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

from walletcap._keccak import keccak256


def test_keccak256_matches_the_ethereum_vectors() -> None:
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256(b"abc").hex() == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    assert keccak256(b"testing").hex() == "5f16f4c7f149ac4f9510d9cf8cf384038ad348b3bcdc01915f95de12df9d1b02"
