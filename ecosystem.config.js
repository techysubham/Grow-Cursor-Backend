module.exports = {
  apps: [
    // Local Development App (runs on port 5000)
    {
      name: 'grow-backend-local',
      script: 'src/index.js',
      env: {
        NODE_ENV: 'development',
        PORT: '5000'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: '5000'
      },
      watch: ['src'],
      ignore_watch: ['node_modules', 'public/uploads', '.git'],
      watch_delay: 1000,
      autorestart: true,
      max_memory_restart: '500M',
      error_file: './logs/local-error.log',
      out_file: './logs/local-out.log',
      log_file: './logs/local-combined.log',
      time: true
    },
    
    // Production App (runs on port 5000)
    // Start with: pm2 start ecosystem.config.js --env production --name grow-backend-prod
    {
      name: 'grow-backend-prod',
      script: 'src/index.js',
      env_production: {
        NODE_ENV: 'production',
        PORT: '5000'
      },
      instances: 'max',  // Cluster mode with max CPU cores
      exec_mode: 'cluster',
      autorestart: true,
      max_memory_restart: '800M',
      error_file: './logs/prod-error.log',
      out_file: './logs/prod-out.log',
      log_file: './logs/prod-combined.log',
      time: true
    }
  ],
  
  deploy: {
    // Local development deploy config (minimal)
    local: {
      user: 'user',
      host: 'localhost',
      ref: 'origin/develop',
      repo: 'git@github.com:your-org/Grow-Cursor-Backend.git',
      path: '/var/www/Grow-Cursor-Backend',
      'post-deploy': 'npm install && pm2 restart grow-backend-local --env development',
      'pre-deploy-local': 'echo "Deploying to local..."'
    },
    
    // Production deploy config
    production: {
      user: 'deploy',  // SSH user on production server
      host: 'your-prod-server.com',  // Production server IP/domain
      ref: 'origin/main',  // Deploy from main branch
      repo: 'git@github.com:your-org/Grow-Cursor-Backend.git',
      path: '/var/www/Grow-Cursor-Backend',
      'post-deploy': 'npm install && npm run build 2>/dev/null || true && pm2 restart grow-backend-prod --env production && pm2 save',
      'pre-deploy-local': 'echo "Deploying to PRODUCTION..."',
      'env': {
        'NODE_ENV': 'production'
      }
    }
  }
};
