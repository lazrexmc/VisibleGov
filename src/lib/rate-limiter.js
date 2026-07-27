// One limiter instance per source, shared by every caller in the process (PLAYBOOK §3.2).
export function createLimiter({ minIntervalMs }) {
  let nextSlot = 0;
  return {
    async take() {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + minIntervalMs;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    },
  };
}
