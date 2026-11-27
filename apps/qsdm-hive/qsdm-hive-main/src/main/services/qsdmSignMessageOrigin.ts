/**
 * A website can ask Hive to sign a message. Some messages name the website
 * they are for, such as the QSDM Account sign-in message:
 *
 *   QSDM Account wallet sign-in
 *   ...
 *   Origin: https://qsdm.tech
 *
 * Any site can fetch such a message from qsdm.tech's server and ask Hive to
 * sign it. The signature would sign that site in to the user's QSDM Account.
 * So Hive signs a message that names a website only when that website is the
 * one asking. A QSDM Account message must name its website.
 */

export type SignMessageKind =
  | 'message'
  | 'account-sign-in'
  | 'account-link'
  | 'account-other';

const ORIGIN_LINE = /^[ \t]*origin[ \t]*:[ \t]*(.*?)[ \t]*$/i;

const firstLine = (message: string) =>
  (message.split(/\r\n|\n|\r/, 1)[0] || '').trim();

export const getSignMessageKind = (message: string): SignMessageKind => {
  const head = firstLine(message);
  if (head === 'QSDM Account wallet sign-in') return 'account-sign-in';
  if (head === 'QSDM Account wallet link') return 'account-link';
  if (/^qsdm account\b/i.test(head)) return 'account-other';
  return 'message';
};

const toOrigin = (value: string) => {
  try {
    const parsed = new URL(value);
    if (parsed.origin === 'null') return '';
    // Only a bare origin counts: "https://qsdm.tech", not a page on it.
    return parsed.origin === value.replace(/\/$/, '') ? parsed.origin : '';
  } catch {
    return '';
  }
};

/**
 * Throws when the message names a website other than the one asking, names
 * more than one, or is a QSDM Account message without a website. Returns the
 * kind of message for the approval window.
 */
export const assertSignMessageOrigin = (
  message: string,
  requestingOrigin: string
): SignMessageKind => {
  const kind = getSignMessageKind(message);
  const stated = message
    .split(/\r\n|\n|\r/)
    .map((line) => ORIGIN_LINE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);

  if (stated.length === 0) {
    if (kind !== 'message') {
      throw new Error(
        'This QSDM Account message does not name its website. Hive did not sign it.'
      );
    }
    return kind;
  }

  const origins = new Set(stated.map(toOrigin));
  if (origins.size !== 1 || origins.has('')) {
    throw new Error(
      'This message names an unclear website. Hive did not sign it.'
    );
  }
  const [origin] = [...origins];
  if (origin !== requestingOrigin) {
    throw new Error(
      `This message is for ${origin}, but ${requestingOrigin} asked to sign it. Hive did not sign it.`
    );
  }
  return kind;
};
