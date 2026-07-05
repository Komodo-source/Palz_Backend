'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { checkTextContent, moderateTextFields, validateMagicBytes } = require('../src/content_filtering');

test('checkTextContent — clean text passes', () => {
  assert.strictEqual(checkTextContent('Salut, on va boire un café ?'), null);
  assert.strictEqual(checkTextContent('I love coffee'), null); // 'of' must not match inside words
  assert.strictEqual(checkTextContent('mon profil est cool'), null);
  assert.strictEqual(checkTextContent('nofilter vibes'), null);
  assert.strictEqual(checkTextContent(''), null);
  assert.strictEqual(checkTextContent(null), null);
  assert.strictEqual(checkTextContent(undefined), null);
});

test('checkTextContent — banned words match as whole words', () => {
  assert.strictEqual(checkTextContent('retrouve moi sur OF'), 'of');
  assert.strictEqual(checkTextContent('0f dans ma bio'), '0f');
  assert.strictEqual(checkTextContent('viens sur onlyfans'), 'onlyfans');
});

test('checkTextContent — accent folding', () => {
  assert.strictEqual(checkTextContent('creve'), 'crève');
  assert.strictEqual(checkTextContent('CRÈVE !!!'), 'crève');
});

test('checkTextContent — multi-word phrases', () => {
  assert.strictEqual(checkTextContent('je vais te tuer demain'), 'je vais te tuer');
  assert.strictEqual(checkTextContent('je  vais   te tuer'), 'je vais te tuer'); // whitespace normalized
});

test('moderateTextFields — reports the offending field', () => {
  assert.strictEqual(moderateTextFields({ bio: 'hello', work: 'dev' }), null);
  const hit = moderateTextFields({ bio: 'hello', prompt_answer: 'viens sur onlyfans' });
  assert.deepStrictEqual(hit, { field: 'prompt_answer', match: 'onlyfans' });
});

test('validateMagicBytes — rejects spoofed MIME', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  assert.strictEqual(validateMagicBytes(png, 'image/png'), true);
  assert.strictEqual(validateMagicBytes(png, 'image/jpeg'), false);
});
