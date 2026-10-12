const crypto = require('node:crypto');
const { createAttemptLimiter } = require('./access-attempts');

function createAdminLoginProtection(options, now = Date.now) {
  const attempts = createAttemptLimiter({
    file: options.loginAttemptsFile,
    maxAttempts: options.loginMaxAttempts,
    windowMs: options.loginRetryWindowMinutes * 60000,
    now,
  });
  // req.ip is resolved by Express's explicit trusted-proxy policy. Never use
  // a user-supplied username, cookie, X-Real-IP, or the leftmost XFF value.
  const key = req => 'ip:' + crypto.createHash('sha256').update(String(req.ip || '').replace(/^::ffff:/, '')).digest('hex');
  function check(req) {
    const decisions = [attempts.check(key(req)), attempts.check('global', options.loginGlobalMaxAttempts)];
    const denied = decisions.filter(d => !d.allowed);
    return denied.length ? { allowed: false, retryAfter: Math.max(...denied.map(d => d.retryAfter)) } : { allowed: true };
  }
  function failed(req) {
    // The shared cap also bounds password guesses spread across client IPs.
    attempts.take('global', options.loginGlobalMaxAttempts);
    attempts.take(key(req));
  }
  function succeeded(req) { attempts.clear(key(req)); }
  return { check, failed, succeeded };
}

module.exports = { createAdminLoginProtection };
