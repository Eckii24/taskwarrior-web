# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Security Features

This application includes several built-in security features:

### Implemented Protections

- ✅ **Rate Limiting**: Prevents brute force and DoS attacks
- ✅ **Input Validation**: All user inputs are validated using Joi schemas
- ✅ **Path Validation**: Prevents directory traversal attacks
- ✅ **Security Headers**: Helmet middleware with CSP, HSTS, X-Frame-Options
- ✅ **CORS Protection**: Configurable allowed origins
- ✅ **Safe Command Execution**: Uses `execFile()` instead of shell execution
- ✅ **SQL Injection Protection**: Parameterized queries for all database operations
- ✅ **Error Sanitization**: Production mode hides internal error details
- ✅ **Structured Logging**: Comprehensive audit trail of all actions

### Known Limitations

⚠️ **No Built-in Authentication**: This application does NOT include user authentication or authorization. 

**Important**: Do NOT expose this application directly to the internet without implementing authentication.

## Reporting a Vulnerability

If you discover a security vulnerability, please follow these steps:

1. **Do NOT** open a public GitHub issue
2. Email the maintainers at: [Insert email or use GitHub Security Advisory]
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will respond within 48 hours and work with you to address the issue.

## Security Best Practices

### For Production Deployment

1. **Authentication Required**
   - Use HTTP Basic Auth via reverse proxy (nginx, Apache)
   - Or implement custom authentication middleware
   - Do NOT deploy without authentication

2. **Use HTTPS**
   - Always use HTTPS in production
   - Deploy behind a reverse proxy with TLS/SSL

3. **Environment Configuration**
   - Set `NODE_ENV=production`
   - Generate secure `SESSION_SECRET` (min 32 bytes)
   - Restrict `ALLOWED_ORIGINS` to specific domains
   - Validate `TASKDATA` and `TASKRC` paths

4. **Network Security**
   - Use firewall rules to restrict access
   - Consider VPN for remote access
   - Bind to localhost if using reverse proxy

5. **Regular Updates**
   - Keep dependencies updated: `npm audit`
   - Monitor security advisories
   - Apply security patches promptly

6. **Monitoring**
   - Review logs regularly (`logs/error.log`, `logs/combined.log`)
   - Set up alerts for suspicious activity
   - Monitor rate limit violations

### Configuration Hardening

```bash
# Production environment variables
NODE_ENV=production
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
ALLOWED_ORIGINS=https://yourdomain.com
LOG_LEVEL=warn
```

### Reverse Proxy Example (nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name tasks.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # HTTP Basic Auth
    auth_basic "Taskwarrior Web";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Security Checklist

Before deploying to production, ensure:

- [ ] Authentication is implemented
- [ ] HTTPS is configured
- [ ] `SESSION_SECRET` is set and secure
- [ ] `ALLOWED_ORIGINS` is restricted
- [ ] `NODE_ENV=production`
- [ ] Firewall rules are configured
- [ ] Logs are being monitored
- [ ] Dependencies are up to date
- [ ] Backup strategy is in place
- [ ] Reverse proxy is hardened

## Additional Resources

- [SECURITY_ANALYSIS.md](SECURITY_ANALYSIS.md) - Detailed security analysis
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)

## Changelog

### Version 1.x
- Added rate limiting
- Implemented input validation
- Fixed path traversal vulnerabilities
- Added security headers
- Implemented structured logging
- Added error sanitization

---

*Last Updated: December 26, 2025*
