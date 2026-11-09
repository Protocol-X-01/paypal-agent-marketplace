// Render fictional contact rows and the actual button with mocked React Native primitives.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const loadMobileAlias = require('./load-mobile-alias.cjs');

const element = (type, props) => typeof type === 'function' ? type(props) : { type, props: props ?? {} };
const jsxRuntime = { jsx: element, jsxs: element };

function compile(source, dependencies) {
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  const load = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name.startsWith('@/lib/')) return loadMobileAlias(name);
    throw new Error(`Unexpected dependency: ${name}`);
  };
  new Function('exports', 'require', 'module', code)(module.exports, load, module);
  return module.exports;
}

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const { NativeButton } = compile(read('src/components/native-button.tsx'), {
  'react/jsx-runtime': jsxRuntime,
  'react-native': { Pressable: 'Pressable', Text: 'Text', StyleSheet: { create: (styles) => styles } },
});

function contactRows() {
  const source = read('src/app/portfolio.tsx');
  const tree = ts.createSourceFile('portfolio.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'savedContacts.map' &&
        ts.isBinaryExpression(node.parent) && ts.isJsxExpression(node.parent.parent)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(matches.length, 1, 'expected one saved-contact list');
  return compile(`exports.render = (savedContacts, styles, venmoUsernameNeedsReview, NativeButton, selectContactForDraft, startContactEdit, confirmRemoveContact, contactsBusy, editingContact, View, Text) => ${matches[0].getText(tree)};`, {
    'react/jsx-runtime': jsxRuntime,
  }).render;
}

function contactEditor() {
  const source = read('src/app/portfolio.tsx');
  const tree = ts.createSourceFile('portfolio.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches = [];
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'View' &&
        node.openingElement.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) &&
          attribute.name.getText(tree) === 'style' && attribute.initializer?.getText(tree) === '{styles.contactEditCard}')) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(matches.length, 1, 'expected one saved-contact editor');
  return compile(`exports.render = (editingContact, editDisplayName, editHandle, contactsStatus, contactsBusy, updateEditDisplayName, updateEditHandle, saveContactEdit, cancelContactEdit, styles, View, Text, TextInput, NativeButton, venmoUsernameNeedsReview, VENMO_USERNAME_GUIDANCE, MAX_CONTACT_DISPLAY_NAME_LENGTH) => (${matches[0].getText(tree)});`, {
    'react/jsx-runtime': jsxRuntime,
  }).render;
}

function nodes(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}

test('contact actions identify the correct person and handle to a screen reader', () => {
  const contacts = [
    { id: 'fictional-1', displayName: 'Alex', handle: 'alex-one' },
    { id: 'fictional-2', displayName: 'Alex', handle: 'alex-two' },
  ];
  const actions = [];
  const tree = contactRows()(contacts, {}, () => false, NativeButton,
    (contact) => actions.push(['draft', contact.id]),
    (contact) => actions.push(['edit', contact.id]),
    (contact) => actions.push(['remove', contact.id]), false, null, 'View', 'Text');
  const buttons = nodes(tree).filter((node) => node.type === 'Pressable');
  assert.equal(buttons.length, 6);
  assert.deepEqual(buttons.map((button) => button.props.accessibilityLabel), [
    'Use Alex, @alex-one, in draft', 'Edit Alex, @alex-one', 'Remove Alex, @alex-one',
    'Use Alex, @alex-two, in draft', 'Edit Alex, @alex-two', 'Remove Alex, @alex-two',
  ]);
  assert.ok(buttons.every((button) => button.props.accessibilityRole === 'button'));
  assert.deepEqual(buttons.map((button) => button.props.children.props.children), [
    'Use in draft', 'Edit', 'Remove', 'Use in draft', 'Edit', 'Remove',
  ]);
  buttons[3].props.onPress();
  buttons[1].props.onPress();
  buttons[2].props.onPress();
  assert.deepEqual(actions, [['draft', 'fictional-2'], ['edit', 'fictional-1'], ['remove', 'fictional-1']]);
});

test('editing a contact disables other edit and removal actions but keeps draft selection available', () => {
  const contact = { id: 'fictional-1', displayName: 'Alex', handle: 'alex-one' };
  const tree = contactRows()([contact], {}, () => false, NativeButton, () => {}, () => {}, () => {}, false, contact, 'View', 'Text');
  const buttons = nodes(tree).filter((node) => node.type === 'Pressable');
  assert.equal(buttons[0].props.disabled, false);
  assert.equal(buttons[1].props.disabled, true);
  assert.equal(buttons[2].props.disabled, true);
});

test('the contact editor exposes labeled editable fields and disables actions while saving', () => {
  const contact = { id: 'fictional-1', displayName: 'Alex', handle: 'alex-one' };
  const actions = [];
  const render = (busy) => contactEditor()(contact, 'Alex', 'alex-one', 'ready', busy,
    (value) => actions.push(['name', value]), (value) => actions.push(['handle', value]),
    () => actions.push(['save']), () => actions.push(['cancel']), {}, 'View', 'Text', 'TextInput', NativeButton, () => false, '', 36);
  let controls = nodes(render(false));
  const inputs = controls.filter((node) => node.type === 'TextInput');
  assert.deepEqual(inputs.map((input) => input.props.accessibilityLabel), ['Edit contact display name', 'Edit saved Venmo handle']);
  assert.deepEqual(inputs.map((input) => input.props.value), ['Alex', 'alex-one']);
  assert.ok(inputs.every((input) => input.props.editable));
  inputs[0].props.onChangeText('New name');
  inputs[1].props.onChangeText('new-handle');
  const buttons = controls.filter((node) => node.type === 'Pressable');
  assert.deepEqual(buttons.map((button) => button.props.accessibilityLabel), ['Save contact changes', 'Cancel edit']);
  buttons[0].props.onPress();
  buttons[1].props.onPress();
  assert.deepEqual(actions, [['name', 'New name'], ['handle', 'new-handle'], ['save'], ['cancel']]);
  controls = nodes(render(true));
  assert.ok(controls.filter((node) => node.type === 'TextInput').every((input) => input.props.editable === false));
  assert.ok(controls.filter((node) => node.type === 'Pressable').every((button) => button.props.disabled === true));
});

test('other buttons retain their visible label and disabled accessibility state', () => {
  const button = NativeButton({ label: 'Continue', onPress() {}, disabled: true });
  assert.equal(button.props.accessibilityLabel, 'Continue');
  assert.equal(button.props.accessibilityRole, 'button');
  assert.equal(button.props.accessibilityState.disabled, true);
  assert.equal(button.props.disabled, true);
});

test('contact storage guidance distinguishes web from native secure storage', () => {
  const source = read('src/app/portfolio.tsx');
  const tree = ts.createSourceFile('portfolio.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches = [];
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'Text' &&
        node.openingElement.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) &&
          attribute.name.getText(tree) === 'style' && attribute.initializer?.getText(tree) === '{styles.contactsIntro}') &&
        node.getText(tree).includes("Platform.OS === 'web'")) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(matches.length, 1);
  const { render } = compile(`exports.render = (Platform, styles, Text) => (${matches[0].getText(tree)});`, {
    'react/jsx-runtime': jsxRuntime,
  });
  const web = render({ OS: 'web' }, {}, 'Text').props.children;
  const native = render({ OS: 'android' }, {}, 'Text').props.children;
  assert.match(web, /require the mobile app’s secure device storage/i);
  assert.match(web, /type a recipient/i);
  assert.doesNotMatch(web, /they stay in encrypted/i);
  assert.match(native, /stay in encrypted device storage/i);
});

test('the draft notice explains Venmo location requirements alongside its manual-only behavior', () => {
  const source = read('src/app/portfolio.tsx');
  const tree = ts.createSourceFile('portfolio.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const notices = [];
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'View' &&
        node.openingElement.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) &&
          attribute.name.getText(tree) === 'style' && attribute.initializer?.getText(tree) === '{styles.draftOnlyNotice}')) notices.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(notices.length, 1);
  const { render } = compile(`exports.render = (styles, View, Text) => (${notices[0].getText(tree)});`, {
    'react/jsx-runtime': jsxRuntime,
  });
  const notice = render({}, 'View', 'Text');
  const words = nodes(notice).filter((node) => node.type === 'Text').map((node) => node.props.children).join(' ');
  assert.match(words, /will not send, request, or open anything in Venmo/);
  assert.match(words, /physically in the United States/);
  assert.match(words, /other eligibility requirements/);
});
