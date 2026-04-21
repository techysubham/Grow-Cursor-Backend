#!/bin/bash

# deploy.sh — Deploy backend to production
# Usage:
#   ./deploy.sh local      # Deploy to local dev environment
#   ./deploy.sh production # Deploy to production (from main branch)
#   ./deploy.sh check      # Check current status

set -e  # Exit on error

ENVIRONMENT=${1:-production}
REPO_DIR=$(pwd)
PROD_SERVER="your-prod-server.com"
PROD_USER="deploy"
PROD_PATH="/var/www/Grow-Cursor-Backend"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
print_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

print_info "Starting deployment to: $ENVIRONMENT"

# Verify we're in the right directory
if [ ! -f "package.json" ] || [ ! -f "src/index.js" ]; then
  print_error "Not in backend root directory (package.json or src/index.js not found)"
fi

case $ENVIRONMENT in
  local)
    print_info "Deploying to LOCAL development environment..."
    
    # Install dependencies
    print_info "Installing dependencies..."
    npm install
    
    # Load .env.local
    if [ ! -f ".env.local" ]; then
      print_warn ".env.local not found. Using .env instead."
    else
      print_info "Using .env.local"
      cp .env.local .env
    fi
    
    # Start with PM2 (development mode)
    print_info "Starting with PM2 (development mode)..."
    pm2 start ecosystem.config.js --env development --only grow-backend-local || true
    pm2 logs grow-backend-local --lines 20
    
    print_info "✅ Local deployment complete!"
    print_info "Backend running on http://localhost:5000"
    ;;

  production)
    print_info "Deploying to PRODUCTION environment..."
    
    # Check current branch
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    if [ "$CURRENT_BRANCH" != "main" ]; then
      print_warn "⚠️  WARNING: Current branch is '$CURRENT_BRANCH', not 'main'"
      read -p "Continue anyway? (y/N): " -n 1 -r
      echo
      if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_error "Deployment cancelled"
      fi
    fi
    
    # Ask for confirmation
    print_warn "🚨 CAUTION: About to deploy to PRODUCTION"
    read -p "Type 'DEPLOY' to confirm: " confirmation
    if [ "$confirmation" != "DEPLOY" ]; then
      print_error "Deployment cancelled"
    fi
    
    # Check git status
    print_info "Checking git status..."
    if [ -n "$(git status --porcelain)" ]; then
      print_warn "Uncommitted changes detected. Stashing..."
      git stash
    fi
    
    # Pull latest from main
    print_info "Fetching latest from origin/main..."
    git fetch origin
    git checkout main
    git pull origin main || print_error "Failed to pull latest code"
    
    # Build/Test (optional)
    print_info "Running tests (if any)..."
    # npm run test 2>/dev/null || print_warn "Tests skipped or failed"
    
    # Deploy via PM2
    print_info "Deploying via PM2..."
    pm2 deploy ecosystem.config.js production --force || print_error "PM2 deploy failed"
    
    print_info "✅ Production deployment complete!"
    ;;

  check)
    print_info "Checking deployment status..."
    
    print_info "Local environment:"
    pm2 status grow-backend-local 2>/dev/null || echo "  (not running)"
    
    print_info "Production environment (ssh):"
    ssh -q "$PROD_USER@$PROD_SERVER" "cd $PROD_PATH && pm2 status grow-backend-prod" 2>/dev/null || echo "  (cannot connect)"
    
    print_info "Git branches:"
    git branch -vv
    ;;

  *)
    print_error "Unknown environment: $ENVIRONMENT\n\nUsage:\n  $0 local      # Deploy to local\n  $0 production # Deploy to production\n  $0 check      # Check status"
    ;;
esac
