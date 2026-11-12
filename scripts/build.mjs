import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'dist', 'agent.mjs');
await mkdir(dirname(outfile), { recursive: true });
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'silent',
});
const bytes = await readFile(outfile);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const declaration = {
  schemaVersion: 1,
  id: 'codex',
  name: 'Codex',
  description: 'Local Codex app-server session backend for piwin',
  icon: { kind: 'brand', id: 'codex' },
  version: '0.1.0',
  minHostVersion: '0.0.0',
  protocol: 'piwin-agent-stdio',
  protocolVersion: 1,
  minHostProtocolVersion: 1,
  platforms: ['darwin', 'win32', 'linux'],
  verifiedCliVersions: ['0.114.0', '0.167.0'],
  helpUrl: 'https://github.com/openai/codex',
  artifact: { format: 'node-esm', entrypoint: 'dist/agent.mjs', sha256, byteSize: bytes.byteLength },
  compatibleRevisions: [],
  unversionedBindingCompatible: true,
  outputDirectories: [
    { id: 'images', base: 'working-directory', relativePath: '.piwin-codex/images', kind: 'image' },
  ],
};
await writeFile(join(root, 'piwin.json'), `${JSON.stringify({ sessionBackend: declaration }, null, 2)}\n`);
process.stdout.write(`${sha256} ${bytes.byteLength}\n`);
