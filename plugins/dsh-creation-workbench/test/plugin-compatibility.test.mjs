import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
const bootURL = new URL('../.runtime/host/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js', import.meta.url);
const boot = await import(bootURL.href).catch(() => null);
const semver = boot ? createRequire(bootURL)('semver') : null;

test('plugin peer declarations retain a minimum without an upper bound and agree with the lockfile', { skip: !semver && '需安装隔离DSH宿主以使用官方SemVer解析' }, () => {
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies);
  for (const name of ['@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tools']) {
    const range = manifest.peerDependencies[name];
    for (const version of ['0.2.1-rc.5', '0.2.1', '0.2.2-rc.2', '0.2.2', '0.3.0', '1.0.0']) assert(semver.satisfies(version, range), `${name}: ${version}`);
    assert.equal(semver.satisfies('0.2.1-rc.4', range, { includePrerelease: true }), false);
    assert.equal(semver.satisfies('0.2.0', range), false);
  }
  const schema = manifest.peerDependencies['@deepseek-ai/schemastery'];
  for (const version of ['3.18.5', '3.19.0', '3.20.0', '4.0.0']) assert(semver.satisfies(version, schema), version);
  assert.equal(semver.satisfies('3.18.4', schema), false);
});

test('official DSH compatibility evaluator accepts old, current and later runtimes without a version exemption', { skip: !boot && '需安装隔离DSH宿主' }, () => {
  for (const version of ['0.2.1-rc.5', '0.2.2-rc.2', '0.2.3-rc.1', '0.3.0', '1.0.0']) {
    assert.equal(boot.evaluatePluginCompatibility(manifest, {}, version), undefined, version);
  }
  assert.ok(boot.evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.4'));
});
