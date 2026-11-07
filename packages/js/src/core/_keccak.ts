// SPDX-License-Identifier: Apache-2.0
// Keccak-256, for EIP-55 address checksums. No dependencies: this is Keccak-f[1600] with the
// original Keccak padding, which is what Ethereum uses. (node:crypto's sha3-256 is NIST SHA3, a
// different padding.)

const MASK = (1n << 64n) - 1n;

const RC: readonly bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

const ROT: readonly (readonly number[])[] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const rotl = (value: bigint, amount: number): bigint => (amount === 0 ? value & MASK : ((value << BigInt(amount)) | (value >> BigInt(64 - amount))) & MASK);

// Every index below is in range by construction: lanes 0-24, columns 0-4.
const at = <T>(list: readonly T[], index: number): T => list[index] as T;

function permute(state: bigint[]): void {
  for (const rc of RC) {
    const c: bigint[] = [];
    for (let x = 0; x < 5; x += 1) {
      c[x] = at(state, x) ^ at(state, x + 5) ^ at(state, x + 10) ^ at(state, x + 15) ^ at(state, x + 20);
    }
    const d: bigint[] = [];
    for (let x = 0; x < 5; x += 1) {
      d[x] = at(c, (x + 4) % 5) ^ rotl(at(c, (x + 1) % 5), 1);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] = at(state, x + 5 * y) ^ at(d, x);
    }
    const b: bigint[] = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(at(state, x + 5 * y), at(at(ROT, x), y));
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (at(b, x + 5 * y) ^ (~at(b, ((x + 1) % 5) + 5 * y) & MASK & at(b, ((x + 2) % 5) + 5 * y))) & MASK;
      }
    }
    state[0] = at(state, 0) ^ rc;
  }
}

export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136;
  const bytes = Array.from(data);
  bytes.push(0x01);
  while (bytes.length % rate !== rate - 1) bytes.push(0x00);
  bytes.push(0x80);

  const state: bigint[] = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < bytes.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let value = 0n;
      for (let j = 0; j < 8; j += 1) {
        value |= BigInt(at(bytes, offset + lane * 8 + j)) << BigInt(8 * j);
      }
      state[lane] = at(state, lane) ^ value;
    }
    permute(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i += 1) {
    let value = at(state, i);
    for (let j = 0; j < 8; j += 1) {
      out[i * 8 + j] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return out;
}

export const keccak256Hex = (text: string): string => Buffer.from(keccak256(new TextEncoder().encode(text))).toString('hex');
