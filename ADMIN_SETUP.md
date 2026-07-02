# Admin Authentication Setup

## Overview

This application now has two views:
- **Public View**: Shows the F&O stock list without prices (accessible at `/`)
- **Admin View**: Full access to Zerodha integration, live prices, and all features (requires admin authentication)

## Setup Instructions

### 1. Backend Configuration

Add the `ADMIN_SECRET` to your backend `.env` file:

```bash
# In Cal_Spread_Backend/.env
ADMIN_SECRET=your_secure_secret_key_here
```

**Important**: Choose a strong, random secret key. Anyone with this key can access admin features.

### 2. How It Works

#### Public Access (Default)
- Visit `https://calspread.online` or your deployed URL
- Users see the list of F&O stocks but no prices
- No Zerodha connection or sensitive data is shown

#### Admin Access
1. Navigate to `https://calspread.online/admin/verify` (or `/admin/verify` on localhost)
2. Enter the admin secret from your `.env` file
3. Upon successful verification:
   - Admin token is stored in browser localStorage
   - User is redirected to home page with full admin features
   - Can now:
     - Connect to Zerodha
     - View live prices
     - See premium/discount calculations
     - Adjust risk-free rate
     - Stream real-time market data

#### Admin Token Management
- Admin tokens are valid for 24 hours
- Tokens are stored in browser localStorage
- Logging out clears both the admin token and Zerodha session
- Backend maintains admin session validation

### 3. Protected Endpoints

The following backend endpoints require admin authentication:
- `GET /login` - Zerodha login redirect
- `POST /api/session` - Zerodha session creation
- `GET /api/quotes` - Price snapshots
- `GET /api/stream` - Live price streaming

### 4. Security Notes

- The public URL shows NO sensitive data by default
- Admin secret should never be shared or committed to git
- Admin token is transmitted via `x-admin-token` header
- For streaming (SSE), token is passed as query parameter (as SSE doesn't support custom headers)
- Consider using environment-specific secrets for production

### 5. Environment Variables

#### Backend (.env)
```env
KITE_API_KEY=your_api_key_here
KITE_API_SECRET=your_api_secret_here
PORT=3001
FRONTEND_URL=https://calspread.online
ADMIN_SECRET=your_secure_secret_key_here
```

#### Frontend (.env) - Optional
```env
VITE_API_BASE_URL=https://your-backend-url.com
```

### 6. Deployment Checklist

- [ ] Set `ADMIN_SECRET` in production backend environment
- [ ] Set `FRONTEND_URL` to your actual public domain
- [ ] Set `VITE_API_BASE_URL` to your backend URL (if different from localhost)
- [ ] Test admin login flow in production
- [ ] Verify public view shows no sensitive data
- [ ] Confirm admin features work after authentication

### 7. Usage Flow

```
Public User Journey:
├─ Visit calspread.online
├─ See F&O stock list (no prices)
└─ See "Admin login required" message

Admin User Journey:
├─ Visit calspread.online/admin/verify
├─ Enter admin secret
├─ Redirected to home with admin features
├─ Connect to Zerodha (optional)
├─ View live prices and data
└─ Logout when done
```

## Troubleshooting

### "Admin authentication required" error
- Verify `ADMIN_SECRET` is set in backend `.env`
- Check browser localStorage for `cal_spread_admin_token`
- Try logging out and logging in again

### Can't see prices after admin login
- Ensure you've also connected to Zerodha (separate step)
- Check browser console for errors
- Verify Zerodha session is active

### Admin token expired
- Tokens expire after 24 hours
- Simply log in again at `/admin/verify`
