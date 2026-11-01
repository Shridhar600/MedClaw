// Remove the workspace-local test temp root after a run, so suites that crash before their own
// cleanup cannot leave synthetic data behind.
const fs = require('fs');
const path = require('path');

module.exports = async () => {
  fs.rmSync(path.resolve(process.cwd(), '.test-tmp'), { recursive: true, force: true });
};
