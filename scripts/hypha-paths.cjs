const fs = require('node:fs');
const path = require('node:path');

function loadHyphaLock(projectRoot = process.cwd()) {
  const lockPath = path.join(projectRoot, 'hypha.lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const hyphaRoot = path.resolve(projectRoot, lock.localPath);
  return { lock, lockPath, hyphaRoot };
}

function loadHyphaDomain(projectRoot = process.cwd()) {
  return loadHyphaPackage('domain', projectRoot);
}

function loadHyphaCore(projectRoot = process.cwd()) {
  return loadHyphaPackage('core', projectRoot);
}

function loadHyphaAdaptersLocal(projectRoot = process.cwd()) {
  return loadHyphaPackage('adapters-local', projectRoot);
}

function loadHyphaKernel(projectRoot = process.cwd()) {
  return loadHyphaPackage('kernel', projectRoot);
}

function loadHyphaModels(projectRoot = process.cwd()) {
  return loadHyphaPackage('models', projectRoot);
}

function loadHyphaPackage(packageName, projectRoot = process.cwd()) {
  const supportedPackages = new Set([
    'adapters-local',
    'core',
    'domain',
    'kernel',
    'models'
  ]);
  if (!supportedPackages.has(packageName)) {
    throw new Error(`Unsupported Hypha package: ${packageName}`);
  }
  const { hyphaRoot } = loadHyphaLock(projectRoot);
  const packageEntry = path.join(hyphaRoot, 'packages', packageName, 'dist', 'index.js');
  if (!fs.existsSync(packageEntry)) {
    throw new Error(`Missing Hypha package build output: ${packageEntry}`);
  }
  return require(packageEntry);
}

module.exports = {
  loadHyphaLock,
  loadHyphaAdaptersLocal,
  loadHyphaCore,
  loadHyphaDomain,
  loadHyphaKernel,
  loadHyphaModels,
  loadHyphaPackage
};
