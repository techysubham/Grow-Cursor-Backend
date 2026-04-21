# Local to Production Deployment Guide

## Overview

This setup allows you to:
1. **Develop locally** with hot-reload (nodemon)
2. **Test changes** in a local environment
3. **Deploy to production** with a single command
4. **Keep environments completely separate** (different DBs, configs, API keys)

---

## Environment Setup

### Files Structure

```
.env              → Default (currently production/current)
.env.local        → Local development (git-ignored)
.env.production   → Production (git-ignored, manually managed on prod server)
ecosystem.config.js → PM2 configuration for both environments
deploy.sh         → Automated deployment script
```

### Configure Environments

#### 1. Local Development (`.env.local`)

**When to use:** Daily development, testing, feature branches

```bash
NODE_ENV=development
PORT=5000
MONGODB_URI=mongodb+srv://dev_user:dev_pass@dev-cluster.mongodb.net/grow_cursor_dev
JWT_SECRET=dev-secret-key
CLIENT_ORIGIN=http://localhost:5173
```

**Features:**
- Uses development MongoDB database (separate from production)
- Logs to console
- Auto-reload on code changes
- Slower but more detailed error messages

#### 2. Production (`.env.production`)

**When to use:** Production server only, managed by deployment script

```bash
NODE_ENV=production
PORT=5000
MONGODB_URI=mongodb+srv://prod_user:STRONG_PASS@prod-cluster.mongodb.net/grow_cursor_prod
JWT_SECRET=SUPER_STRONG_SECRET_KEY
CLIENT_ORIGIN=https://ems-growmentality.com
```

**Features:**
- Production MongoDB (must use separate cluster/database)
- Cluster mode (uses all CPU cores)
- Optimized for performance
- Only critical errors logged

**⚠️ IMPORTANT:**
- Keep `.env.production` **NEVER** in git (it's in .gitignore)
- Manually create/update it on production server only
- Use strong JWT_SECRET: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## Workflow: Local Development → Production

### Step 1: Setup Local Environment

```bash
cd /var/www/Grow-Cursor-Backend

# Copy example to local
cp .env .env.local

# Edit .env.local with your local MongoDB
nano .env.local
```

### Step 2: Run Locally (Development)

```bash
# Option A: Using npm scripts (recommended)
npm run dev:nodemon         # With auto-reload (port 5000)

# Option B: Using PM2
npm run pm2:start           # Starts local dev app
npm run pm2:logs            # View logs
npm run pm2:restart         # Restart after code changes
```

### Step 3: Test Your Changes

```bash
# Run locally, test all functionality
# Edit code, see changes automatically reload
# Verify logs: npm run pm2:logs
```

### Step 4: Push to Repository

```bash
# Commit and push to develop branch (testing branch)
git add .
git commit -m "Feature: Add new automessaging"
git push origin develop

# When ready for production, create PR and merge to main
# Then deploy
```

### Step 5: Deploy to Production

```bash
# Option A: Quick deploy (auto-pulls from main)
./deploy.sh production
# or
npm run deploy:prod

# Option B: Manual PM2 deploy (if you have SSH setup)
pm2 deploy ecosystem.config.js production --force
```

---

## Commands Reference

### Local Development

```bash
# Start local dev with auto-reload
npm run dev:nodemon

# Or use PM2 (stays running even if terminal closes)
npm run pm2:start
npm run pm2:logs grep "grow-backend-local"

# Make a code change → auto-reload happens
# Check logs: npm run pm2:logs
```

### PM2 Management

```bash
# View all apps
pm2 status

# Restart specific app
pm2 restart grow-backend-local

# View logs
pm2 logs                    # All logs
pm2 logs grow-backend-local # Only local app

# Stop all
pm2 stop all

# Monitor (live dashboard)
pm2 monit
```

### Deployment

```bash
# Deploy to local (for testing)
./deploy.sh local
npm run deploy:local

# Deploy to production (requires confirmation)
./deploy.sh production
npm run deploy:prod

# Check deployment status
./deploy.sh check
npm run deploy:check
```

---

## Comparison: Local vs Production

| Feature | Local | Production |
|---------|-------|-----------|
| **Database** | dev MongoDB | prod MongoDB (separate) |
| **PORT** | 5000 | 5000 (behind Nginx) |
| **Auto-reload** | ✅ Yes (nodemon) | ❌ No |
| **Logging** | Console + file | File only (prod-combined.log) |
| **Cluster Mode** | ❌ Single process | ✅ Multi-core (instances: max) |
| **Error Handling** | Verbose | Minimal (production-grade) |
| **Restarts** | Manual or via pm2 | Auto via PM2 + systemd |

---

## Production Server Setup (First Time)

If setting up a new production server:

```bash
# 1. SSH into production server
ssh deploy@your-prod-server.com

# 2. Clone repo
cd /var/www
git clone git@github.com:your-org/Grow-Cursor-Backend.git
cd Grow-Cursor-Backend

# 3. Install dependencies
npm install

# 4. Create .env.production manually (DO NOT COMMIT)
nano .env.production
# Add all production values here

# 5. Start PM2 app for production
pm2 start ecosystem.config.js --env production --name grow-backend-prod

# 6. Setup PM2 to start on server reboot
pm2 startup
pm2 save

# 7. Verify running
pm2 status
curl http://localhost:5000/health  # Should return {"ok":true}
```

---

## Git Workflow

### Branches

- **`develop`** — Main development branch, merge feature branches here
- **`main`** — Production-ready code, deployed to production
- **`feature/x`** — Individual feature branches, created from develop

### Typical Flow

```bash
# 1. Create feature branch
git checkout develop
git pull origin develop
git checkout -b feature/auto-messaging

# 2. Make changes, commit
git add .
git commit -m "Add automated messaging with n8n"

# 3. Push and create PR
git push origin feature/auto-messaging
# Create PR on GitHub: feature/auto-messaging → develop

# 4. Code review, merge to develop
# (Automatic deploy to local/staging if CI configured)

# 5. When ready for production, merge develop → main
git checkout main
git pull origin main
git merge develop
git push origin main

# 6. Deploy
npm run deploy:prod
```

---

## Continuous Integration (Optional)

To automate testing/deployment, add GitHub Actions workflow:

`.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main, develop]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with: { node-version: 18 }
      - run: npm install
      - run: npm run lint 2>/dev/null || true  # Optional: lint check
      
      # Deploy to staging on develop push
      - if: github.ref == 'refs/heads/develop'
        run: npm run deploy:local
      
      # Deploy to production on main push
      - if: github.ref == 'refs/heads/main'
        run: npm run deploy:prod
```

---

## Troubleshooting

### App crashes after deploy

```bash
npm run pm2:logs     # Check error messages
pm2 restart all      # Restart
```

### MongoDB connection fails

```bash
# Verify MONGODB_URI in .env.local / .env.production
# Check IP whitelist on MongoDB Atlas
mongo <uri>  # Test connection manually
```

### Changes not reloading locally

```bash
# Nodemon not watching?
npm run pm2:restart grow-backend-local

# Check nodemon.json is correct
cat nodemon.json
```

### Can't connect to production server

```bash
# Verify SSH key
ssh-keyscan your-prod-server.com >> ~/.ssh/known_hosts

# Test SSH
ssh deploy@your-prod-server.com "pm2 status"
```

---

## Security Checklist

- ✅ `.env.local` and `.env.production` in `.gitignore` (never commit)
- ✅ Production JWT_SECRET is strong (32+ random bytes)
- ✅ Production MONGODB_URI uses separate database/cluster
- ✅ Production API keys (eBay, Groq) are different from dev
- ✅ SSH public key authentication set up between servers
- ✅ Firewall allows only necessary ports (5000 behind Nginx reverse proxy)
- ✅ Regular backups of production MongoDB

---

## Next Steps

1. **Setup production server** (follow "Production Server Setup" above)
2. **Update `deploy.sh`** with your actual server details:
   - Change `PROD_SERVER` to your domain
   - Change `PROD_USER` to your deploy user
3. **Create `.env.production` manually on prod server** with real credentials
4. **Test deploy:**
   ```bash
   npm run deploy:prod  # Will ask for confirmation
   ```
5. **Optional: Setup CI/CD** for automatic deployment

---

## Support

For issues, check:
- PM2 logs: `npm run pm2:logs`
- Deployment logs: Check `./logs/` directory
- Git status: `git status`
- Environment vars: `printenv | grep MONGODB` (verify they're loaded)
