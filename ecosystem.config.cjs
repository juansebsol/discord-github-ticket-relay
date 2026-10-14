// PM2 process file. Usage: npm run build && pm2 start ecosystem.config.cjs
// Settings are read from .env in this directory; every process shares the SQLite file.
module.exports = {
  apps: [
    {
      // HTTP: admin console + Discord interactions endpoint. Owns PORT, so exactly one.
      name: 'ticket-relay-web',
      script: 'dist/index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      // MEMORY_LIMIT_MB matches max_memory_restart, so Deployment › Server health can show it.
      env: { NODE_ENV: 'production', RUN_WORKER: 'false', MEMORY_LIMIT_MB: '512' },
      kill_timeout: 10000,
      // Back off instead of restarting every second when misconfigured.
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '512M',
      time: true,
    },
    {
      // Queue workers: file issues, retry, reconcile, housekeeping. No port; scale freely.
      name: 'ticket-relay-worker',
      script: 'dist/worker.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 2,
      env: { NODE_ENV: 'production', WORKER_CONCURRENCY: '2', MEMORY_LIMIT_MB: '256' },
      kill_timeout: 10000,
      // Back off instead of restarting every second when misconfigured.
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '256M',
      time: true,
    },
    {
      // AI triage of filed tickets (optional; idles until a workspace turns triage on).
      // Separate from the filing workers: if it stops or Claude is down, filing is unaffected.
      name: 'ticket-relay-triage',
      script: 'dist/triage-worker.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      env: { NODE_ENV: 'production', MEMORY_LIMIT_MB: '256' },
      kill_timeout: 10000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '256M',
      time: true,
    },
  ],
};
