/** @type {import('pm2').StartOptions[]} */
module.exports = {
  apps: [
    {
      name: 'polymarket-ingestor',
      script: './dist/ingestor/index.js',
      autorestart: true,
      max_memory_restart: '256M',
      restart_delay: 5000,
      error_file: './logs/ingestor-err.log',
      out_file: './logs/ingestor-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info'
      }
    },
    {
      name: 'polymarket-analyzer',
      script: './dist/analyzer/index.js',
      autorestart: true,
      max_memory_restart: '500M',
      restart_delay: 5000,
      error_file: './logs/analyzer-err.log',
      out_file: './logs/analyzer-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info'
      }
    }
  ]
};
