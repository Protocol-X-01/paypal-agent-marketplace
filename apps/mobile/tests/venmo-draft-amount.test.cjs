// Synthetic values only; no clipboard or payment service is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'venmo-draft-amount.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const cjsModule = { exports: {} };
new Function('exports', 'require', 'module', compiled)(cjsModule.exports, require, cjsModule);
const { validateVenmoDraftAmount, validateVenmoDraftRecipient, venmoUsernameNeedsReview, prepareVenmoDraft, VENMO_DRAFT_AMOUNT_MAX_LENGTH, VENMO_DRAFT_HANDLE_MAX_LENGTH, VENMO_DRAFT_NOTE_MAX_LENGTH } = cjsModule.exports;
const clean = (value) => JSON.parse(JSON.stringify(value));

test('accepts empty optional amounts and complete positive dollars and cents exactly', () => {
  assert.deepEqual(clean(validateVenmoDraftAmount('')), { kind: 'empty' });
  for (const [input, formatted] of [['1', '$1.00'], ['0.01', '$0.01'], ['.5', '$0.50'], [',5', '$0.50'], ['00012,3', '$12.30'], ['1234567.89', '$1,234,567.89'], ['9999999999999999.99', '$9,999,999,999,999,999.99']]) {
    assert.deepEqual(clean(validateVenmoDraftAmount(input)), { kind: 'valid', formatted }, input);
  }
});

test('rejects pasted signs, notation, separators, excess precision and oversized input', () => {
  for (const input of ['1e-8', '-1', '+1', '$1', '1 000', '1,234.56', '1.2.3', 'Infinity']) {
    assert.deepEqual(clean(validateVenmoDraftAmount(input)), { kind: 'invalid', reason: 'format' }, input);
  }
  for (const input of ['1.234', '0,001']) assert.deepEqual(clean(validateVenmoDraftAmount(input)), { kind: 'invalid', reason: 'precision' });
  assert.deepEqual(clean(validateVenmoDraftAmount('9'.repeat(VENMO_DRAFT_AMOUNT_MAX_LENGTH + 1))), { kind: 'invalid', reason: 'length' });
  for (const input of ['0', '0.00', '000,0']) assert.deepEqual(clean(validateVenmoDraftAmount(input)), { kind: 'invalid', reason: 'zero' });
});

test('keeps incomplete decimal entries distinct from complete values', () => {
  for (const input of ['.', ',', '0.', '12,']) assert.deepEqual(clean(validateVenmoDraftAmount(input)), { kind: 'incomplete' }, input);
  assert.deepEqual(clean(validateVenmoDraftAmount('0.1')), { kind: 'valid', formatted: '$0.10' });
});

test('cannot prepare copyable text for an invalid amount even with a recipient or note', () => {
  for (const input of ['1e-8', '-1', '1.234', '1.', '9'.repeat(VENMO_DRAFT_AMOUNT_MAX_LENGTH + 1)]) {
    const result = prepareVenmoDraft('@example', 'synthetic note', input);
    assert.equal(result.ok, false, input);
    assert.equal(result.reason, 'amount');
    assert.equal('text' in result, false);
  }
  assert.equal(prepareVenmoDraft('', '', '').ok, false);
  assert.equal(prepareVenmoDraft('@example', '', '').ok, true);
});

test('copyable draft uses exact validated cents and remains an explicitly manual note', () => {
  const result = prepareVenmoDraft('@example', 'synthetic note', '9999999999999999.99');
  assert.equal(result.ok, true);
  assert.match(result.text, /To: @example/);
  assert.match(result.text, /Amount: \$9,999,999,999,999,999\.99/);
  assert.match(result.text, /review and send yourself/);
});

test('accepts only unambiguous local draft handles without rewriting them', () => {
  assert.deepEqual(clean(validateVenmoDraftRecipient('')), { kind: 'empty' });
  assert.deepEqual(clean(validateVenmoDraftRecipient('@example.name_1-2')), { kind: 'valid', handle: 'example.name_1-2' });
  assert.deepEqual(clean(validateVenmoDraftRecipient('a'.repeat(VENMO_DRAFT_HANDLE_MAX_LENGTH))), { kind: 'valid', handle: 'a'.repeat(VENMO_DRAFT_HANDLE_MAX_LENGTH) });
  for (const input of ['@', '@@example', 'example\nother', ' example', 'example ', 'example@email.test', 'example/example']) {
    assert.deepEqual(clean(validateVenmoDraftRecipient(input)), { kind: 'invalid', reason: 'format' }, input);
    const result = prepareVenmoDraft(input, 'synthetic note', '1.00');
    assert.equal(result.ok, false, input);
    assert.equal(result.reason, 'recipient');
    assert.equal('text' in result, false);
  }
  const overlong = '@' + 'a'.repeat(VENMO_DRAFT_HANDLE_MAX_LENGTH + 1);
  assert.deepEqual(clean(validateVenmoDraftRecipient(overlong)), { kind: 'invalid', reason: 'length' });
  assert.equal(prepareVenmoDraft(overlong, 'synthetic note', '1').ok, false);
});

test('Venmo username guidance is advisory and preserves legacy draft handles', () => {
  for (const value of ['abcde', '@abcde', 'a'.repeat(30), 'valid-user_1']) {
    assert.equal(venmoUsernameNeedsReview(value), false, value);
  }
  for (const value of ['abcd', '@abcd', 'a'.repeat(31), 'old.name']) {
    assert.equal(venmoUsernameNeedsReview(value), true, value);
    const draft = prepareVenmoDraft(value, '', '');
    assert.equal(draft.ok, true, value);
    assert.match(draft.text, /To: @/);
  }
  for (const value of ['', '@', '@@name', 'name with space']) {
    assert.equal(venmoUsernameNeedsReview(value), false, value);
  }
});

test('keeps valid note text intact and refuses overlong notes without a copyable draft', () => {
  const note = '  synthetic note  ';
  const valid = prepareVenmoDraft('@fictional', note, '1.00');
  assert.equal(valid.ok, true);
  assert.ok(valid.text.endsWith(`Note: ${note}`));
  assert.equal(prepareVenmoDraft('@fictional', 'x'.repeat(VENMO_DRAFT_NOTE_MAX_LENGTH), '1.00').ok, true);
  for (const input of ['x'.repeat(VENMO_DRAFT_NOTE_MAX_LENGTH + 1), '🦾'.repeat(141)]) {
    const result = prepareVenmoDraft('@fictional', input, '1.00');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'note');
    assert.equal(result.noteTooLong, true);
    assert.equal('text' in result, false);
  }
});
