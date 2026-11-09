// Synthetic callback harness; no device clipboard or personal contacts are accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadHelper() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'venmo-draft-amount.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const cjsModule = { exports: {} };
  new Function('exports', 'require', 'module', code)(cjsModule.exports, require, cjsModule);
  return cjsModule.exports;
}
function loadContacts(secureStore = { isAvailableAsync() { throw new Error('Invalid handles must be rejected before storage is accessed.'); } }, options = {}) {
  let source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'venmo-contacts.ts'), 'utf8');
  if (options.maxStorageBytes !== undefined) {
    const declaration = 'const MAX_STORAGE_BYTES = 1_500;';
    assert.ok(source.includes(declaration));
    source = source.replace(declaration, `const MAX_STORAGE_BYTES = ${options.maxStorageBytes};`);
  }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const cjsModule = { exports: {} };
  const localRequire = (id) => id === 'expo-secure-store' ? secureStore : require(id);
  new Function('exports', 'require', 'module', code)(cjsModule.exports, localRequire, cjsModule);
  return cjsModule.exports;
}
const { prepareVenmoDraft } = loadHelper();
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'portfolio.tsx'), 'utf8');
const tree = ts.createSourceFile('portfolio.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlerNames = ['isDraftCopyPending', 'beginDraftCopy', 'endDraftCopy', 'copyDraft', 'markDraftEdited', 'canonicalDraftHandle', 'draftRecipientNoticeForHandle', 'recordDraftRecipientRisk', 'updateRecipient', 'updateDraftAmount', 'updateDraftNote',
  'updateContactDisplayName', 'updateContactHandle', 'warnIfDraftContactChanged', 'warnIfDraftContactUnverified', 'runContactMutation', 'addContact', 'updateEditDisplayName', 'updateEditHandle',
  'clearContactEdit', 'startContactEdit', 'cancelContactEdit', 'saveContactEdit', 'confirmRemoveContact', 'confirmForgetContacts', 'selectContactForDraft'];
const handlers = {};
const inputs = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && handlerNames.includes(node.name.getText(tree))) handlers[node.name.getText(tree)] = node.initializer.getText(tree);
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === 'TextInput') {
    const label = node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText(tree) === 'accessibilityLabel');
    if (label?.initializer && ts.isStringLiteral(label.initializer)) inputs[label.initializer.text] = node;
  }
  ts.forEachChild(node, visit);
}
visit(tree);
for (const name of handlerNames) assert.ok(handlers[name], `Missing callback ${name}`);
const callbackCode = ts.transpileModule(
  handlerNames.map((name) => `const ${name} = ${handlers[name]};`).join('\n') + `\nexports.handlers = { ${handlerNames.join(', ')} };`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function harness(options = {}) {
  const state = { recipient: '@old', amount: '1.00', note: 'old note', contactName: 'Old Name', contactHandle: 'old', editingContact: null, editName: '', editHandle: '', recipientNotice: null, messages: [], busy: [] };
  const refs = {
    recipientRef: { current: state.recipient },
    draftAmountRef: { current: state.amount },
    draftNoteRef: { current: state.note },
    copyGeneration: { current: 0 },
    copyMounted: { current: true },
    draftRecipientRisksRef: { current: { handles: new Map(), overflow: false, acknowledgedHandle: null } },
    verifiedContactsRef: { current: options.savedContacts || [] },
    contactsBusyRef: { current: false },
    contactDisplayNameRef: { current: state.contactName },
    contactHandleRef: { current: state.contactHandle },
    editingContactRef: { current: null },
    editDisplayNameRef: { current: '' },
    editHandleRef: { current: '' },
    corruptContactsSnapshot: { current: options.corruptSnapshot || null },
  };
  const writes = [];
  const alerts = [];
  const Alert = { alert: (title, message, buttons) => alerts.push({ title, message, buttons }) };
  const draftClipboardGuard = options.guard || { pending: false };
  const Clipboard = options.clipboard || { async setStringAsync(value) { writes.push(value); return true; } };
  const dependencies = {
    ...refs, draftClipboardGuard, Clipboard, Alert, prepareVenmoDraft,
    contactsRepository: { isCurrent: options.isCurrent || (() => true) },
    setRecipient: (value) => { state.recipient = value; },
    setDraftAmount: (value) => { state.amount = value; },
    setDraftNote: (value) => { state.note = value; },
    setCopyMessage: (value) => { state.messages.push(value); },
    setDraftRecipientNotice: (value) => { state.recipientNotice = value; },
    setCopyBusy: (value) => { state.busy.push(value); },
    setContactDisplayName: (value) => { state.contactName = value; },
    setContactHandle: (value) => { state.contactHandle = value; },
    setEditingContact: (value) => { state.editingContact = value; },
    setEditDisplayName: (value) => { state.editName = value; },
    setEditHandle: (value) => { state.editHandle = value; },
    setContactsBusy: (value) => { state.contactBusy = value; },
    setContactsMessage: (value) => { state.contactMessage = value; },
    setContactsStatus: (value) => { state.contactsStatus = value; },
    setSavedContacts: (value) => { state.contacts = value; },
    contactsStatus: options.contactsStatus || 'ready', savedContacts: options.savedContacts || [],
    MAX_CONTACT_DISPLAY_NAME_LENGTH: 36, MAX_CONTACT_HANDLE_LENGTH: 40, MAX_VENMO_CONTACTS: 5,
    MAX_TRACKED_DRAFT_RECIPIENT_RISKS: 64,
    DRAFT_RECIPIENT_OVERFLOW_NOTICE: 'Saved contact history could not be fully verified. Your draft recipient may be outdated; review it before copying.',
    addVenmoContact: options.addContact || (async () => ({ status: 'ready', contacts: [] })),
    updateVenmoContact: options.updateContact || (async () => ({ status: 'ready', contacts: [] })),
    removeVenmoContact: options.removeContact || (async () => ({ status: 'ready', contacts: [] })),
    forgetVenmoContacts: options.forgetContacts || (async () => ({ status: 'ready', contacts: [] })),
  };
  const cjsModule = { exports: {} };
  new Function('exports', 'require', 'module', ...Object.keys(dependencies), callbackCode)(
    cjsModule.exports, require, cjsModule, ...Object.values(dependencies),
  );
  return { ...cjsModule.exports.handlers, state, refs, writes, alerts, guard: draftClipboardGuard };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

function readbackFailureStorage(initial, operation) {
  let value = initial, failReads = false;
  return {
    current: () => value,
    corrupt: (next) => { value = next; },
    api: {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
      async isAvailableAsync() { return true; },
      async getItemAsync() { if (failReads) throw new Error('synthetic read-back failure'); return value; },
      async setItemAsync(_key, next) { value = next; if (operation === 'set') failReads = true; },
      async deleteItemAsync() { value = null; if (operation === 'delete') failReads = true; },
    },
  };
}

test('draft and contact inputs do not truncate pastes before validation', () => {
  for (const label of ['Draft amount in US dollars, optional', 'Venmo recipient handle, optional', 'Saved contact display name', 'Edit contact display name', 'Saved Venmo handle', 'Edit saved Venmo handle', 'Venmo message draft']) {
    assert.ok(inputs[label], label);
    assert.equal(inputs[label].attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText(tree) === 'maxLength'), false, label);
  }
});

test('adding and editing a pasted display name validates and saves the whole normalized input', async () => {
  const original = { id: 'contact-example', displayName: 'Original', handle: 'original' };
  let stored = JSON.stringify({ version: 1, contacts: [original] });
  let writes = 0;
  const contacts = loadContacts({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    async isAvailableAsync() { return true; },
    async getItemAsync() { return stored; },
    async setItemAsync(_key, value) { writes++; stored = value; },
  });
  const screen = harness({ savedContacts: [original], addContact: contacts.addVenmoContact, updateContact: contacts.updateVenmoContact });
  const addName = 'Alex' + ' '.repeat(76) + 'Smith';
  screen.updateContactDisplayName(addName);
  screen.updateContactHandle('alex-example');
  assert.equal(screen.state.contactName, addName);
  screen.addContact();
  await new Promise((resolve) => setImmediate(resolve));
  const added = screen.state.contacts[1];
  assert.equal(added.displayName, 'Alex Smith');
  assert.equal(added.handle, 'alex-example');
  assert.deepEqual(JSON.parse(stored).contacts, [original, added]);

  const editName = 'Bailey' + ' '.repeat(76) + 'Wong';
  screen.startContactEdit(added);
  screen.updateEditDisplayName(editName);
  assert.equal(screen.state.editName, editName);
  screen.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(stored).contacts, [original, { ...added, displayName: 'Bailey Wong' }]);
  assert.equal(screen.state.editingContact, null);
  assert.equal(writes, 2);
});

test('overlength pasted names are retained and rejected without changing contacts on add or edit', async () => {
  const original = { id: 'contact-example', displayName: 'Original', handle: 'original' };
  const before = JSON.stringify({ version: 1, contacts: [original] });
  let stored = before;
  let writes = 0;
  const contacts = loadContacts({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    async isAvailableAsync() { return true; },
    async getItemAsync() { return stored; },
    async setItemAsync(_key, value) { writes++; stored = value; },
  });
  const screen = harness({ savedContacts: [original], addContact: contacts.addVenmoContact, updateContact: contacts.updateVenmoContact });
  const input = 'Alex' + ' '.repeat(76) + 'Q'.repeat(37);
  screen.updateContactDisplayName(input);
  screen.updateContactHandle('new-contact');
  screen.addContact();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.state.contactName, input);
  assert.match(screen.state.contactMessage, /display name up to 36/);
  assert.equal(stored, before);
  assert.equal(writes, 0);

  screen.startContactEdit(original);
  screen.updateEditDisplayName(input);
  screen.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.state.editName, input);
  assert.deepEqual(screen.state.editingContact, original);
  assert.match(screen.state.contactMessage, /display name up to 36/);
  assert.equal(stored, before);
  assert.equal(writes, 0);
});

test('a contact edit can be cancelled without writing or changing the current draft', () => {
  const calls = [];
  const screen = harness({ updateContact: (...args) => { calls.push(args); return Promise.resolve({ status: 'ready', contacts: [] }); } });
  const contact = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  screen.startContactEdit(contact);
  assert.deepEqual(screen.state.editingContact, contact);
  screen.updateEditDisplayName('Alex Changed');
  screen.updateEditHandle('new-handle');
  screen.cancelContactEdit();
  assert.equal(screen.state.editingContact, null);
  assert.equal(screen.state.recipient, '@old');
  assert.deepEqual(calls, []);
});

test('removal confirmation uses the reviewed contact and reports a conflict without edit-only instructions', async () => {
  const calls = [], original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const changed = { ...original, displayName: 'Alex Updated', handle: 'new' };
  const screen = harness({ removeContact: async (contact) => { calls.push(contact); return { status: 'conflict', contacts: [changed] }; } });
  screen.confirmRemoveContact(original);
  assert.match(screen.alerts[0].message, /Alex, @old/);
  original.handle = 'mutated-after-confirmation';
  assert.equal(calls.length, 0, 'opening or cancelling the confirmation does not remove anything');
  screen.alerts[0].buttons.find((button) => button.text === 'Remove').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ id: 'contact-example', displayName: 'Alex', handle: 'old' }]);
  assert.deepEqual(screen.state.contacts, [changed]);
  assert.match(screen.state.contactMessage, /review the updated list before removing/i);
  assert.doesNotMatch(screen.state.contactMessage, /cancel this edit/i);
  assert.match(screen.state.recipientNotice, /previous recipient/i);
});

test('removing a selected contact warns that the draft still uses its recipient', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const screen = harness({ removeContact: async () => ({ status: 'ready', contacts: [] }) });
  screen.confirmRemoveContact(original);
  screen.alerts[0].buttons.find((button) => button.text === 'Remove').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.state.recipient, '@old');
  assert.match(screen.state.recipientNotice, /draft still uses the previous recipient/i);
});

test('forget confirmation snapshots the reviewed list and preserves a changed list on conflict', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const changed = { ...original, handle: 'new' }, added = { id: 'contact-second', displayName: 'Bailey', handle: 'bailey' };
  const savedContacts = [original], calls = [];
  const screen = harness({ savedContacts, forgetContacts: async (baseline) => { calls.push(baseline); return { status: 'conflict', contacts: [changed, added] }; } });
  screen.confirmForgetContacts();
  savedContacts.push(added);original.handle = 'mutated-after-confirmation';
  assert.equal(calls.length, 0, 'the confirmation alone does not delete anything');
  screen.alerts[0].buttons.find((button) => button.text === 'Forget').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ status: 'ready', contacts: [{ id: 'contact-example', displayName: 'Alex', handle: 'old' }] }]);
  assert.deepEqual(screen.state.contacts, [changed, added]);
  assert.match(screen.state.contactMessage, /review the updated list before forgetting/i);
  assert.match(screen.state.recipientNotice, /previous recipient/i);
});

test('forgetting unreadable data passes only its opaque observed snapshot', async () => {
  const snapshot = Object.freeze({}), nextSnapshot = Object.freeze({}), calls = [];
  const screen = harness({ contactsStatus: 'corrupt', corruptSnapshot: snapshot, forgetContacts: async (baseline) => {
    calls.push(baseline);return { status: 'corrupt', snapshot: nextSnapshot, changed: true };
  } });
  screen.confirmForgetContacts();
  screen.alerts[0].buttons.find((button) => button.text === 'Forget').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].snapshot, snapshot);
  assert.equal(screen.refs.corruptContactsSnapshot.current, nextSnapshot);
  assert.match(screen.state.contactMessage, /changed and is still unreadable/i);
});

test('saving a contact edit uses the latest inputs and leaves the draft recipient unchanged', async () => {
  const calls = [];
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const saved = { ...original, displayName: 'Alex Updated', handle: 'new-handle' };
  const screen = harness({ updateContact: async (...args) => { calls.push(args); return { status: 'ready', contacts: [saved] }; } });
  screen.startContactEdit(original);
  screen.updateEditDisplayName('Alex Updated');
  screen.updateEditHandle('@new-handle');
  screen.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [[original, 'Alex Updated', '@new-handle']]);
  assert.deepEqual(screen.state.contacts, [saved]);
  assert.equal(screen.state.editingContact, null);
  assert.equal(screen.state.recipient, '@old');
  assert.match(screen.state.recipientNotice, /draft still uses the previous recipient/i);
  screen.updateDraftAmount('2.00');
  assert.match(screen.state.recipientNotice, /draft still uses the previous recipient/i, 'changing other draft fields keeps the recipient warning visible');
  screen.selectContactForDraft(saved);
  assert.equal(screen.state.recipient, 'new-handle');
  assert.equal(screen.state.recipientNotice, null);
});

test('invalid, duplicate, and conflicting edits keep user-entered text available', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const current = { ...original, displayName: 'Alex Elsewhere', handle: 'elsewhere' };
  let response = { status: 'invalid-handle' };
  const screen = harness({ updateContact: async () => response });
  screen.startContactEdit(original);
  screen.updateEditHandle('bad handle');
  for (const [status, message] of [['invalid-handle', /handle up to 40/], ['duplicate', /already saved/], ['conflict', /changed or was removed elsewhere/]]) {
    response = status === 'conflict' ? { status, contacts: [current] }
      : status === 'duplicate' ? { status, contacts: [original] } : { status };
    screen.saveContactEdit();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(screen.state.contactMessage, message);
    assert.equal(screen.state.editHandle, 'bad handle');
    assert.deepEqual(screen.state.editingContact, original);
  }
  assert.deepEqual(screen.state.contacts, [current]);
  assert.match(screen.state.recipientNotice, /changed or was removed elsewhere/i);
  screen.cancelContactEdit();
  assert.match(screen.state.recipientNotice, /review it before copying/i, 'the draft warning survives cancelling the conflicted edit');
  screen.selectContactForDraft(current);
  assert.equal(screen.state.recipient, 'elsewhere');
  assert.equal(screen.state.recipientNotice, null);
});

test('a removed contact warns about the old draft recipient, but a name-only conflict does not', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const screen = harness({ updateContact: async () => ({ status: 'conflict', contacts: [] }) });
  screen.startContactEdit(original);
  screen.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(screen.state.recipientNotice, /changed or was removed elsewhere/i);
  screen.cancelContactEdit();
  screen.selectContactForDraft(original);
  assert.match(screen.state.recipientNotice, /changed or was removed elsewhere/i, 'a stale row cannot clear the warning');
  const nameOnly = harness({ savedContacts: [original], updateContact: async () => ({ status: 'conflict', contacts: [{ ...original, displayName: 'New name only' }] }) });
  nameOnly.startContactEdit(original);
  nameOnly.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nameOnly.state.recipientNotice, null);
});

test('newer inputs arriving during an edit save are preserved against the verified saved baseline', async () => {
  const operation = deferred(), calls = [];
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const saved = { ...original, displayName: 'Alex One', handle: 'one' };
  const screen = harness({ updateContact: (...args) => { calls.push(args); return calls.length === 1 ? operation.promise : Promise.resolve({ status: 'duplicate', contacts: [saved] }); } });
  screen.startContactEdit(original);
  screen.updateEditDisplayName('Alex One');
  screen.updateEditHandle('one');
  screen.saveContactEdit();
  screen.updateEditHandle('two');
  operation.resolve({ status: 'ready', contacts: [saved] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.state.editHandle, 'two');
  assert.deepEqual(screen.state.editingContact, saved);
  assert.match(screen.state.contactMessage, /newer edits are still unsaved/i);
  screen.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[1], [saved, 'Alex One', 'two']);
});

test('a revoked scope cannot publish the result of a pending edit', async () => {
  const operation = deferred(); let current = true;
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const screen = harness({ isCurrent: () => current, updateContact: () => operation.promise });
  screen.startContactEdit(original);
  screen.updateEditHandle('new');
  screen.saveContactEdit();
  current = false;
  operation.resolve({ status: 'ready', contacts: [{ ...original, handle: 'new' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.state.contacts, undefined);
  assert.deepEqual(screen.state.editingContact, original);
  assert.equal(screen.state.messages.length, 0);
});

test('an unverified storage failure preserves the edit without claiming nothing changed', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const screen = harness({ updateContact: async () => { throw new Error('synthetic storage failure'); } });
  screen.startContactEdit(original);
  screen.updateEditHandle('new');
  screen.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.state.contactsStatus, 'unavailable');
  assert.equal(screen.state.editHandle, 'new');
  assert.match(screen.state.contactMessage, /could not verify/i);
  assert.doesNotMatch(screen.state.contactMessage, /no contact data was changed/i);
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
});

test('an edit written before failed read-back warns until the uncertain recipient is changed or reselected', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const storage = readbackFailureStorage(JSON.stringify({ version: 1, contacts: [original] }), 'set');
  const contacts = loadContacts(storage.api);
  const screen = harness({ updateContact: contacts.updateVenmoContact });
  screen.startContactEdit(original);
  screen.updateEditHandle('new');
  screen.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(storage.current()).contacts[0].handle, 'new', 'the native write happened before verification failed');
  assert.equal(screen.state.contactsStatus, 'unavailable');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  assert.doesNotMatch(screen.state.contactMessage, /updated on this device/i);
  screen.cancelContactEdit();
  screen.updateDraftAmount('2.00');
  screen.updateDraftNote('changed note');
  screen.updateRecipient('@OLD');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i, 'same handle, amount, note and cancel do not clear the warning');
  screen.updateRecipient('@other');
  assert.equal(screen.state.recipientNotice, null);
  screen.updateRecipient('@old');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i, 'returning to the uncertain handle restores the warning');
  screen.selectContactForDraft(original);
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i, 'the previously rendered row cannot clear an unverified warning');
  screen.selectContactForDraft({ ...original, handle: 'new' });
  assert.equal(screen.state.recipient, '@old', 'an unverified contact row cannot replace the recipient');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
});

test('an unverified removal warns when the native write already removed the selected contact', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const storage = readbackFailureStorage(JSON.stringify({ version: 1, contacts: [original] }), 'set');
  const contacts = loadContacts(storage.api);
  const screen = harness({ removeContact: contacts.removeVenmoContact });
  screen.confirmRemoveContact(original);
  screen.alerts[0].buttons.find((button) => button.text === 'Remove').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(storage.current()).contacts, []);
  assert.equal(screen.state.contactsStatus, 'unavailable');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  assert.doesNotMatch(screen.state.contactMessage, /removed from this device/i);
});

test('an unverified forget warns when native deletion happened before read-back failed', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const storage = readbackFailureStorage(JSON.stringify({ version: 1, contacts: [original] }), 'delete');
  const contacts = loadContacts(storage.api);
  const screen = harness({ savedContacts: [original], forgetContacts: contacts.forgetVenmoContacts });
  screen.confirmForgetContacts();
  screen.alerts[0].buttons.find((button) => button.text === 'Forget').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage.current(), null);
  assert.equal(screen.state.contactsStatus, 'unavailable');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  assert.doesNotMatch(screen.state.contactMessage, /data forgotten/i);
});

test('unverified forget of unreadable data warns even when its prior contacts are unknown', async () => {
  const storage = readbackFailureStorage('unreadable-synthetic-data', 'delete');
  const contacts = loadContacts(storage.api);
  const unreadable = await contacts.loadVenmoContacts();
  assert.equal(unreadable.status, 'corrupt');
  const screen = harness({ contactsStatus: 'corrupt', corruptSnapshot: unreadable.snapshot, forgetContacts: contacts.forgetVenmoContacts });
  screen.confirmForgetContacts();
  screen.alerts[0].buttons.find((button) => button.text === 'Forget').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage.current(), null);
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
});

test('newly unreadable storage warns about a previously selected draft recipient', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const storage = readbackFailureStorage(JSON.stringify({ version: 1, contacts: [original] }), 'none');
  const contacts = loadContacts(storage.api);
  const screen = harness({ updateContact: contacts.updateVenmoContact });
  screen.startContactEdit(original);
  screen.updateEditHandle('new');
  storage.corrupt('different-unreadable-synthetic-data');
  screen.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.state.contactsStatus, 'corrupt');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  assert.equal(screen.state.editHandle, 'new');
});

test('an unverified contact change invalidates an in-flight draft copy success', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const pendingCopy = deferred();
  const screen = harness({ clipboard: { setStringAsync: () => pendingCopy.promise }, updateContact: async () => ({ status: 'unavailable' }) });
  const copying = screen.copyDraft();
  screen.startContactEdit(original);
  screen.updateEditHandle('new');
  screen.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  pendingCopy.resolve(true);
  await copying;
  assert.match(screen.state.messages.at(-1), /earlier copy attempt finished/i);
  assert.doesNotMatch(screen.state.messages.at(-1), /draft copied/i);
});

test('an unverified edit does not warn about an unrelated manually entered recipient', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const screen = harness({ updateContact: async () => ({ status: 'unavailable' }) });
  screen.updateRecipient('@different');
  screen.startContactEdit(original);
  screen.updateEditHandle('new');
  screen.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.state.recipientNotice, null);
});

test('an overlong pasted note stays intact and blocks copying before rerender', async () => {
  const screen = harness();
  const input = 'x'.repeat(281);
  screen.updateDraftNote(input);
  assert.equal(screen.state.note, input);
  assert.equal(screen.refs.draftNoteRef.current, input);
  await screen.copyDraft();
  assert.equal(screen.writes.length, 0);
  screen.updateDraftNote('  valid note  ');
  await screen.copyDraft();
  assert.ok(screen.writes[0].endsWith('Note:   valid note  '));
});

test('copy callback uses the latest exact amount and rejects invalid pastes before rerender', async () => {
  const screen = harness();
  for (const input of ['1e-8', '-1', '1.234', '1.', '9'.repeat(33)]) {
    screen.updateDraftAmount(input);
    assert.equal(screen.state.amount, input);
    assert.equal(screen.refs.draftAmountRef.current, input);
    await screen.copyDraft();
    assert.equal(screen.writes.length, 0, input);
  }
  screen.updateDraftAmount('0.01');
  await screen.copyDraft();
  assert.equal(screen.writes.length, 1);
  assert.match(screen.writes[0], /Amount: \$0\.01/);
});

test('copy uses newly typed or selected recipient and note in the same tick', async () => {
  const chosen = { id: 'synthetic', displayName: 'Synthetic', handle: 'chosen' };
  const screen = harness({ savedContacts: [chosen] });
  screen.updateRecipient('@new');
  screen.updateDraftNote('new note');
  await screen.copyDraft();
  assert.match(screen.writes[0], /To: @new\n/);
  assert.match(screen.writes[0], /Note: new note/);
  assert.doesNotMatch(screen.writes[0], /@old|old note/);
  screen.selectContactForDraft(chosen);
  await screen.copyDraft();
  assert.match(screen.writes[1], /To: @chosen\n/);
});

test('invalid draft recipient paste is preserved exactly and blocks a copy before rerender', async () => {
  const screen = harness();
  for (const input of ['example\nother', '@@example', '@' + 'a'.repeat(41)]) {
    screen.updateRecipient(input);
    assert.equal(screen.state.recipient, input);
    assert.equal(screen.refs.recipientRef.current, input);
    await screen.copyDraft();
    assert.equal(screen.writes.length, 0, input);
  }
});

test('a pending copy blocks an overlapping write and stale success cannot claim the edited draft was copied', async () => {
  const first = deferred();
  const second = deferred();
  const writes = [];
  const screen = harness({ clipboard: { setStringAsync(value) { writes.push(value); return writes.length === 1 ? first.promise : second.promise; } } });
  const pending = screen.copyDraft();
  screen.updateDraftAmount('2.00');
  assert.match(screen.state.messages.at(-1), /earlier details/);
  await screen.copyDraft();
  assert.equal(writes.length, 1);
  first.resolve(true);
  await pending;
  assert.match(screen.state.messages.at(-1), /earlier copy attempt finished/i);
  assert.doesNotMatch(screen.state.messages.at(-1), /Draft copied/);
  const current = screen.copyDraft();
  assert.equal(writes.length, 2);
  assert.match(writes[1], /Amount: \$2\.00/);
  second.resolve(true);
  await current;
  assert.match(screen.state.messages.at(-1), /Draft copied/);
  assert.deepEqual(screen.state.busy, [true, false, true, false]);
});

test('a stale failed copy cannot report failure for an updated draft', async () => {
  const first = deferred();
  const screen = harness({ clipboard: { setStringAsync() { return first.promise; } } });
  const pending = screen.copyDraft();
  screen.updateDraftNote('changed note');
  first.reject(new Error('synthetic failure'));
  await pending;
  assert.match(screen.state.messages.at(-1), /earlier copy attempt finished/i);
  assert.doesNotMatch(screen.state.messages.at(-1), /Could not copy/);
});

test('copy guard also blocks an older screen write from racing a reopened screen', async () => {
  const first = deferred();
  const guard = { pending: false };
  const writes = [];
  const clipboard = { setStringAsync(value) { writes.push(value); return writes.length === 1 ? first.promise : Promise.resolve(true); } };
  const oldScreen = harness({ guard, clipboard });
  const pending = oldScreen.copyDraft();
  oldScreen.refs.copyMounted.current = false;
  oldScreen.refs.copyGeneration.current += 1;
  const newScreen = harness({ guard, clipboard });
  newScreen.updateRecipient('@new');
  await newScreen.copyDraft();
  assert.equal(writes.length, 1);
  first.resolve(true);
  await pending;
  assert.equal(oldScreen.state.messages.length, 0);
  await newScreen.copyDraft();
  assert.equal(writes.length, 2);
  assert.match(writes[1], /To: @new\n/);
});

test('contact Add captures latest name and full handle and ignores duplicate presses while busy', async () => {
  const operation = deferred();
  const calls = [];
  const screen = harness({ addContact: (name, handle) => { calls.push([name, handle]); return operation.promise; } });
  const overlong = '@' + 'a'.repeat(45);
  screen.updateContactDisplayName('New Name');
  screen.updateContactHandle(overlong);
  assert.equal(screen.state.contactHandle, overlong);
  screen.addContact();
  screen.addContact();
  assert.deepEqual(calls, [['New Name', overlong]]);
  assert.equal(screen.refs.contactsBusyRef.current, true);
  operation.resolve({ status: 'invalid-handle' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.refs.contactsBusyRef.current, false);
  assert.match(screen.state.contactMessage, /handle up to 40/);
  assert.equal(screen.state.contactHandle, overlong);
});

test('an unverified add warns when another runtime changed the draft recipient between storage reads', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const changed = { ...original, handle: 'new' };
  let saved = JSON.stringify({ version: 1, contacts: [original] }), reads = 0, writes = 0;
  const contacts = loadContacts({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    async isAvailableAsync() { return true; },
    async getItemAsync() {
      if (++reads === 2) saved = JSON.stringify({ version: 1, contacts: [changed] });
      return saved;
    },
    async setItemAsync(_key, value) { writes++; saved = value; },
  });
  const screen = harness({ savedContacts: [original], addContact: contacts.addVenmoContact });
  screen.updateContactDisplayName('Bailey');
  screen.updateContactHandle('bailey');
  screen.addContact();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(writes, 0, 'the concurrent update is not overwritten');
  assert.deepEqual(JSON.parse(saved).contacts, [changed]);
  assert.equal(screen.state.contactsStatus, 'unavailable');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  assert.doesNotMatch(screen.state.contactMessage, /saved encrypted/i);
  assert.equal(screen.state.contactHandle, 'bailey');
  screen.updateRecipient('@OLD');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
});

test('an add encountering newly unreadable contacts warns only about a previously saved draft recipient', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  let writes = 0;
  const contacts = loadContacts({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    async isAvailableAsync() { return true; },
    async getItemAsync() { return 'unreadable-synthetic-data'; },
    async setItemAsync() { writes++; },
  });
  const screen = harness({ savedContacts: [original], addContact: contacts.addVenmoContact });
  screen.updateContactDisplayName('Bailey');screen.updateContactHandle('bailey');screen.addContact();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.state.contactsStatus, 'corrupt');
  assert.equal(writes, 0);
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  const unrelated = harness({ savedContacts: [original], addContact: contacts.addVenmoContact });
  unrelated.updateRecipient('@different');unrelated.updateContactDisplayName('Bailey');unrelated.updateContactHandle('bailey');unrelated.addContact();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unrelated.state.contactsStatus, 'corrupt');
  assert.equal(unrelated.state.recipientNotice, null);
});

test('duplicate Add and edit retain the observed list, form text, and stale-recipient warning', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const changed = { ...original, handle: 'new' };
  const duplicate = { id: 'contact-second', displayName: 'Bailey', handle: 'bailey' };
  const other = { id: 'contact-third', displayName: 'Casey', handle: 'casey' };
  let stored = JSON.stringify({ version: 1, contacts: [changed, duplicate, other] }), writes = 0;
  const contacts = loadContacts({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    async isAvailableAsync() { return true; },
    async getItemAsync() { return stored; },
    async setItemAsync(_key, value) { writes++; stored = value; },
  });
  const add = harness({ savedContacts: [original, duplicate, other], addContact: contacts.addVenmoContact });
  add.updateContactDisplayName('Another Bailey');
  add.updateContactHandle('BAILEY');
  add.addContact();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
  assert.deepEqual(add.state.contacts, [changed, duplicate, other]);
  assert.equal(add.state.contactName, 'Another Bailey');
  assert.equal(add.state.contactHandle, 'BAILEY');
  assert.match(add.state.contactMessage, /already saved/i);
  assert.match(add.state.recipientNotice, /previous recipient/i);

  const edit = harness({ savedContacts: [original, duplicate, other], updateContact: contacts.updateVenmoContact });
  edit.startContactEdit(other);
  edit.updateEditDisplayName('Casey Revised');
  edit.updateEditHandle('BAILEY');
  edit.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
  assert.deepEqual(edit.state.contacts, [changed, duplicate, other]);
  assert.equal(edit.state.editName, 'Casey Revised');
  assert.equal(edit.state.editHandle, 'BAILEY');
  assert.match(edit.state.contactMessage, /already saved/i);
  assert.match(edit.state.recipientNotice, /previous recipient/i);
});

test('a count limit retains the observed list and unsaved form after an external change', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const other = [1, 2, 3].map((n) => ({ id: `contact-${n}`, displayName: `Person ${n}`, handle: `person${n}` }));
  const changed = { ...original, handle: 'new' };
  const fifth = { id: 'contact-fifth', displayName: 'Fifth', handle: 'fifth' };
  const observed = [changed, ...other, fifth];
  let stored = JSON.stringify({ version: 1, contacts: observed }), writes = 0;
  const contacts = loadContacts({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    async isAvailableAsync() { return true; },
    async getItemAsync() { return stored; },
    async setItemAsync(_key, value) { writes++; stored = value; },
  });
  const screen = harness({ savedContacts: [original, ...other], addContact: contacts.addVenmoContact });
  screen.updateContactDisplayName('Sixth');
  screen.updateContactHandle('sixth');
  screen.addContact();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
  assert.deepEqual(screen.state.contacts, observed);
  assert.equal(screen.state.contactName, 'Sixth');
  assert.equal(screen.state.contactHandle, 'sixth');
  assert.match(screen.state.contactMessage, /up to 5 contacts/i);
  assert.match(screen.state.recipientNotice, /previous recipient/i);
});

test('a synthetic encoded-size limit retains the last observed list without writing', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const changed = { ...original, handle: 'new' };
  let stored = JSON.stringify({ version: 1, contacts: [changed] }), reads = 0, writes = 0;
  const contacts = loadContacts({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    async isAvailableAsync() { return true; },
    async getItemAsync() { reads++; return stored; },
    async setItemAsync(_key, value) { writes++; stored = value; },
  }, { maxStorageBytes: 220 }); // Artificially constrain this otherwise unreachable branch.
  const screen = harness({ savedContacts: [original], addContact: contacts.addVenmoContact });
  const name = '😀'.repeat(36), handle = 'b'.repeat(40);
  screen.updateContactDisplayName(name);
  screen.updateContactHandle(handle);
  screen.addContact();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2, 'the size check happens after the second storage read');
  assert.equal(writes, 0);
  assert.deepEqual(screen.state.contacts, [changed]);
  assert.equal(screen.state.contactName, name);
  assert.equal(screen.state.contactHandle, handle);
  assert.match(screen.state.contactMessage, /up to 5 contacts/i);
  assert.match(screen.state.recipientNotice, /previous recipient/i);
});

test('late duplicate and limit results cannot refresh contacts across a revoked scope', async () => {
  for (const status of ['duplicate', 'limit']) {
    const operation = deferred(); let current = true;
    const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
    const screen = harness({ savedContacts: [original], isCurrent: () => current, addContact: () => operation.promise });
    screen.addContact();
    current = false;
    operation.resolve({ status, contacts: [{ ...original, handle: 'other-owner' }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(screen.state.contacts, undefined);
    assert.equal(screen.state.recipientNotice, null);
    assert.equal(screen.refs.verifiedContactsRef.current[0].handle, 'old');
  }
});

test('a successful add checks whether another runtime changed or removed the draft contact before its first read', async () => {
  const original = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const changed = { ...original, handle: 'new' };
  const renamed = { ...original, displayName: 'Alex Updated' };
  for (const [currentContacts, shouldWarn] of [[[changed], true], [[], true], [[renamed], false]]) {
    let stored = JSON.stringify({ version: 1, contacts: currentContacts });
    let writes = 0;
    const contacts = loadContacts({
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
      async isAvailableAsync() { return true; },
      async getItemAsync() { return stored; },
      async setItemAsync(_key, value) { writes++; stored = value; },
    });
    const screen = harness({ savedContacts: [original], addContact: contacts.addVenmoContact });
    screen.updateContactDisplayName('Bailey');
    screen.updateContactHandle('bailey');
    screen.addContact();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(screen.state.contactsStatus, 'ready');
    assert.equal(writes, 1);
    assert.deepEqual(JSON.parse(stored).contacts.slice(0, currentContacts.length), currentContacts);
    assert.equal(JSON.parse(stored).contacts.at(-1).handle, 'bailey');
    assert.equal(screen.state.recipient, '@old');
    if (shouldWarn) {
      assert.match(screen.state.recipientNotice, /previous recipient/i);
      screen.updateRecipient('@OLD');
      assert.match(screen.state.recipientNotice, /previous recipient/i);
    } else {
      assert.equal(screen.state.recipientNotice, null, 'a name-only change leaves the draft recipient valid');
    }
  }
});

test('a verified change to another contact still checks the draft against the whole prior list', async () => {
  const draftContact = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const otherContact = { id: 'contact-second', displayName: 'Bailey', handle: 'bailey' };
  const changedDraftContact = { ...draftContact, handle: 'new' };
  let stored = JSON.stringify({ version: 1, contacts: [changedDraftContact, otherContact] });
  const contacts = loadContacts({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    async isAvailableAsync() { return true; },
    async getItemAsync() { return stored; },
    async setItemAsync(_key, value) { stored = value; },
  });
  const screen = harness({ savedContacts: [draftContact, otherContact], updateContact: contacts.updateVenmoContact });
  screen.startContactEdit(otherContact);
  screen.updateEditDisplayName('Bailey Updated');
  screen.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.state.contactsStatus, 'ready');
  assert.deepEqual(JSON.parse(stored).contacts, [changedDraftContact, { ...otherContact, displayName: 'Bailey Updated' }]);
  assert.match(screen.state.recipientNotice, /previous recipient/i);
});

test('a conflict involving another contact still checks the draft against the whole prior list', async () => {
  const draftContact = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const otherContact = { id: 'contact-second', displayName: 'Bailey', handle: 'bailey' };
  const changedOther = { ...otherContact, displayName: 'Bailey Updated' };
  const screen = harness({ savedContacts: [draftContact, otherContact], removeContact: async () => ({ status: 'conflict', contacts: [changedOther] }) });
  screen.confirmRemoveContact(otherContact);
  screen.alerts[0].buttons.find((button) => button.text === 'Remove').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(screen.state.contactMessage, /review the updated list before removing/i);
  assert.match(screen.state.recipientNotice, /previous recipient/i);
});

test('an unverified change to another contact also warns about an uncertain previously saved draft recipient', async () => {
  const draftContact = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const otherContact = { id: 'contact-second', displayName: 'Bailey', handle: 'bailey' };
  const screen = harness({ savedContacts: [draftContact, otherContact], updateContact: async () => ({ status: 'unavailable' }) });
  screen.startContactEdit(otherContact);
  screen.updateEditDisplayName('Bailey Updated');
  screen.saveContactEdit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.state.contactsStatus, 'unavailable');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
});

test('changed contacts retain independent canonical warnings until their own verified selection', async () => {
  const first = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const second = { id: 'contact-second', displayName: 'Bailey', handle: 'before' };
  const changedFirst = { ...first, handle: 'new' }, changedSecond = { ...second, handle: 'after' };
  const screen = harness({ savedContacts: [first, second] });
  await screen.runContactMutation(async () => ({ status: 'ready', contacts: [changedFirst, changedSecond] }), 'Updated');
  assert.match(screen.state.recipientNotice, /previous recipient/i);
  screen.updateRecipient('@BEFORE');
  assert.match(screen.state.recipientNotice, /previous recipient/i, 'a change to a non-current contact is retained');
  screen.selectContactForDraft(changedSecond);
  assert.equal(screen.state.recipientNotice, null);
  screen.updateRecipient('@OLD');
  assert.match(screen.state.recipientNotice, /previous recipient/i, 'selecting the other row did not erase the first risk');
  await screen.runContactMutation(async () => ({ status: 'ready', contacts: [first, changedSecond] }), 'Updated');
  screen.selectContactForDraft(first);
  assert.equal(screen.state.recipientNotice, null);
  screen.updateRecipient('@before');
  assert.match(screen.state.recipientNotice, /previous recipient/i, 'reselecting the first handle did not erase the second risk');
  screen.updateRecipient('@old');
  assert.match(screen.state.recipientNotice, /previous recipient/i, 'manual re-entry restores the retained history');
});

test('selecting a different person who now uses an old handle does not erase its earlier risk', async () => {
  const first = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const changed = { ...first, handle: 'new' };
  const other = { id: 'contact-other', displayName: 'Casey', handle: 'old' };
  const screen = harness({ savedContacts: [first] });
  await screen.runContactMutation(async () => ({ status: 'ready', contacts: [changed, other] }), 'Updated');
  assert.match(screen.state.recipientNotice, /previous recipient/i);
  screen.selectContactForDraft(other);
  assert.equal(screen.state.recipientNotice, null, 'selecting the verified row acknowledges this draft');
  screen.updateRecipient('@OLD');
  assert.match(screen.state.recipientNotice, /previous recipient/i, 'a manual re-entry can still be ambiguous');
});

test('unverified storage retains risks for non-current contacts', async () => {
  const first = { id: 'contact-example', displayName: 'Alex', handle: 'old' };
  const second = { id: 'contact-second', displayName: 'Bailey', handle: 'before' };
  const screen = harness({ savedContacts: [first, second] });
  await screen.runContactMutation(async () => ({ status: 'unavailable' }), 'Updated');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  screen.updateRecipient('@BEFORE');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  screen.updateRecipient('@old');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
});

test('recipient-risk history stays bounded and overflow warns conservatively', async () => {
  let contact = { id: 'contact-example', displayName: 'Alex', handle: 'handle0' };
  const screen = harness({ savedContacts: [contact] });
  for (let i = 1; i <= 65; i++) {
    contact = { ...contact, handle: `handle${i}` };
    await screen.runContactMutation(async () => ({ status: 'ready', contacts: [contact] }), 'Updated');
  }
  const risks = screen.refs.draftRecipientRisksRef.current;
  assert.equal(risks.handles.size, 64);
  assert.equal(risks.overflow, true);
  screen.updateRecipient('@never-observed');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  screen.selectContactForDraft(contact);
  assert.equal(screen.state.recipientNotice, null, 'explicit verified selection acknowledges the current handle');
  screen.updateRecipient('@another');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  screen.updateRecipient(contact.handle);
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i, 'manual re-entry after leaving needs review again');
  screen.updateRecipient('@HANDLE0');
  assert.match(screen.state.recipientNotice, /previous recipient/i, 'recorded risks survive overflow');
  assert.equal(risks.handles.size, 64);
  assert.equal(risks.overflow, true);
});

test('forgetting unreadable contacts conservatively warns later manually entered recipients', async () => {
  const snapshot = Object.freeze({});
  const screen = harness({ contactsStatus: 'corrupt', corruptSnapshot: snapshot, forgetContacts: async () => ({ status: 'unavailable' }) });
  screen.confirmForgetContacts();
  screen.alerts[0].buttons.find((button) => button.text === 'Forget').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  screen.updateRecipient('@another');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
});

test('a verified forget of unreadable contacts warns for current and later recipients without doubting deletion', async () => {
  const snapshot = Object.freeze({});
  const screen = harness({ contactsStatus: 'corrupt', corruptSnapshot: snapshot, forgetContacts: async () => ({ status: 'ready', contacts: [] }) });
  screen.confirmForgetContacts();
  screen.alerts[0].buttons.find((button) => button.text === 'Forget').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(screen.state.contactMessage, /forgotten/i);
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  assert.doesNotMatch(screen.state.recipientNotice, /deletion.*not.*verified/i);
  screen.updateRecipient('@another');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
});

test('a changed unreadable baseline that becomes readable keeps the conflict and conservatively warns', async () => {
  const snapshot = Object.freeze({});
  const contact = { id: 'contact-example', displayName: 'Alex', handle: 'current' };
  const screen = harness({ contactsStatus: 'corrupt', corruptSnapshot: snapshot, forgetContacts: async () => ({ status: 'conflict', contacts: [contact] }) });
  screen.confirmForgetContacts();
  screen.alerts[0].buttons.find((button) => button.text === 'Forget').onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(screen.state.contacts, [contact]);
  assert.match(screen.state.contactMessage, /review the updated list before forgetting/i);
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
  screen.selectContactForDraft(contact);
  assert.equal(screen.state.recipientNotice, null);
  screen.updateRecipient('@another');
  assert.match(screen.state.recipientNotice, /recipient may be outdated/i);
});

test('successful Add does not clear different text entered while the save was pending', async () => {
  const operation = deferred();
  const screen = harness({ addContact: () => operation.promise });
  screen.updateContactDisplayName('New Name');
  screen.updateContactHandle('new');
  screen.addContact();
  screen.updateContactHandle('newer');
  operation.resolve({ status: 'ready', contacts: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.state.contactName, 'New Name');
  assert.equal(screen.state.contactHandle, 'newer');
  assert.equal(screen.refs.contactHandleRef.current, 'newer');
});

test('the real saved-contact validator rejects the full overlong paste before storage', async () => {
  const contacts = loadContacts();
  const screen = harness({ addContact: contacts.addVenmoContact });
  const input = '@' + 'a'.repeat(45);
  screen.updateContactDisplayName('Synthetic Name');
  screen.updateContactHandle(input);
  screen.addContact();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(screen.state.contactMessage, /handle up to 40/);
  assert.equal(screen.state.contactHandle, input);
});

test('saved contact input rejects ambiguous whitespace and repeated @ without rewriting the paste', async () => {
  const contacts = loadContacts();
  const screen = harness({ addContact: contacts.addVenmoContact });
  screen.updateContactDisplayName('Synthetic Name');
  for (const input of ['@@fictional', 'fictional\n', ' fictional', 'fictional ', 'fictional\nother']) {
    screen.updateContactHandle(input);
    screen.addContact();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(screen.state.contactMessage, /handle up to 40/, input);
    assert.equal(screen.state.contactHandle, input);
  }
});

test('existing canonical contacts remain readable and a single leading @ may be saved', async () => {
  let saved = JSON.stringify({ version: 1, contacts: [{ id: 'contact-old-123', displayName: 'Synthetic', handle: 'fictional' }] });
  const contacts = loadContacts({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'synthetic',
    async isAvailableAsync() { return true; },
    async getItemAsync() { return saved; },
    async setItemAsync(_key, value) { saved = value; },
  });
  const before = await contacts.loadVenmoContacts();
  assert.equal(before.status, 'ready');
  assert.equal(before.contacts[0].handle, 'fictional');
  const after = await contacts.addVenmoContact('Another Synthetic', '@next-handle');
  assert.equal(after.status, 'ready');
  assert.deepEqual(after.contacts.map((contact) => contact.handle), ['fictional', 'next-handle']);
  assert.deepEqual(JSON.parse(saved).contacts.map((contact) => contact.handle), ['fictional', 'next-handle']);
});

test('legacy contacts remain readable and writable when current Venmo guidance differs', async () => {
  const legacy = [
    { id: 'contact-short', displayName: 'Short', handle: 'abc' },
    { id: 'contact-dot', displayName: 'Dot', handle: 'old.name' },
    { id: 'contact-long', displayName: 'Long', handle: 'a'.repeat(31) },
  ];
  let saved = JSON.stringify({ version: 1, contacts: legacy });
  const contacts = loadContacts({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    async isAvailableAsync() { return true; },
    async getItemAsync() { return saved; },
    async setItemAsync(_key, value) { saved = value; },
  });
  const before = await contacts.loadVenmoContacts();
  assert.equal(before.status, 'ready');
  assert.deepEqual(before.contacts, legacy);
  const after = await contacts.addVenmoContact('Another Synthetic', '@valid-user');
  assert.equal(after.status, 'ready');
  assert.deepEqual(after.contacts.slice(0, 3), legacy);
  assert.deepEqual(JSON.parse(saved).contacts.slice(0, 3), legacy);
  for (const contact of legacy) assert.equal(prepareVenmoDraft(contact.handle, '', '').ok, true);
});


test('revoked private scope blocks clipboard and stale contact publication', async () => {
  let current = true; const wait = deferred();
  const screen = harness({ isCurrent: () => current, addContact: () => wait.promise });
  screen.addContact(); current = false;
  wait.resolve({ status: 'ready', contacts: [{ id: 'old', displayName: 'Old', handle: 'old' }] });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(screen.state.contacts, undefined);
  await screen.copyDraft(); assert.equal(screen.writes.length, 0);
});
