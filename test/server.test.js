import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('demo root redirects so relative module and worker URLs resolve correctly', async () => {
  const script = fileURLToPath(new URL('../scripts/serve-demo.js', import.meta.url));
  const server = spawn(process.execPath, [script], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const address = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Demo server did not start')), 10000);
      server.stdout.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
    });
    const redirect = await fetch(address, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    const page = await fetch(address);
    assert.equal(new URL(page.url).pathname, '/examples/browser.html');
    const html = await page.text();
    const scriptPath = html.match(/<script type="module" src="([^"]+)"/)[1];
    const module = await fetch(new URL(scriptPath, page.url));
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /javascript/);
    assert.match(await module.text(), /new Worker/);
    for (const path of ['/examples/worker.js', '/src/index.js', '/src/ncm.js', '/src/aes.js', '/src/bytes.js']) {
      assert.equal((await fetch(address + path)).status, 200, path);
    }
    assert.equal((await fetch(address + '/LICENSE.md')).status, 404);
    assert.equal((await fetch(address + '/.tmp/browser-fixture.ncm')).status, 404);
    assert.equal((await fetch(address + '/src/index.js', { method: 'POST' })).status, 405);
    const head = await fetch(address + '/src/index.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    server.kill();
  }
});
