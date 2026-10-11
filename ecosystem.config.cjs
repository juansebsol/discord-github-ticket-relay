// PM2 process file. Usage: npm run build && pm2 start ecosystem.config.cjs
// Settings are read from .env in this directory; every process shares the SQLite file.
module.exports = {
  apps: [
    {
      // HTTP: admin console + Discord interactions endpoint. Owns PORT, so exactly one.
      name: 'ticket-relay-web',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      env: { NODE_ENV: 'production', RUN_WORKER: 'false' },
      kill_timeout: 10000,
      max_memory_restart: '512M',
      time: true,
    },
    {
      // Queue workers: file issues, retry, reconcile, housekeeping. No port; scale freely.
      name: 'ticket-relay-worker',
      script: 'dist/worker.js',
      cwd: __dirname,
      instances: 2,
      env: { NODE_ENV: 'production', WORKER_CONCURRENCY: '2' },
      kill_timeout: 10000,
      max_memory_restart: '256M',
      time: true,
    },
  ],
};
