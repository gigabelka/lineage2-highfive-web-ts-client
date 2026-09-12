import { describe, expect, it } from "vitest";

import { blowfishDecrypt, blowfishEncrypt } from "@client/net/crypto/blowfish";
import { GameCrypt } from "@client/net/crypto/game-crypt";
import { LoginCrypt } from "@client/net/crypto/login-crypt";
import { NewCrypt } from "@client/net/crypto/new-crypt";
import { buildCredentialPlaintext, encryptCredentials } from "@client/net/crypto/rsa-crypt";
import { bigIntToBytesBE, bytesToBigIntBE, modPow } from "@client/net/binary/bigint-bytes";
import { equals } from "@client/net/binary/bytes";
import { unscrambleModulus } from "@client/net/crypto/scrambled-rsa-key";

function bytes(hexString: string): Uint8Array {
  const clean = hexString.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Deterministic pseudo-random bytes; a fixed seed keeps failures reproducible. */
function pseudoRandom(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

/**
 * L2 loads and stores the two 32-bit Feistel halves LITTLE-endian (see bytesTo32Bits /
 * bits32ToBytes in blowfish.ts, verbatim from server-protocol.md), while the published
 * Blowfish test vectors are big-endian. Reversing each 4-byte word bridges the two, which
 * lets the known-answer vectors verify the round function itself rather than only that
 * encrypt and decrypt are inverses.
 */
function swapWords32(input: Uint8Array): Uint8Array {
  const out = input.slice();

  for (let i = 0; i < out.length; i += 4) {
    out[i] = input[i + 3];
    out[i + 1] = input[i + 2];
    out[i + 2] = input[i + 1];
    out[i + 3] = input[i];
  }

  return out;
}

describe("Blowfish", () => {
  /* A round-trip alone cannot tell "correct" from "encrypt and decrypt are wrong in the same
     way", which is the failure mode that would burn a day against a live login server. */
  it("matches the Eric Young known-answer vector", () => {
    const key = bytes("0000000000000000");
    const plaintext = swapWords32(bytes("0000000000000000"));
    const expected = swapWords32(bytes("4EF997456198DD78"));

    expect(blowfishEncrypt(plaintext, key)).toEqual(expected);
    expect(blowfishDecrypt(expected, key)).toEqual(plaintext);
  });

  it("matches further known-answer vectors", () => {
    expect(blowfishEncrypt(swapWords32(bytes("FFFFFFFFFFFFFFFF")), bytes("FFFFFFFFFFFFFFFF"))).toEqual(
      swapWords32(bytes("51866FD5B85ECB8A")),
    );
    /* Asymmetric key on purpose: the key schedule consumes key bytes big-endian regardless of
       the block word order, so this case fails if swapWords32 is wrongly applied to the key. */
    expect(blowfishEncrypt(swapWords32(bytes("0123456789ABCDEF")), bytes("FEDCBA9876543210"))).toEqual(
      swapWords32(bytes("0ACEAB0FC6A0A28D")),
    );
  });

  it("round-trips 8/16/64-byte payloads under both the ascii key and the login static key", () => {
    const staticKey = bytes("6b60cb5b82ce90b1cc2b6c556c6c6c6c");
    const asciiKey = new TextEncoder().encode("0123456789abcdef");

    for (const key of [staticKey, asciiKey]) {
      for (const length of [8, 16, 64]) {
        const data = pseudoRandom(length, length * 7 + key[0]);
        expect(equals(blowfishDecrypt(blowfishEncrypt(data, key), key), data)).toBe(true);
      }
    }
  });

  it("rejects a length that is not a multiple of 8", () => {
    expect(() => blowfishEncrypt(new Uint8Array(7), new Uint8Array(16))).toThrow(/multiple of 8/);
  });
});

describe("NewCrypt", () => {
  it("appendChecksum writes the XOR of all preceding LE words into the last 4 bytes", () => {
    const raw = new Uint8Array(16);
    const view = new DataView(raw.buffer);

    view.setUint32(0, 0x11223344, true);
    view.setUint32(4, 0x55667788, true);
    view.setUint32(8, 0x99aabbcc, true);

    NewCrypt.appendChecksum(raw);

    expect(view.getUint32(12, true)).toBe((0x11223344 ^ 0x55667788 ^ 0x99aabbcc) >>> 0);
  });

  it("decXORPass is the exact inverse of the forward pass", () => {
    /* Forward pass, written out here so the spec does not lean on the code under test.
       It walks UPWARD accumulating ecx, and the value it ends on is the XOR key the server
       stores at size-8 - which is what LoginCrypt.decryptInit reads back and feeds to
       decXORPass. Seeding the decrypt with the forward pass's STARTING value instead is the
       classic way to get this backwards. */
    const encXORPass = (raw: Uint8Array, start: number): number => {
      let ecx = start;
      const stop = raw.length - 12;

      for (let pos = 4; pos <= stop; pos += 4) {
        const edx = (raw[pos] | (raw[pos + 1] << 8) | (raw[pos + 2] << 16) | (raw[pos + 3] << 24)) | 0;

        ecx = (ecx + edx) | 0;

        const out = edx ^ ecx;

        raw[pos] = out & 0xff;
        raw[pos + 1] = (out >>> 8) & 0xff;
        raw[pos + 2] = (out >>> 16) & 0xff;
        raw[pos + 3] = (out >>> 24) & 0xff;
      }

      return ecx;
    };

    const original = pseudoRandom(40, 99);

    const scrambled = original.slice();
    const key = encXORPass(scrambled, 0x12345678);

    const restored = scrambled.slice();
    NewCrypt.decXORPass(restored, key);

    expect(equals(restored, original)).toBe(true);
  });
});

describe("unscrambleModulus", () => {
  it("inverts the server-side scramble", () => {
    // Forward scramble = the four passes in reverse order, each one its own inverse.
    const scramble = (input: Uint8Array): Uint8Array => {
      const n = input.slice();

      for (let i = 0; i < 4; i++) {
        const t = n[i];
        n[i] = n[0x4d + i];
        n[0x4d + i] = t;
      }

      for (let i = 0; i < 0x40; i++) n[i] ^= n[0x40 + i];
      for (let i = 0; i < 4; i++) n[0x0d + i] ^= n[0x34 + i];
      for (let i = 0; i < 0x40; i++) n[0x40 + i] ^= n[i];

      return n;
    };

    const modulus = pseudoRandom(128, 4242);
    expect(equals(unscrambleModulus(scramble(modulus)), modulus)).toBe(true);
  });

  it("guards the length", () => {
    expect(() => unscrambleModulus(new Uint8Array(127))).toThrow(/128 bytes/);
  });
});

describe("RSA credentials", () => {
  it("places login at 0x5E and password at 0x6E in a 128-byte block", () => {
    const plaintext = buildCredentialPlaintext("qwerty", "secret");

    expect(plaintext.length).toBe(128);
    expect(new TextDecoder().decode(plaintext.subarray(0x5e, 0x5e + 6))).toBe("qwerty");
    expect(new TextDecoder().decode(plaintext.subarray(0x6e, 0x6e + 6))).toBe("secret");
    // everything before the login offset stays zero - that is what keeps m < n
    expect(plaintext.subarray(0, 0x5e).every((b) => b === 0)).toBe(true);
  });

  it("truncates over-long credentials to 14 / 16 characters", () => {
    const plaintext = buildCredentialPlaintext("a".repeat(30), "b".repeat(30));

    expect(plaintext[0x5e + 13]).toBe(0x61);
    expect(plaintext[0x5e + 14]).toBe(0x00); // the 15th login char must not bleed toward the password
    expect(plaintext[0x6e + 15]).toBe(0x62);
  });

  it("rejects non-ASCII credentials instead of mangling them", () => {
    expect(() => buildCredentialPlaintext("пароль", "x")).toThrow(/ASCII/);
  });

  it("produces 128 bytes that decrypt back with the private exponent", () => {
    /* A structurally real key: two genuine ~300-bit primes found deterministically, so this is
       an actual RSA round-trip rather than a restatement of modPow. 300 bits is plenty - the
       plaintext starts with 0x5E zero bytes, so m < 2^272 and m < n holds. */
    const isProbablePrime = (candidate: bigint): boolean => {
      if (candidate < 2n) return false;

      for (const small of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
        if (candidate === small) return true;
        if (candidate % small === 0n) return false;
      }

      let d = candidate - 1n;
      let r = 0n;
      while (d % 2n === 0n) {
        d /= 2n;
        r += 1n;
      }

      // Miller-Rabin with fixed bases: deterministic for this spec, no randomness to flake on.
      for (const base of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
        let x = modPow(base, d, candidate);
        if (x === 1n || x === candidate - 1n) continue;

        let composite = true;
        for (let i = 1n; i < r; i++) {
          x = (x * x) % candidate;
          if (x === candidate - 1n) {
            composite = false;
            break;
          }
        }

        if (composite) return false;
      }

      return true;
    };

    const nextPrime = (from: bigint): bigint => {
      let candidate = from % 2n === 0n ? from + 1n : from;
      while (!isProbablePrime(candidate)) candidate += 2n;
      return candidate;
    };

    const p = nextPrime(2n ** 300n + 1n);
    const q = nextPrime(2n ** 301n + 1n);
    const n = p * q;
    const phi = (p - 1n) * (q - 1n);

    const inverse = (a: bigint, m: bigint): bigint => {
      let oldR = a % m;
      let r = m;
      let oldS = 1n;
      let s = 0n;

      while (r !== 0n) {
        const quotient = oldR / r;
        [oldR, r] = [r, oldR - quotient * r];
        [oldS, s] = [s, oldS - quotient * s];
      }

      // A gcd other than 1 would mean e is not coprime to phi and the key is unusable.
      expect(oldR).toBe(1n);

      return ((oldS % m) + m) % m;
    };

    const d = inverse(65537n, phi);
    const modulus = bigIntToBytesBE(n, 128);

    const cipher = encryptCredentials("qwerty", "qwerty", modulus);
    expect(cipher.length).toBe(128);

    const recovered = bigIntToBytesBE(modPow(bytesToBigIntBE(cipher), d, n), 128);
    expect(equals(recovered, buildCredentialPlaintext("qwerty", "qwerty"))).toBe(true);
  });

  it("rejects a modulus that is not 128 bytes", () => {
    expect(() => encryptCredentials("a", "b", new Uint8Array(64))).toThrow(/128 bytes/);
  });
});

describe("LoginCrypt", () => {
  it("passes through before the session key is set", () => {
    const lc = new LoginCrypt();
    const body = new Uint8Array([0x07, 1, 2, 3]);

    expect(lc.encrypt(body)).toBe(body);
    expect(lc.decrypt(body)).toBe(body);
  });

  it("round-trips an outgoing packet once the session key is set", () => {
    const lc = new LoginCrypt();
    lc.setSessionKey(new TextEncoder().encode("0123456789abcdef"));

    const body = new Uint8Array([0x07, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const restored = lc.decrypt(lc.encrypt(body));

    expect(equals(restored.subarray(0, body.length), body)).toBe(true);
  });

  it("pads the encrypted body to a multiple of 8 with room for the checksum", () => {
    const lc = new LoginCrypt();
    lc.setSessionKey(new TextEncoder().encode("0123456789abcdef"));

    expect(lc.encrypt(new Uint8Array(6)).length).toBe(16); // pad to 8, then +8 zeros
    expect(lc.encrypt(new Uint8Array(5)).length).toBe(16);
    expect(lc.encrypt(new Uint8Array(8)).length).toBe(16);
  });

  it("does not mutate the body it was handed", () => {
    const lc = new LoginCrypt();
    lc.setSessionKey(new TextEncoder().encode("0123456789abcdef"));

    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    lc.encrypt(body);

    expect([...body]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("GameCrypt", () => {
  it("keeps the key shift in lockstep across a sequence of packets", () => {
    const xorKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const client = new GameCrypt();
    const server = new GameCrypt();

    client.init(xorKey, true);
    server.init(xorKey, true);

    // Odd lengths on purpose: the key shifts by packet size, so a wrong stride desynchronises.
    for (const length of [6, 8, 3, 41, 17]) {
      const message = pseudoRandom(length, length);
      expect(equals(server.decrypt(client.encrypt(message)), message)).toBe(true);
    }
  });

  it("actually changes the bytes when enabled", () => {
    const gc = new GameCrypt();
    gc.init(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), true);

    const message = new Uint8Array([0x2b, 0x10, 0x20]);
    expect(equals(gc.encrypt(message), message)).toBe(false);
  });

  it("is a pure pass-through when the CryptInit flag was zero", () => {
    const gc = new GameCrypt();
    gc.init(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), false);

    const message = new Uint8Array([0xaa, 0xbb, 0xcc]);

    expect(gc.encrypt(message)).toBe(message);
    expect(gc.decrypt(message)).toBe(message);
    expect(gc.isEnabled()).toBe(false);
  });
});
