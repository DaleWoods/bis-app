import { describe, expect, it } from 'vitest';
import { explain } from './smtp.js';

/** The failure modes a misconfigured SMTP setup actually produces. */
describe('SMTP error messages', () => {
  it('names the host when DNS cannot resolve it', () => {
    const err = Object.assign(new Error('getaddrinfo EAI_AGAIN smtp-gmail.com'), { code: 'EAI_AGAIN' });
    const message = explain(err);
    expect(message).toContain('Cannot find the mail server');
    expect(message).toContain('SMTP_HOST');
    expect(message).toContain('smtp.gmail.com, not smtp-gmail.com');
  });

  it('points at the port when the connection is refused', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(explain(err)).toContain('SMTP_PORT');
  });

  it('points at the credentials on an auth failure, and mentions app passwords', () => {
    const err = Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 });
    const message = explain(err);
    expect(message).toContain('SMTP_PASS');
    expect(message).toContain('app password');
  });

  it('points at sender verification on a 550', () => {
    const err = Object.assign(new Error('Sender not allowed'), { responseCode: 550 });
    expect(explain(err)).toContain('verified with the provider');
  });

  it('passes anything else through unchanged', () => {
    expect(explain(new Error('something else entirely'))).toBe('something else entirely');
  });
});
