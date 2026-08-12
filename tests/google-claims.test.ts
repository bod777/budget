import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdTokenClaims } from '../src/lib/google-claims.ts';

const CLIENT = 'my-client.apps.googleusercontent.com';
const ALLOWED = ['you@example.com'];
const NOW = Date.UTC(2026, 7, 12);

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT,
    exp: Math.floor(NOW / 1000) + 3600,
    email: 'you@example.com',
    email_verified: true,
    ...overrides,
  };
}

const options = { clientId: CLIENT, allowedEmails: ALLOWED, now: NOW };

test('a well-formed token for the allowed account is accepted', () => {
  const result = verifyIdTokenClaims(claims(), options);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.email, 'you@example.com');
});

test('email comparison ignores case and surrounding space', () => {
  const result = verifyIdTokenClaims(claims({ email: '  YOU@Example.com ' }), options);
  assert.equal(result.ok, true);
});

test('someone else with a Google account is refused', () => {
  const result = verifyIdTokenClaims(claims({ email: 'stranger@gmail.com' }), options);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /not allowed/);
});

test('an empty allow-list refuses everyone rather than admitting everyone', () => {
  const result = verifyIdTokenClaims(claims(), { ...options, allowedEmails: [] });
  assert.equal(result.ok, false);
});

test('a token minted for a different OAuth client is refused', () => {
  const result = verifyIdTokenClaims(claims({ aud: 'someone-elses-client' }), options);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /not issued for this app/);
});

test('an unverified email is refused even when it matches the allow-list', () => {
  const result = verifyIdTokenClaims(claims({ email_verified: false }), options);
  assert.equal(result.ok, false);
});

test('an expired token is refused', () => {
  const result = verifyIdTokenClaims(claims({ exp: Math.floor(NOW / 1000) - 1 }), options);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /expired/);
});

test('an unexpected issuer is refused', () => {
  const result = verifyIdTokenClaims(claims({ iss: 'https://evil.example' }), options);
  assert.equal(result.ok, false);
});

test('both issuer spellings Google uses are accepted', () => {
  for (const iss of ['https://accounts.google.com', 'accounts.google.com']) {
    assert.equal(verifyIdTokenClaims(claims({ iss }), options).ok, true);
  }
});

test('missing or malformed claims are refused, not treated as absent checks', () => {
  assert.equal(verifyIdTokenClaims(null, options).ok, false);
  assert.equal(verifyIdTokenClaims({}, options).ok, false);
  assert.equal(verifyIdTokenClaims(claims({ email: undefined }), options).ok, false);
  assert.equal(verifyIdTokenClaims(claims({ exp: 'soon' }), options).ok, false);
  assert.equal(verifyIdTokenClaims(claims({ iss: 42 }), options).ok, false);
});
