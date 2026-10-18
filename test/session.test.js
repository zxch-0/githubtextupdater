import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeSession, encodeSession } from '../src/session.js';

test('session round-trips and is authenticated', () => {
  const payload = { token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', user: { login: 'octocat' } };
  const encoded = encodeSession(payload);
  assert.equal(typeof encoded, 'string');
  assert.ok(!encoded.includes('ghp_'));
  assert.deepEqual(decodeSession(encoded), payload);
});

test('tampered or garbage cookies are rejected', () => {
  const encoded = encodeSession({ token: 'ghp_x', user: {} });
  const [iv, tag, data] = encoded.split('.');
  assert.equal(decodeSession(`${iv}.${tag}.${data.slice(0, -4)}AAAA`), null);
  assert.equal(decodeSession('not-a-cookie'), null);
  assert.equal(decodeSession(undefined), null);
  assert.equal(decodeSession(JSON.stringify({ token: 'ghp_x' })), null);
});
