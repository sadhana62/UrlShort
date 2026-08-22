const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE = BigInt(ALPHABET.length);

function encode(value) {
  let num = typeof value === 'bigint' ? value : BigInt(value);

  if (num < 0n) {
    throw new Error('Base62 encoding only supports positive integers');
  }

  if (num === 0n) {
    return ALPHABET[0];
  }

  let result = '';
  while (num > 0n) {
    const remainder = Number(num % BASE);
    result = ALPHABET[remainder] + result;
    num /= BASE;
  }

  return result;
}

function decode(str) {
  if (!str || typeof str !== 'string') {
    throw new Error('Invalid short code');
  }

  let result = 0n;
  for (const char of str) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid short code');
    }
    result = result * BASE + BigInt(index);
  }

  return result;
}

module.exports = { encode, decode };
