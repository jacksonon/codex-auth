#!/usr/bin/env node

import { mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const entryFile = path.join(rootDir, 'agent-auth-node.js');

const targetMap = {
  'macos-x64': { bunTarget: 'bun-darwin-x64', output: 'agent-auth-macos-x64' },
  'macos-arm64': { bunTarget: 'bun-darwin-arm64', output: 'agent-auth-macos-arm64' },
  'windows-x64': { bunTarget: 'bun-windows-x64', output: 'agent-auth-windows-x64.exe' },
};

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const requested = process.argv.slice(2);
const targets = requested.length === 0 || requested.includes('all')
  ? Object.keys(targetMap)
  : requested;

for (const target of targets) {
  if (!targetMap[target]) {
    fail(`unknown target: ${target}. supported: ${Object.keys(targetMap).join(', ')}, all`);
  }
}

mkdirSync(distDir, { recursive: true });

for (const target of targets) {
  const { bunTarget, output } = targetMap[target];
  const outputFile = path.join(distDir, output);
  if (existsSync(outputFile)) rmSync(outputFile, { force: true });
  console.log(`Building ${target} -> ${outputFile}`);
  run('bun', ['build', '--compile', '--minify', '--sourcemap', entryFile, '--outfile', outputFile, '--target', bunTarget]);
}
