module.exports = {
  apps: [
    {
      name: "mcp-server",
      script: "dist/src/index.js",
      cwd: "/home/deploy/apps/catalunya2022-mcp",
      // V8's default heap limit on this droplet is ~493 MB, far above the
      // 180 MB max_memory_restart below — without a budget V8 feels no
      // pressure, lets RSS drift upward, and PM2 recycles a healthy process.
      // Warm heap sits near 55 MB; 80 MB makes GC kick in early so RSS
      // plateaus with real headroom under both thresholds.
      node_args: "--max-old-space-size=80",
      env: {
        NODE_ENV: "production",
        PORT: "3001",
      },
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      // Restarts within min_uptime count toward max_restarts; exponential
      // backoff spaces them out so a crash loop doesn't exhaust the budget
      // (and permanently stop the service) within seconds.
      min_uptime: "10s",
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "180M",
      // The app handles SIGTERM and SIGINT; be explicit about what PM2 sends.
      kill_signal: "SIGTERM",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "/home/deploy/logs/mcp-error.log",
      out_file: "/home/deploy/logs/mcp-out.log",
    },
  ],
};
