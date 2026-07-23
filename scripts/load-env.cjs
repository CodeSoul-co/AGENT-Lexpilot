const fs = require('node:fs');
const path = require('node:path');

// Load <projectRoot>/.env into process.env without overriding variables
// that are already set. The file is git-ignored; secrets stay local.
function loadLocalEnv(projectRoot = path.join(__dirname, '..')) {
  const envPath = path.join(projectRoot, '.env');
  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return envPath;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return envPath;
}

module.exports = { loadLocalEnv };
