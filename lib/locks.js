// 按 key 串行执行的进程内锁：同一资源或模板的写操作排队，避免版本号冲突。
function createLocks() {
  const tails = new Map();
  return function withLock(key, task) {
    const run = (tails.get(key) || Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  };
}

module.exports = { createLocks };
