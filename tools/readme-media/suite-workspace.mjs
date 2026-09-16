// A disposable workspace on the demo account retains its real AI configuration.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './runtime.mjs';
import { Account } from '../../frontend/tests/e2e/harness.mjs';

const dir = path.resolve(process.env.MEDIA_SCRATCH || path.join(ROOT, 'tmp/readme-media/suite'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'workspace.json');
if (process.argv.includes('--remove')) {
  const state = JSON.parse(fs.readFileSync(file));
  const account = new Account({ base: state.base }, state.username, '');
  account.session = fs.readFileSync(path.join(dir, 'session.txt'), 'utf8').trim();
  account.ws = state.workspace;
  await account.api(`/api/workspaces/${account.ws}`, { method: 'DELETE' });
  fs.writeFileSync(file, JSON.stringify({ ...state, removed: true }, null, 2));
  console.log('Removed the disposable recording workspace.');
} else {
  if (fs.existsSync(file) && !JSON.parse(fs.readFileSync(file)).removed) throw new Error('An existing suite workspace is available; reuse or remove it first.');
  const base = process.env.BASE_URL || 'http://127.0.0.1:9001';
  const account = await new Account({ base }, process.env.DEMO_USER || 'demo', process.env.DEMO_PASSWORD).login();
  const models = await account.api('/api/ai/models');
  console.log('AI enabled:', models.enabled, 'available models:', models.models?.length);
  const workspace = await account.api('/api/workspaces', { method: 'POST', body: { name: 'Demo recording', kind: 'personal' } });
  account.ws = workspace.id;
  fs.writeFileSync(path.join(dir, 'session.txt'), account.session);
  fs.writeFileSync(file, JSON.stringify({ base, username: account.name, workspace: account.ws }, null, 2));
  await account.upload('/api/import-data', fs.readFileSync(path.join(ROOT, 'tmp/readme-media/demo.zip')), 'demo.zip', 'application/zip');
  console.log('Prepared isolated recording workspace:', account.ws);
}
