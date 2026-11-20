import type { MessageRecord } from "../../types";

export interface InboxMessage extends MessageRecord {
  inbox_seq: number;
  chars: number;
  message_id?: string;
}

export function codePointLength(text: string): number {
  let chars = 0;
  for (const _point of text) chars += 1;
  return chars;
}

export function pickWindow<T extends { chars: number }>(
  rows: T[],
  limits: { messages: number; chars: number },
): T[] {
  if (
    rows.length < limits.messages &&
    rows.reduce((total, row) => total + row.chars, 0) < limits.chars
  ) {
    return [];
  }
  const selected: T[] = [];
  let chars = 0;
  for (const row of rows) {
    if (selected.length >= limits.messages || (selected.length && chars + row.chars > limits.chars)) break;
    selected.push(row);
    chars += row.chars;
  }
  return selected;
}

export function splitMessage(
  message: InboxMessage,
  maximumChars: number,
): InboxMessage[] {
  if (message.chars <= maximumChars) return [message];
  const text = Array.from(message.content);
  const parts: InboxMessage[] = [];
  for (let start = 0; start < text.length; start += maximumChars) {
    const end = Math.min(start + maximumChars, text.length);
    parts.push({
      ...message,
      id: `${message.id}#${start}-${end}`,
      message_id: message.id,
      content: text.slice(start, end).join(""),
      chars: end - start,
    });
  }
  return parts;
}
