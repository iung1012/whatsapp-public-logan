module.exports = {
  apps: [
    {
      name: 'whatsapp-logger',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1, // Must be 1 for WhatsApp connection
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
      env_development: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
      },
      // Log configuration
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      // Restart settings
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
