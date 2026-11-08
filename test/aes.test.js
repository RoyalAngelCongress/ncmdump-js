import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptAes128Ecb } from '../src/aes.js';
import { encryptAes } from './fixture.js';

const hex = (value) => Buffer.from(value, 'hex');
const text = (value) => Buffer.from(value).toString('hex');

test('FIPS 197 AES-128 known-answer inverse cipher', () => {
  assert.equal(text(decryptAes128Ecb(
    hex('69c4e0d86a7b0430d8cdb78070b4c55a'),
    hex('000102030405060708090a0b0c0d0e0f'), { padding: false },
  )), '00112233445566778899aabbccddeeff');
});

test('NIST SP 800-38A four-block ECB decryption', () => {
  const ciphertext = '3ad77bb40d7a3660a89ecaf32466ef97'
    + 'f5d3d58503b9699de785895a96fdbaaf'
    + '43b1cd7f598ece23881b00e3ed030688'
    + '7b0c785e27e8ad3f8223207104725dd4';
  const plaintext = '6bc1bee22e409f96e93d7e117393172a'
    + 'ae2d8a571e03ac9c9eb76fac45af8e51'
    + '30c81c46a35ce411e5fbc1191a0a52ef'
    + 'f69f2445df4f9b17ad2b417be66c3710';
  assert.equal(text(decryptAes128Ecb(hex(ciphertext), hex('2b7e151628aed2a6abf7158809cf4f3c'), { padding: false })), plaintext);
});

for (const length of [0, 1, 15, 16, 17, 31, 32, 144, 1024, 4097]) {
  test(`AES agrees with Node/OpenSSL, ${length} plaintext bytes`, () => {
    const key = randomBytes(16);
    const plaintext = randomBytes(length);
    const encrypted = encryptAes(plaintext, key);
    const original = Buffer.from(encrypted);
    assert.deepEqual(Buffer.from(decryptAes128Ecb(encrypted, key)), plaintext);
    assert.deepEqual(encrypted, original);
  });
}

test('AES rejects invalid key sizes, ciphertext lengths and PKCS#7 padding', () => {
  const key = Buffer.alloc(16);
  assert.throws(() => decryptAes128Ecb(Buffer.alloc(16), Buffer.alloc(15)), /16-byte key/);
  assert.throws(() => decryptAes128Ecb(Buffer.alloc(0), key), /multiple of 16/);
  assert.throws(() => decryptAes128Ecb(Buffer.alloc(17), key), /multiple of 16/);
  for (const ending of [0, 17, 255]) {
    const plain = Buffer.alloc(16);
    plain[15] = ending;
    assert.throws(() => decryptAes128Ecb(encryptAes(plain, key, false), key), /padding/);
  }
  const plain = Buffer.alloc(16);
  plain[15] = 2; // Previous byte is 0, not 2.
  assert.throws(() => decryptAes128Ecb(encryptAes(plain, key, false), key), /padding/);
});
