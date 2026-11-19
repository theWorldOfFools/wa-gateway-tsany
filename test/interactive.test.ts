import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFallbackText,
  buildInteractiveMessage,
  buildMixedNativeFlowBizNode,
  buildNativeFlowButtons,
  type InteractiveRequest
} from '../src/wa/interactive.js';

const buttonsRequest: InteractiveRequest = {
  type: 'buttons',
  text: 'Choose an option',
  header: 'Welcome',
  footer: 'Thank you',
  buttons: [
    { id: 'yes', text: 'Yes' },
    { id: 'no', text: 'No' }
  ]
};

const listRequest: InteractiveRequest = {
  type: 'list',
  text: 'Choose a product',
  buttonText: 'View products',
  sections: [
    {
      title: 'Category A',
      rows: [
        { id: 'a1', title: 'Product A1', description: 'First product' },
        { id: 'a2', title: 'Product A2' }
      ]
    }
  ]
};

describe('buildNativeFlowButtons', () => {
  it('builds quick reply buttons', () => {
    const buttons = buildNativeFlowButtons(buttonsRequest);
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0]?.name, 'quick_reply');
    assert.deepEqual(JSON.parse(buttons[0]!.buttonParamsJson), {
      display_text: 'Yes',
      id: 'yes'
    });
  });

  it('builds a single select list', () => {
    const buttons = buildNativeFlowButtons(listRequest);
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]?.name, 'single_select');

    const params = JSON.parse(buttons[0]!.buttonParamsJson) as {
      title: string;
      sections: Array<{ title: string; rows: Array<{ id: string }> }>;
    };
    assert.equal(params.title, 'View products');
    assert.equal(params.sections[0]?.title, 'Category A');
    assert.equal(params.sections[0]?.rows.length, 2);
    assert.equal(params.sections[0]?.rows[1]?.id, 'a2');
  });
});

describe('buildInteractiveMessage', () => {
  it('creates an interactive message with body, header and footer', () => {
    const message = buildInteractiveMessage(buttonsRequest);
    assert.equal(
      message.interactiveMessage?.body?.text,
      'Choose an option'
    );
    assert.equal(message.interactiveMessage?.header?.title, 'Welcome');
    assert.equal(message.interactiveMessage?.footer?.text, 'Thank you');
    assert.equal(
      message.interactiveMessage?.nativeFlowMessage?.buttons?.length,
      2
    );
  });

  it('omits the header and footer when they are not provided', () => {
    const message = buildInteractiveMessage({
      type: 'buttons',
      text: 'Only body',
      buttons: [{ id: 'ok', text: 'OK' }]
    });
    assert.equal(message.interactiveMessage?.header ?? null, null);
    assert.equal(message.interactiveMessage?.footer ?? null, null);
  });
});

describe('buildFallbackText', () => {
  it('renders numbered buttons', () => {
    const text = buildFallbackText(buttonsRequest);
    assert.match(text, /\*Welcome\*/);
    assert.match(text, /1\. Yes/);
    assert.match(text, /2\. No/);
    assert.match(text, /Reply with the number of your choice/);
  });

  it('renders grouped list rows', () => {
    const text = buildFallbackText(listRequest);
    assert.match(text, /\*Category A\*/);
    assert.match(text, /1\. Product A1 - First product/);
    assert.match(text, /2\. Product A2/);
    assert.match(text, /View products/);
  });
});

describe('buildMixedNativeFlowBizNode', () => {
  it('builds the binary node required by native flow messages', () => {
    const node = buildMixedNativeFlowBizNode();
    assert.equal(node.tag, 'biz');
    assert.equal(node.attrs.actual_actors, '2');
    assert.equal(node.attrs.host_storage, '2');
    assert.match(node.attrs.privacy_mode_ts ?? '', /^\d+$/);

    const content = node.content;
    assert.ok(Array.isArray(content));
    const interactive = content.find((child) => child.tag === 'interactive');
    assert.equal(interactive?.attrs.type, 'native_flow');
    const nativeFlow = interactive?.content?.[0];
    assert.equal(nativeFlow?.tag, 'native_flow');
    assert.equal(nativeFlow?.attrs.name, 'mixed');
    assert.ok(content.some((child) => child.tag === 'quality_control'));
  });
});
