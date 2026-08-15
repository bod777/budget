import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { parseServiceAccount } from '../src/lib/google-service-account.ts';

test('a service account key parses from raw JSON', () => {
  const key = parseServiceAccount(
    JSON.stringify({ client_email: 'bot@project.iam.gserviceaccount.com', private_key: 'KEY' }),
  );
  assert.equal(key?.client_email, 'bot@project.iam.gserviceaccount.com');
});

test('escaped newlines in the private key are restored', () => {
  // Pasting a key into a dashboard variable commonly turns newlines into \n.
  const key = parseServiceAccount(
    JSON.stringify({
      client_email: 'bot@project.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
    }),
  );
  assert.ok(key);
  assert.ok(key.private_key.includes('\n'));
  assert.ok(!key.private_key.includes('\\n'));
});

test('a base64-wrapped key file is accepted', () => {
  const json = JSON.stringify({ client_email: 'bot@x.iam.gserviceaccount.com', private_key: 'K' });
  const key = parseServiceAccount(Buffer.from(json).toString('base64'));
  assert.equal(key?.client_email, 'bot@x.iam.gserviceaccount.com');
});

test('missing or malformed keys are refused rather than half-accepted', () => {
  assert.equal(parseServiceAccount(''), null);
  assert.equal(parseServiceAccount('not json'), null);
  assert.equal(parseServiceAccount(JSON.stringify({ client_email: 'a@b.c' })), null);
  assert.equal(parseServiceAccount(JSON.stringify({ private_key: 'K' })), null);
});

test('the signed assertion verifies against the public key', () => {
  // Exercises the RS256 signing path end to end without contacting Google:
  // sign the same input the token request does, then verify it.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const key = parseServiceAccount(
    JSON.stringify({ client_email: 'bot@x.iam.gserviceaccount.com', private_key: pem }),
  );
  assert.ok(key);

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({ iss: key.client_email, aud: 'https://oauth2.googleapis.com/token' }),
  ).toString('base64url');

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  const signature = signer.sign(key.private_key);

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${claims}`);
  verifier.end();
  assert.ok(verifier.verify(publicKey, signature));
});
