// SPDX-License-Identifier: Apache-2.0
// Keccak-256, for EIP-55 address checksums. No dependencies: this is
// Keccak-f[1600] with the original Keccak padding, which is what Ethereum
// uses. (node:crypto's sha3-256 is NIST SHA3, a different padding.)

const MASK = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const rotl = (value, amount) => amount === 0
  ? value & MASK
  : ((value << BigInt(amount)) | (value >> BigInt(64 - amount))) & MASK;

function permute(state) {
  for (const rc of RC) {
    const c = [];
    for (let x = 0; x < 5; x += 1) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    const d = [];
    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] ^= d[x];
    }
    const b = new Array(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROT[x][y]);
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (b[x + 5 * y] ^ ((~b[(x + 1) % 5 + 5 * y] & MASK) & b[(x + 2) % 5 + 5 * y])) & MASK;
      }
    }
    state[0] ^= rc;
  }
}

export function keccak256(data) {
  const rate = 136;
  const bytes = Array.from(data);
  bytes.push(0x01);
  while (bytes.length % rate !== rate - 1) bytes.push(0x00);
  bytes.push(0x80);

  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < bytes.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let value = 0n;
      for (let j = 0; j < 8; j += 1) {
        value |= BigInt(bytes[offset + lane * 8 + j]) << BigInt(8 * j);
      }
      state[lane] ^= value;
    }
    permute(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i += 1) {
    let value = state[i];
    for (let j = 0; j < 8; j += 1) {
      out[i * 8 + j] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return out;
}

export const keccak256Hex = text => Buffer.from(keccak256(new TextEncoder().encode(text))).toString('hex');
