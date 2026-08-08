const { prepareLegalSelfCheckInput } = require('../v0/privacy-gateway.cjs');

class PrivacyGuard {
  prepare(input) {
    return prepareLegalSelfCheckInput(input);
  }
}

module.exports = { PrivacyGuard };
