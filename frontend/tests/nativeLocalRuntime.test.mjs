import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmbeddedLocalRuntime } from '../src/native/localRuntime.js';

const host = (origin, marker = origin, ipad = true) => ({ location: { origin }, __GAMMA_LOCAL_ORIGIN__: marker, __GAMMA_IPAD__: ipad });
test('local presentation requires native flag and exact literal loopback HTTP port origin', () => {
  assert.equal(isEmbeddedLocalRuntime(host('http://127.0.0.1:49152')), true);
  assert.equal(isEmbeddedLocalRuntime(host('http://127.0.0.1:65535')), true);
  for (const origin of ['http://localhost:49152', 'https://127.0.0.1:49152', 'http://127.1:49152', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:04915', 'http://127.0.0.1:49152/', 'http://127.0.0.1:49152.evil.test', 'https://gamma.example']) {
    assert.equal(isEmbeddedLocalRuntime(host(origin)), false, origin);
  }
  assert.equal(isEmbeddedLocalRuntime(host('http://127.0.0.1:49152', 'http://127.0.0.1:49153')), false);
  assert.equal(isEmbeddedLocalRuntime(host('https://remote.test', 'http://127.0.0.1:49152')), false);
  assert.equal(isEmbeddedLocalRuntime(host('http://127.0.0.1:49152', null)), false);
  for (const ipad of [false, 'true', 1, null]) assert.equal(isEmbeddedLocalRuntime(host('http://127.0.0.1:49152', 'http://127.0.0.1:49152', ipad)), false);
  assert.equal(isEmbeddedLocalRuntime({__GAMMA_IPAD__: true, location: {origin:'http://127.0.0.1:49152'}}), false);
  assert.equal(isEmbeddedLocalRuntime(null), false);
});
