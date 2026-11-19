import { proto, type BinaryNode } from '@whiskeysockets/baileys';

export interface InteractiveButtonInput {
  id: string;
  text: string;
}

export interface InteractiveListRow {
  id: string;
  title: string;
  description?: string;
}

export interface InteractiveListSection {
  title?: string;
  rows: InteractiveListRow[];
}

export type InteractiveRequest =
  | {
      type: 'buttons';
      text: string;
      header?: string;
      footer?: string;
      buttons: InteractiveButtonInput[];
    }
  | {
      type: 'list';
      text: string;
      header?: string;
      footer?: string;
      buttonText: string;
      sections: InteractiveListSection[];
    };

export const INTERACTIVE_PRIVACY_MODE_TS_OFFSET = 77_980_457;

export function buildNativeFlowButtons(input: InteractiveRequest): Array<{
  name: string;
  buttonParamsJson: string;
}> {
  if (input.type === 'buttons') {
    return input.buttons.map((button) => ({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({
        display_text: button.text,
        id: button.id
      })
    }));
  }

  return [
    {
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: input.buttonText,
        sections: input.sections.map((section) => ({
          title: section.title ?? '',
          rows: section.rows.map((row) => ({
            id: row.id,
            title: row.title,
            description: row.description ?? ''
          }))
        }))
      })
    }
  ];
}

export function buildInteractiveMessage(input: InteractiveRequest): proto.IMessage {
  const nativeFlowMessage =
    proto.Message.InteractiveMessage.NativeFlowMessage.create({
      buttons: buildNativeFlowButtons(input).map((button) =>
        proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create({
          name: button.name,
          buttonParamsJson: button.buttonParamsJson
        })
      ),
      messageParamsJson: '{}',
      messageVersion: 1
    });

  const interactiveMessage = proto.Message.InteractiveMessage.create({
    header: input.header
      ? proto.Message.InteractiveMessage.Header.create({
          title: input.header,
          hasMediaAttachment: false
        })
      : undefined,
    body: proto.Message.InteractiveMessage.Body.create({ text: input.text }),
    footer: input.footer
      ? proto.Message.InteractiveMessage.Footer.create({ text: input.footer })
      : undefined,
    nativeFlowMessage
  });

  return { interactiveMessage };
}

export function buildMixedNativeFlowBizNode(): BinaryNode {
  const privacyModeTs = (
    Math.floor(Date.now() / 1000) - INTERACTIVE_PRIVACY_MODE_TS_OFFSET
  ).toString();

  return {
    tag: 'biz',
    attrs: {
      actual_actors: '2',
      host_storage: '2',
      privacy_mode_ts: privacyModeTs
    },
    content: [
      {
        tag: 'interactive',
        attrs: { type: 'native_flow', v: '1' },
        content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
      },
      {
        tag: 'quality_control',
        attrs: { source_type: 'third_party' }
      }
    ]
  };
}

export function buildFallbackText(input: InteractiveRequest): string {
  const lines: string[] = [];
  if (input.header) lines.push(`*${input.header}*`);
  lines.push(input.text);

  if (input.type === 'buttons') {
    lines.push('');
    input.buttons.forEach((button, index) => {
      lines.push(`${index + 1}. ${button.text}`);
    });
    lines.push('');
    lines.push('Reply with the number of your choice.');
  } else {
    for (const section of input.sections) {
      lines.push('');
      if (section.title) lines.push(`*${section.title}*`);
      section.rows.forEach((row, index) => {
        const description = row.description ? ` - ${row.description}` : '';
        lines.push(`${index + 1}. ${row.title}${description}`);
      });
    }
    lines.push('');
    lines.push(`Reply with the number of your choice (${input.buttonText}).`);
  }

  if (input.footer) {
    lines.push('');
    lines.push(input.footer);
  }

  return lines.join('\n');
}
