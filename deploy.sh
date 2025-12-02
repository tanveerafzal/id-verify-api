#!/bin/bash

# ID Verification API Deployment Script
# This script automates the deployment process on AWS Linux server

set -e  # Exit on error

echo "========================================"
echo "ID Verification API Deployment"
echo "========================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo -e "${RED}Please do not run as root${NC}"
    exit 1
fi

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

echo "Step 1: Checking prerequisites..."
echo "-----------------------------------"

# Check Node.js
if command_exists node; then
    NODE_VERSION=$(node -v)
    echo -e "${GREEN}✓${NC} Node.js installed: $NODE_VERSION"
else
    echo -e "${RED}✗${NC} Node.js not found. Please install Node.js 20.x first."
    exit 1
fi

# Check npm
if command_exists npm; then
    NPM_VERSION=$(npm -v)
    echo -e "${GREEN}✓${NC} npm installed: $NPM_VERSION"
else
    echo -e "${RED}✗${NC} npm not found."
    exit 1
fi

# Check PostgreSQL
if command_exists psql; then
    PSQL_VERSION=$(psql --version)
    echo -e "${GREEN}✓${NC} PostgreSQL installed: $PSQL_VERSION"
else
    echo -e "${YELLOW}!${NC} PostgreSQL client not found. Make sure PostgreSQL is installed."
fi

# Check PM2
if command_exists pm2; then
    echo -e "${GREEN}✓${NC} PM2 installed"
else
    echo -e "${YELLOW}!${NC} PM2 not found. Installing PM2..."
    sudo npm install -g pm2
fi

echo ""
echo "Step 2: Installing dependencies..."
echo "-----------------------------------"
# Install all dependencies (including dev deps needed for build)
npm install

echo ""
echo "Step 3: Building application..."
echo "-----------------------------------"
npm run build

# Optional: Remove dev dependencies after build to save space
# Uncomment the line below if you want to minimize disk usage
# npm prune --production

echo ""
echo "Step 4: Setting up database..."
echo "-----------------------------------"

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "${YELLOW}!${NC} .env file not found. Creating from .env.example..."
    cp .env.example .env
    echo -e "${YELLOW}!${NC} Please edit .env file with your actual configuration before continuing."
    echo -e "${YELLOW}!${NC} Run this script again after updating .env"
    exit 1
fi

# Generate Prisma client
npm run prisma:generate

# Push database schema
echo "Pushing database schema..."
npm run prisma:push

echo ""
echo "Step 5: Starting application with PM2..."
echo "-----------------------------------"

# Stop existing process if running
pm2 delete id-verify-api 2>/dev/null || true

# Start the application
pm2 start dist/server.js --name id-verify-api

# Save PM2 process list
pm2 save

# Show status
pm2 status

echo ""
echo -e "${GREEN}========================================"
echo "Deployment Complete!"
echo -e "========================================${NC}"
echo ""
echo "Application is running on port 3002"
echo ""
echo "Useful commands:"
echo "  pm2 logs id-verify-api    - View logs"
echo "  pm2 restart id-verify-api - Restart application"
echo "  pm2 stop id-verify-api    - Stop application"
echo "  pm2 status                - Check status"
echo ""
echo "Next steps:"
echo "  1. Configure Nginx reverse proxy (see DEPLOYMENT.md)"
echo "  2. Set up SSL certificate"
echo "  3. Configure firewall"
echo "  4. Set up database backups"
echo ""
echo "For detailed instructions, see DEPLOYMENT.md"
