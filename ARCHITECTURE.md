System Architecture Overview
1. Application Layer

Node.js + Express application running on Port 5000.

Responsibilities:

User registration & login

JWT authentication

Dashboard rendering

Payment initiation

Static page rendering (Privacy, Terms, Refund)

2. Database Layer

PostgreSQL

Tables:

users

contests

purchases (planned / implemented)

Passwords stored as bcrypt hashes.

3. Reverse Proxy Layer

Nginx:

Proxies traffic from 443 → 127.0.0.1:5000

SSL termination handled at Nginx

HTTP redirected to HTTPS

4. Infrastructure Layer

Hosted on AWS EC2

DNS managed via Cloudflare

SSL via Let's Encrypt

5. Payment Flow (Planned)

User → Payment Initiate → Redirect to HDFC → Callback → Verification → Success/Failure Page
