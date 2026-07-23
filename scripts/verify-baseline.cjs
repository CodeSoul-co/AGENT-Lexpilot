const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { loadHyphaLock } = require('./hypha-paths.cjs');

const projectRoot = path.resolve(__dirname, '..');
const { lock, hyphaRoot } = loadHyphaLock(projectRoot);
const safeDirectory = hyphaRoot.replaceAll('\\', '/');

const actualCommit = execFileSync(
  'git',
  ['-c', `safe.directory=${safeDirectory}`, '-C', hyphaRoot, 'rev-parse', 'HEAD'],
  { encoding: 'utf8' }
).trim();

let baselineMode = 'exact';
if (actualCommit !== lock.commit) {
  const ancestorCheck = spawnSync(
    'git',
    ['-c', `safe.directory=${safeDirectory}`, '-C', hyphaRoot, 'merge-base', '--is-ancestor', lock.commit, actualCommit]
  );
  if (ancestorCheck.status !== 0) {
    throw new Error(`Hypha baseline diverged: expected ${lock.commit}, received ${actualCommit}`);
  }

  const committedScopeDiff = spawnSync(
    'git',
    [
      '-c',
      `safe.directory=${safeDirectory}`,
      '-C',
      hyphaRoot,
      'diff',
      '--quiet',
      `${lock.commit}..${actualCommit}`,
      '--',
      ...lock.lockedScope
    ]
  );
  if (committedScopeDiff.status !== 0) {
    throw new Error('Hypha changed inside the locked business dependency scope.');
  }
  baselineMode = 'compatible-descendant';
}

const workingScopeStatus = execFileSync(
  'git',
  [
    '-c',
    `safe.directory=${safeDirectory}`,
    '-C',
    hyphaRoot,
    'status',
    '--porcelain',
    '--',
    ...lock.lockedScope
  ],
  { encoding: 'utf8' }
).trim();
if (workingScopeStatus) {
  throw new Error(`Hypha has uncommitted changes inside the locked scope:\n${workingScopeStatus}`);
}

for (const relativePath of lock.requiredBuildOutputs) {
  const absolutePath = path.join(hyphaRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Missing Hypha build output: ${relativePath}`);
  }
}

console.log(
  `Hypha baseline verified: ${lock.branch}@${lock.commit.slice(0, 12)} (${baselineMode}, workspace HEAD ${actualCommit.slice(0, 12)})`
);
