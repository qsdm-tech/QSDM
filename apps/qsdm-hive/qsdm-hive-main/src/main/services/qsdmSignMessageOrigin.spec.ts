/**
 * @jest-environment node
 */

import {
  assertSignMessageOrigin,
  getSignMessageKind,
} from './qsdmSignMessageOrigin';

const ADDRESS = 'a'.repeat(64);

// The exact formats the QSDM Account service writes (pkg/account).
const signInMessage = (origin: string) =>
  `QSDM Account wallet sign-in\nVersion: 1\nPurpose: Open or create a QSDM Account profile\nOrigin: ${origin}\nAddress: ${ADDRESS}\nChallenge: abc\nExpires: 2026-11-25T12:00:00Z\nThis signature does not authorize a transfer or restore previous account identities.`;
const linkMessage = (origin: string) =>
  `QSDM Account wallet link\nVersion: 1\nAccount: acct_x\nAddress: ${ADDRESS}\nChallenge: abc\nExpires: 2026-11-25T12:00:00Z\nOrigin: ${origin}`;

describe('assertSignMessageOrigin', () => {
  it('signs a QSDM Account message only for the website it names', () => {
    expect(
      assertSignMessageOrigin(
        signInMessage('https://qsdm.tech'),
        'https://qsdm.tech'
      )
    ).toBe('account-sign-in');
    expect(
      assertSignMessageOrigin(
        linkMessage('https://qsdm.tech'),
        'https://qsdm.tech'
      )
    ).toBe('account-link');
  });

  it('refuses a QSDM Account message asked for by another website', () => {
    expect(() =>
      assertSignMessageOrigin(
        signInMessage('https://qsdm.tech'),
        'https://evil.example'
      )
    ).toThrow(
      'This message is for https://qsdm.tech, but https://evil.example asked to sign it. Hive did not sign it.'
    );
    expect(() =>
      assertSignMessageOrigin(
        linkMessage('https://qsdm.tech'),
        'https://qsdm.tech.evil.example'
      )
    ).toThrow('Hive did not sign it');
    // A look-alike subdomain of the right site is another website too.
    expect(() =>
      assertSignMessageOrigin(
        signInMessage('https://qsdm.tech'),
        'https://www.qsdm.tech'
      )
    ).toThrow('Hive did not sign it');
  });

  it('refuses a QSDM Account message without a website', () => {
    const message = signInMessage('https://qsdm.tech')
      .split('\n')
      .filter((line) => !line.startsWith('Origin:'))
      .join('\n');
    expect(() => assertSignMessageOrigin(message, 'https://qsdm.tech')).toThrow(
      'does not name its website'
    );
    expect(() =>
      assertSignMessageOrigin(
        'QSDM Account something new\nAddress: x',
        'https://qsdm.tech'
      )
    ).toThrow('does not name its website');
  });

  it('refuses two different websites or one that is not an origin', () => {
    expect(() =>
      assertSignMessageOrigin(
        `${signInMessage('https://evil.example')}\nOrigin: https://qsdm.tech`,
        'https://evil.example'
      )
    ).toThrow('unclear website');
    expect(() =>
      assertSignMessageOrigin(
        'Hello\nOrigin: https://qsdm.tech/account/',
        'https://qsdm.tech'
      )
    ).toThrow('unclear website');
    expect(() =>
      assertSignMessageOrigin('Hello\nOrigin: qsdm.tech', 'https://qsdm.tech')
    ).toThrow('unclear website');
  });

  it('reads Origin lines with any line breaks, case and spacing', () => {
    const crlf = signInMessage('https://qsdm.tech').replace(/\n/g, '\r\n');
    expect(() => assertSignMessageOrigin(crlf, 'https://evil.example')).toThrow(
      'Hive did not sign it'
    );
    expect(() =>
      assertSignMessageOrigin(
        'Hello\r  ORIGIN :  https://qsdm.tech  ',
        'https://evil.example'
      )
    ).toThrow('This message is for https://qsdm.tech');
    expect(
      assertSignMessageOrigin(
        'Hello\nOrigin: https://qsdm.tech/',
        'https://qsdm.tech'
      )
    ).toBe('message');
  });

  it('leaves other messages to the normal approval', () => {
    expect(
      assertSignMessageOrigin('ownership challenge', 'https://example.com')
    ).toBe('message');
    // "Origin" inside a line is not an Origin line.
    expect(
      assertSignMessageOrigin(
        'Origin story: https://qsdm.tech is great',
        'https://example.com'
      )
    ).toBe('message');
    expect(
      assertSignMessageOrigin(
        'Proof\nOrigin: http://localhost:3000',
        'http://localhost:3000'
      )
    ).toBe('message');
  });
});

describe('getSignMessageKind', () => {
  it('names the QSDM Account messages by their first line', () => {
    expect(getSignMessageKind(signInMessage('https://qsdm.tech'))).toBe(
      'account-sign-in'
    );
    expect(getSignMessageKind(linkMessage('https://qsdm.tech'))).toBe(
      'account-link'
    );
    expect(getSignMessageKind('qsdm account other')).toBe('account-other');
    expect(getSignMessageKind('Sign this\nQSDM Account wallet sign-in')).toBe(
      'message'
    );
  });
});
