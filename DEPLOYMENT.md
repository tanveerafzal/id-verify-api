# Deployment Guide - ID Verification API

This guide walks you through deploying the ID Verification backend API and PostgreSQL database to an AWS Linux server.

## Prerequisites

- AWS Linux server (Amazon Linux 2, Ubuntu, or similar)
- SSH access to your server
- Domain name (optional but recommended)
- Node.js 20.x or higher

## Step 1: Install PostgreSQL on Linux Server

### For Amazon Linux 2 / RHEL / CentOS:

```bash
# Update system
sudo yum update -y

# Install PostgreSQL 15
sudo yum install -y postgresql15 postgresql15-server

# Initialize database
sudo postgresql-setup --initdb

# Start PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Check status
sudo systemctl status postgresql
```

### For Ubuntu / Debian:

```bash
# Update system
sudo apt update
sudo apt upgrade -y

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# PostgreSQL will start automatically
sudo systemctl status postgresql
```

## Step 2: Configure PostgreSQL

```bash
# Switch to postgres user
sudo -i -u postgres

# Create database and user
psql
```

In the PostgreSQL prompt:

```sql
-- Create database
CREATE DATABASE id_verification;

-- Create user with password
CREATE USER idverify_user WITH ENCRYPTED PASSWORD 'M@lik19731973';

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE id_verification TO idverify_user;

-- Grant schema privileges (PostgreSQL 15+)
\c id_verification
GRANT ALL ON SCHEMA public TO idverify_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO idverify_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO idverify_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO idverify_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO idverify_user;

-- Exit
\q
exit
```

### Configure PostgreSQL for Network Access (if needed)

```bash
# Edit postgresql.conf
sudo nano /var/lib/pgsql/15/data/postgresql.conf
# Or for Ubuntu:
sudo nano /etc/postgresql/16/main/postgresql.conf

# Find and change:
listen_addresses = 'localhost'  # Keep as localhost for security if backend is on same server

# Edit pg_hba.conf
sudo nano /var/lib/pgsql/16/data/pg_hba.conf
# Or for Ubuntu:
sudo nano /etc/postgresql/16/main/pg_hba.conf

# Add this line for local connections:
host    id_verification    idverify_user    127.0.0.1/32    md5

# Restart PostgreSQL
sudo systemctl restart postgresql
```

## Step 3: Install Node.js on Server

```bash
# Install Node.js 20.x using NodeSource
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# Or for Ubuntu:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version      node --version
npm --version
```

## Step 4: Deploy Backend Application

### Create application directory

```bash
# Create app directory
sudo mkdir -p /var/www/id-verify-api
sudo chown $USER:$USER /var/www/id-verify-api
cd /var/www/id-verify-api
```

### Upload your code

**Option A: Using Git (recommended)**

```bash
# If you have a git repository
git clone https://github.com/yourusername/id-verify-api.git .

# Or if you need to initialize
git init
git remote add origin https://github.com/yourusername/id-verify-api.git
git pull origin main
```

**Option B: Using SCP from your local machine**

```bash
# From your local machine (Windows)
# Use WinSCP or run from WSL/Git Bash:
scp -r C:/Ultrasoft/ultrareach.dev/id-verify-api/* user@your-server-ip:/var/www/id-verify-api/
```

### Install dependencies

```bash
cd /var/www/id-verify-api
npm install --production
```

## Step 5: Configure Environment Variables

```bash
# Create production .env file
nano .env
```

Add the following (update with your actual values):

```env
# Server Configuration
PORT=3002
NODE_ENV=production

# Database - UPDATE WITH YOUR ACTUAL PASSWORD
DATABASE_URL="postgresql://idverify_user:your_secure_password_here@localhost:5432/id_verification?schema=public"

# Security - GENERATE STRONG SECRETS
JWT_SECRET=your_strong_jwt_secret_minimum_32_chars
ENCRYPTION_KEY=your_strong_encryption_key_32_chars
WEBHOOK_SECRET=your_webhook_secret_here

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Logging
LOG_LEVEL=info

# AWS (Optional - if using S3 for document storage)
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
# AWS_REGION=us-east-1
# S3_BUCKET_NAME=id-verification-documents
```

**Generate secure secrets:**

```bash
# Generate random secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Step 6: Build and Run Database Migrations

```bash
# Generate Prisma client
npm run prisma:generate

# Push database schema
npm run prisma:push

# Build TypeScript
npm run build
```

## Step 7: Install and Configure PM2 (Process Manager)

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start the application
pm2 start dist/server.js --name id-verify-api

# Configure PM2 to start on boot
pm2 startup
# Follow the instructions from the command output

# Save PM2 process list
pm2 save

# Check status
pm2 status
pm2 logs id-verify-api
```

## Step 8: Configure Nginx Reverse Proxy

### Install Nginx

```bash
# Amazon Linux 2 / RHEL
sudo amazon-linux-extras install nginx1 -y

# Ubuntu
sudo apt install nginx -y

# Start Nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

### Configure Nginx

```bash
# Create Nginx configuration
sudo nano /etc/nginx/conf.d/id-verify-api.conf
```

Add the following:

```nginx
server {
    listen 80;
    server_name your-domain.com;  # Replace with your domain or IP

    # API endpoints
    location /api {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Increase timeout for long-running requests
        proxy_connect_timeout 600;
        proxy_send_timeout 600;
        proxy_read_timeout 600;
        send_timeout 600;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://localhost:3002;
        access_log off;
    }
}
```

### Test and reload Nginx

```bash
# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

## Step 9: Configure Firewall

```bash
# Amazon Linux 2 / RHEL (using firewalld)
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload

# Ubuntu (using ufw)
sudo ufw allow 'Nginx Full'
sudo ufw allow ssh
sudo ufw enable
```

## Step 10: SSL Certificate (Optional but Recommended)

### Using Let's Encrypt with Certbot

```bash
# Install Certbot
# Amazon Linux 2
sudo yum install -y certbot python3-certbot-nginx

# Ubuntu
sudo apt install -y certbot python3-certbot-nginx

# Obtain and install certificate
sudo certbot --nginx -d your-domain.com

# Test auto-renewal
sudo certbot renew --dry-run
```

## Monitoring and Maintenance

### View logs

```bash
# Application logs
pm2 logs id-verify-api

# Nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# PostgreSQL logs
sudo tail -f /var/lib/pgsql/15/data/log/postgresql-*.log
```

### Restart services

```bash
# Restart backend
pm2 restart id-verify-api

# Restart Nginx
sudo systemctl restart nginx

# Restart PostgreSQL
sudo systemctl restart postgresql
```

### Update application

```bash
cd /var/www/id-verify-api

# Pull latest changes
git pull origin main

# Install dependencies
npm install --production

# Rebuild
npm run build

# Run migrations if needed
npm run prisma:push

# Restart app
pm2 restart id-verify-api
```

### Database backup

```bash
# Create backup script
sudo nano /usr/local/bin/backup-db.sh
```

Add:

```bash
#!/bin/bash
BACKUP_DIR="/var/backups/postgresql"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# Backup database
sudo -u postgres pg_dump id_verification > $BACKUP_DIR/id_verification_$DATE.sql

# Keep only last 7 days of backups
find $BACKUP_DIR -name "*.sql" -mtime +7 -delete

echo "Backup completed: $BACKUP_DIR/id_verification_$DATE.sql"
```

Make executable and schedule:

```bash
sudo chmod +x /usr/local/bin/backup-db.sh

# Add to crontab (daily at 2 AM)
sudo crontab -e
# Add this line:
0 2 * * * /usr/local/bin/backup-db.sh
```

## Environment Variables Reference

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port | Yes |
| `NODE_ENV` | Environment (production) | Yes |
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `JWT_SECRET` | JWT token secret | Yes |
| `ENCRYPTION_KEY` | Data encryption key | Yes |
| `WEBHOOK_SECRET` | Webhook signature secret | No |
| `AWS_ACCESS_KEY_ID` | AWS access key for S3 | No |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key for S3 | No |
| `S3_BUCKET_NAME` | S3 bucket for documents | No |

## Troubleshooting

### Application won't start

```bash
# Check logs
pm2 logs id-verify-api

# Check if port is in use
sudo lsof -i :3002

# Check environment variables
pm2 env id-verify-api
```

### Database connection issues

```bash
# Test database connection
psql -U idverify_user -d id_verification -h localhost

# Check PostgreSQL is running
sudo systemctl status postgresql

# Check PostgreSQL logs
sudo tail -f /var/lib/pgsql/15/data/log/postgresql-*.log
```

### Nginx issues

```bash
# Test configuration
sudo nginx -t

# Check error logs
sudo tail -f /var/log/nginx/error.log

# Check if Nginx is running
sudo systemctl status nginx
```

## Security Checklist

- [ ] Changed default PostgreSQL password
- [ ] Generated strong JWT_SECRET and ENCRYPTION_KEY
- [ ] Configured firewall to only allow necessary ports
- [ ] Installed SSL certificate
- [ ] Set NODE_ENV=production
- [ ] Disabled PostgreSQL remote access (if not needed)
- [ ] Set up regular database backups
- [ ] Configured log rotation
- [ ] Updated system packages
- [ ] Set up monitoring/alerting

## API Endpoints

After deployment, your API will be available at:

- Health Check: `http://your-domain.com/health`
- API Base: `http://your-domain.com/api/v1/`
- Partner Login: `http://your-domain.com/api/v1/partners/login`
- Verifications: `http://your-domain.com/api/v1/verifications`

## Support

For issues or questions, check:
- Application logs: `pm2 logs id-verify-api`
- Database logs: PostgreSQL log directory
- Nginx logs: `/var/log/nginx/`
