Krishna National Contest 2026

Official website for Krishna National Contest organized by ISKCON.

🌐 Live URL

https://iskconcontest.org

🚀 Tech Stack

Backend: Node.js

Framework: Express.js

Language: TypeScript

Templating Engine: EJS

Layout Engine: express-ejs-layouts

Database: PostgreSQL

Authentication: JWT + bcrypt password hashing

Reverse Proxy: Nginx

SSL: Let’s Encrypt (Certbot)

Hosting: AWS EC2 (Ubuntu)

DNS & CDN: Cloudflare

🔐 Security Features

Password hashing using bcrypt

JWT-based authentication

Environment variables stored in .env

Nginx reverse proxy (Port 5000 internal only)

HTTPS enforced

Security group restricted (Port 5000 closed publicly)

💳 Payment Gateway

HDFC Payment Gateway
(Test Kit Pending – Under Integration Phase)

🧱 Deployment Details

Server: AWS EC2 (Ubuntu 22.04)

App Port: 5000 (Internal only)

Public Access: Nginx (80/443)

SSL: Auto-renew via Certbot

📦 Project Structure
src/
  app.ts
  config/
  routes/
  views/
dist/

📌 Current Status

Core flow complete

Authentication implemented

Dashboard working

Payment flow stub ready

Awaiting HDFC Test Kit for integration
