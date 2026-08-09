const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const axios = require('axios');
require('dotenv').config();

// ============ CONFIG ============
const app = express();
const PORT = process.env.PORT || 5000;

// Database
const db = new Database(process.env.DB_PATH || './database.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============ DATABASE SCHEMA ============
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    wallet_address TEXT,
    points INTEGER DEFAULT 0,
    role TEXT DEFAULT 'user',
    is_verified INTEGER DEFAULT 0,
    verification_token TEXT,
    refresh_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS point_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS xno_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    points_used INTEGER NOT NULL,
    amount_xno DECIMAL(20,10) NOT NULL,
    wallet_address TEXT NOT NULL,
    tx_hash TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS token_blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TRIGGER IF NOT EXISTS update_users_updated_at
  AFTER UPDATE ON users
  BEGIN
    UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;
`);

// Tạo index an toàn
const createIndex = (sql) => {
  try { db.exec(sql); } catch (e) {}
};
createIndex('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
createIndex('CREATE INDEX IF NOT EXISTS idx_users_verified ON users(is_verified)');
createIndex('CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)');
createIndex('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
createIndex('CREATE INDEX IF NOT EXISTS idx_points_user ON point_transactions(user_id)');
createIndex('CREATE INDEX IF NOT EXISTS idx_xno_user ON xno_transactions(user_id)');
createIndex('CREATE INDEX IF NOT EXISTS idx_blacklist_token ON token_blacklist(token)');

// ============ HELPERS ============
const hashPassword = (password) => bcrypt.hashSync(password, 12);
const verifyPassword = (password, hash) => bcrypt.compareSync(password, hash);

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

const generateRefreshToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

const generateVerificationToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

const sendEmail = async (to, subject, html) => {
  if (!process.env.SMTP_HOST) return console.log('📧 Email not sent (no SMTP config)');

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@duco-rewards.com',
    to,
    subject,
    html
  });
};

// ============ HCAPTCHA VERIFICATION ============
const verifyHCaptcha = async (token) => {
  if (!process.env.HCAPTCHA_SECRET) {
    console.log('⚠️ hCaptcha disabled (no secret key)');
    return true;
  }

  try {
    const params = new URLSearchParams();
    params.append('secret', process.env.HCAPTCHA_SECRET);
    params.append('response', token);

    const response = await axios.post(
      'https://api.hcaptcha.com/siteverify',
      params.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    console.log('🔍 hCaptcha response:', response.data);

    if (response.data.success) {
      return true;
    } else {
      console.error('❌ hCaptcha failed:', response.data['error-codes'] || 'Unknown error');
      return false;
    }
  } catch (error) {
    console.error('❌ hCaptcha error:', error.message);
    return false;
  }
};

// ============ MIDDLEWARE ============
app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

app.use(compression());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare('SELECT id, username, email, role, points, is_verified, wallet_address FROM users WHERE id = ?').get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const admin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ============ API ROUTES ============

// -------- AUTH --------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, walletAddress, hcaptchaToken } = req.body;

    if (process.env.HCAPTCHA_SECRET) {
      const isValid = await verifyHCaptcha(hcaptchaToken);
      if (!isValid) {
        return res.status(400).json({ error: 'hCaptcha verification failed' });
      }
    }

    if (!username || username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
    if (existing) {
      return res.status(400).json({ error: 'Email or username already registered' });
    }

    const verificationToken = generateVerificationToken();
    const passwordHash = hashPassword(password);

    const stmt = db.prepare(`
      INSERT INTO users (username, email, password_hash, wallet_address, verification_token)
      VALUES (?, ?, ?, ?, ?)
    `);
    const info = stmt.run(username, email, passwordHash, walletAddress || null, verificationToken);

    // Nếu có SMTP, gửi email. Nếu không, auto verify (dev mode)
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/api/auth/verify/${verificationToken}`;
      await sendEmail(email, 'Verify your email',
        `<h1>Welcome to Duco Rewards!</h1>
         <p>Click <a href="${verifyUrl}">here</a> to verify your email.</p>
         <p>Or copy this link: ${verifyUrl}</p>`
      );
      console.log(`📧 Verification email sent to ${email}`);
    } else {
      // Auto verify cho development
      db.prepare('UPDATE users SET is_verified = 1 WHERE id = ?').run(info.lastInsertRowid);
      console.log(`✅ Auto-verified (dev mode) for ${email}`);
    }

    res.status(201).json({
      message: 'Registration successful! Please verify your email.',
      userId: info.lastInsertRowid
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, hcaptchaToken } = req.body;

    if (process.env.HCAPTCHA_SECRET) {
      const isValid = await verifyHCaptcha(hcaptchaToken);
      if (!isValid) {
        return res.status(400).json({ error: 'hCaptcha verification failed' });
      }
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.is_verified) {
      return res.status(403).json({ error: 'Please verify your email first' });
    }

    const token = generateToken(user.id);
    const refreshToken = generateRefreshToken();

    db.prepare('UPDATE users SET refresh_token = ? WHERE id = ?').run(refreshToken, user.id);
    db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime("now", "+7 days"))')
      .run(user.id, refreshToken);

    res.json({
      accessToken: token,
      refreshToken: refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        points: user.points,
        role: user.role,
        isVerified: user.is_verified,
        walletAddress: user.wallet_address
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/refresh', (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    const session = db.prepare(`
      SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')
    `).get(refreshToken);

    if (!session) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    const newToken = generateToken(user.id);

    res.json({ accessToken: newToken });
  } catch (error) {
    res.status(500).json({ error: 'Refresh failed' });
  }
});

app.post('/api/auth/logout', auth, (req, res) => {
  try {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    db.prepare('UPDATE users SET refresh_token = NULL WHERE id = ?').run(req.user.id);
    res.json({ message: 'Logged out' });
  } catch (error) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ====== VERIFY EMAIL - FIXED WITH HTML ======
app.get('/api/auth/verify/:token', (req, res) => {
  try {
    const result = db.prepare(`
      UPDATE users SET is_verified = 1, verification_token = NULL
      WHERE verification_token = ?
    `).run(req.params.token);

    if (result.changes === 0) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta http-equiv="refresh" content="3;url=/">
          <title>Verification Failed</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%);
              padding: 20px;
            }
            .card {
              background: white;
              border-radius: 24px;
              padding: 48px 40px;
              max-width: 480px;
              width: 100%;
              text-align: center;
              box-shadow: 0 20px 60px rgba(0,0,0,0.1);
            }
            .icon { font-size: 64px; margin-bottom: 16px; }
            h1 { color: #dc2626; font-size: 28px; margin-bottom: 12px; }
            p { color: #6b7280; font-size: 16px; line-height: 1.6; margin-bottom: 8px; }
            .redirect { color: #9ca3af; font-size: 14px; margin-top: 16px; }
            .btn {
              display: inline-block;
              margin-top: 20px;
              padding: 12px 32px;
              background: #dc2626;
              color: white;
              text-decoration: none;
              border-radius: 12px;
              font-weight: 600;
              transition: background 0.2s;
            }
            .btn:hover { background: #b91c1c; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">❌</div>
            <h1>Verification Failed</h1>
            <p>Invalid or expired verification link.</p>
            <p>Please try registering again.</p>
            <a href="/" class="btn">Go to Home</a>
            <div class="redirect">Redirecting in 3 seconds...</div>
          </div>
        </body>
        </html>
      `);
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="3;url=/">
        <title>Email Verified!</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
            padding: 20px;
          }
          .card {
            background: white;
            border-radius: 24px;
            padding: 48px 40px;
            max-width: 480px;
            width: 100%;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.1);
            animation: fadeIn 0.5s ease-out;
          }
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .checkmark {
            display: inline-block;
            width: 80px;
            height: 80px;
            background: #22c55e;
            border-radius: 50%;
            line-height: 80px;
            font-size: 48px;
            color: white;
            margin-bottom: 16px;
          }
          h1 { color: #16a34a; font-size: 28px; margin-bottom: 12px; }
          p { color: #6b7280; font-size: 16px; line-height: 1.6; margin-bottom: 8px; }
          .success-text { color: #22c55e; font-weight: 600; }
          .redirect {
            color: #9ca3af;
            font-size: 14px;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid #e5e7eb;
          }
          .btn {
            display: inline-block;
            margin-top: 16px;
            padding: 12px 32px;
            background: #22c55e;
            color: white;
            text-decoration: none;
            border-radius: 12px;
            font-weight: 600;
            transition: background 0.2s;
          }
          .btn:hover { background: #16a34a; }
          .loader {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid #e5e7eb;
            border-top: 3px solid #22c55e;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            vertical-align: middle;
            margin-left: 8px;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="checkmark">✓</div>
          <h1>✅ Email Verified!</h1>
          <p>Your account has been <span class="success-text">successfully verified</span>.</p>
          <p>You can now log in and start earning points!</p>
          <a href="/" class="btn">Go to Home</a>
          <div class="redirect">
            Redirecting to home page <span class="loader"></span>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="3;url=/">
        <title>Error</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%);
            padding: 20px;
          }
          .card {
            background: white;
            border-radius: 24px;
            padding: 48px 40px;
            max-width: 480px;
            width: 100%;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.1);
          }
          .icon { font-size: 64px; margin-bottom: 16px; }
          h1 { color: #dc2626; font-size: 28px; margin-bottom: 12px; }
          p { color: #6b7280; font-size: 16px; line-height: 1.6; }
          .redirect { color: #9ca3af; font-size: 14px; margin-top: 16px; }
          .btn {
            display: inline-block;
            margin-top: 20px;
            padding: 12px 32px;
            background: #dc2626;
            color: white;
            text-decoration: none;
            border-radius: 12px;
            font-weight: 600;
          }
          .btn:hover { background: #b91c1c; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">⚠️</div>
          <h1>Verification Error</h1>
          <p>Something went wrong. Please try again.</p>
          <a href="/" class="btn">Go to Home</a>
          <div class="redirect">Redirecting in 3 seconds...</div>
        </div>
      </body>
      </html>
    `);
  }
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ user: req.user });
});

// -------- POINTS --------
app.get('/api/points', auth, (req, res) => {
  try {
    const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
    const stats = db.prepare(`
      SELECT
        COUNT(CASE WHEN type = 'watch_ad' THEN 1 END) as total_watched,
        SUM(CASE WHEN type = 'watch_ad' THEN amount ELSE 0 END) as total_earned,
        SUM(CASE WHEN type = 'redeem' THEN amount ELSE 0 END) as total_spent
      FROM point_transactions WHERE user_id = ?
    `).get(req.user.id);

    const today = db.prepare(`
      SELECT SUM(amount) as today_points FROM point_transactions
      WHERE user_id = ? AND type = 'watch_ad' AND date(created_at) = date('now')
    `).get(req.user.id);

    res.json({
      points: user.points,
      stats: {
        totalWatched: stats.total_watched || 0,
        totalEarned: stats.total_earned || 0,
        totalSpent: stats.total_spent || 0,
        dailyLimit: 100,
        dailyUsed: today.today_points || 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get points' });
  }
});

app.post('/api/points/add', auth, (req, res) => {
  try {
    const { amount = 10, source = 'viewfi' } = req.body;
    const pointsToAdd = Math.min(amount, 10);

    const today = db.prepare(`
      SELECT SUM(amount) as today_points FROM point_transactions
      WHERE user_id = ? AND type = 'watch_ad' AND date(created_at) = date('now')
    `).get(req.user.id);

    if ((today.today_points || 0) + pointsToAdd > 100) {
      return res.status(429).json({ error: 'Daily limit reached (100 points/day)' });
    }

    db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(pointsToAdd, req.user.id);
    db.prepare(`
      INSERT INTO point_transactions (user_id, amount, type, source)
      VALUES (?, ?, 'watch_ad', ?)
    `).run(req.user.id, pointsToAdd, source);

    const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
    res.json({ success: true, pointsAdded: pointsToAdd, newTotal: user.points });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add points' });
  }
});

// -------- REDEEM --------
app.post('/api/redeem', auth, async (req, res) => {
  try {
    const { points, walletAddress } = req.body;
    const pointsToRedeem = parseInt(points) || 50;
    const targetWallet = walletAddress || req.user.wallet_address;

    if (!targetWallet) {
      return res.status(400).json({ error: 'Wallet address required' });
    }
    if (pointsToRedeem < 50) {
      return res.status(400).json({ error: 'Minimum redeem is 50 points' });
    }
    if (pointsToRedeem % 50 !== 0) {
      return res.status(400).json({ error: 'Points must be multiple of 50' });
    }

    const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
    if (user.points < pointsToRedeem) {
      return res.status(400).json({ error: 'Insufficient points' });
    }

    const xnoAmount = (pointsToRedeem / 50) * 0.1;

    db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(pointsToRedeem, req.user.id);

    const stmt = db.prepare(`
      INSERT INTO xno_transactions (user_id, points_used, amount_xno, wallet_address, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);
    const info = stmt.run(req.user.id, pointsToRedeem, xnoAmount, targetWallet);

    db.prepare(`
      INSERT INTO point_transactions (user_id, amount, type)
      VALUES (?, ?, 'redeem')
    `).run(req.user.id, -pointsToRedeem);

    const txHash = `mock_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    db.prepare('UPDATE xno_transactions SET tx_hash = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(txHash, 'completed', info.lastInsertRowid);

    res.json({
      success: true,
      pointsUsed: pointsToRedeem,
      xnoAmount: xnoAmount,
      walletAddress: targetWallet,
      txHash: txHash,
      message: `Successfully redeemed ${pointsToRedeem} points for ${xnoAmount} XNO`
    });
  } catch (error) {
    console.error('Redeem error:', error);
    res.status(500).json({ error: 'Redeem failed' });
  }
});

// -------- ADMIN --------
app.get('/api/admin/stats', auth, admin, (req, res) => {
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
    const totalPoints = db.prepare('SELECT SUM(points) as total FROM users').get();
    const totalXNO = db.prepare('SELECT SUM(amount_xno) as total FROM xno_transactions WHERE status = "completed"').get();
    const totalAds = db.prepare('SELECT COUNT(*) as count FROM point_transactions WHERE type = "watch_ad"').get();

    res.json({
      users: totalUsers.count || 0,
      points: totalPoints.total || 0,
      xno: totalXNO.total || 0,
      ads: totalAds.count || 0
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.get('/api/admin/users', auth, admin, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT id, username, email, points, role, is_verified, created_at
      FROM users ORDER BY created_at DESC LIMIT 100
    `).all();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============ SERVE FRONTEND STATIC FILES ============
app.use(express.static(path.join(__dirname, 'frontend')));

// Fallback: serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 API: http://localhost:${PORT}/api/health`);
  console.log(`🌐 Frontend: http://localhost:${PORT}`);
  console.log(`📁 Database: ${process.env.DB_PATH || './database.db'}\n`);
});
