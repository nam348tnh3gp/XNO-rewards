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
const cookieParser = require('cookie-parser');
require('dotenv').config();

// ============ CONFIG ============
const app = express();
const PORT = process.env.PORT || 5000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';

// ============ GLOBAL ERROR HANDLERS ============
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
    });
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection:', {
        reason: reason,
        promise: promise,
        timestamp: new Date().toISOString()
    });
});

// ============ DATABASE ============
let db;
try {
    db = new Database(process.env.DB_PATH || './database.db');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log('✅ Database connected successfully');
} catch (error) {
    console.error('❌ Database connection failed:', {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
    });
    process.exit(1);
}

// ============ DATABASE SCHEMA ============
try {
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
        referred_by INTEGER REFERENCES users(id),
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
        reference_id TEXT,
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

      CREATE TABLE IF NOT EXISTS email_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        code TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ad_watch_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        ad_id TEXT,
        status TEXT DEFAULT 'started',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        verified_at DATETIME,
        expires_at DATETIME,
        ip_address TEXT,
        user_agent TEXT
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT DEFAULT 'info',
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS notification_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TRIGGER IF NOT EXISTS update_users_updated_at
      AFTER UPDATE ON users
      BEGIN
        UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS update_config_updated_at
      AFTER UPDATE ON config
      BEGIN
        UPDATE config SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
      END;
    `);
    console.log('✅ Database schema created successfully');
} catch (error) {
    console.error('❌ Database schema creation failed:', {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
    });
    process.exit(1);
}

// ============ FIX: Thêm cột nếu chưa có ============
try {
    db.exec('ALTER TABLE point_transactions ADD COLUMN reference_id TEXT');
    console.log('✅ Added reference_id column to point_transactions');
} catch (e) { /* already exists */ }

try {
    db.exec('ALTER TABLE ad_watch_history ADD COLUMN expires_at DATETIME');
    console.log('✅ Added expires_at column to ad_watch_history');
} catch (e) {}

try {
    db.exec('ALTER TABLE users ADD COLUMN referred_by INTEGER REFERENCES users(id)');
    console.log('✅ Added referred_by column to users');
} catch (e) {}

// ============ TẠO INDEX ============
const createIndex = (sql) => {
    try {
        db.exec(sql);
    } catch (e) {}
};
createIndex('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
createIndex('CREATE INDEX IF NOT EXISTS idx_users_verified ON users(is_verified)');
createIndex('CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)');
createIndex('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
createIndex('CREATE INDEX IF NOT EXISTS idx_points_user ON point_transactions(user_id)');
createIndex('CREATE INDEX IF NOT EXISTS idx_xno_user ON xno_transactions(user_id)');
createIndex('CREATE INDEX IF NOT EXISTS idx_blacklist_token ON token_blacklist(token)');
createIndex('CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email)');
createIndex('CREATE INDEX IF NOT EXISTS idx_ad_watch_user ON ad_watch_history(user_id)');
createIndex('CREATE INDEX IF NOT EXISTS idx_ad_watch_session ON ad_watch_history(session_id)');
createIndex('CREATE INDEX IF NOT EXISTS idx_ad_watch_status ON ad_watch_history(status)');
createIndex('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)');
createIndex('CREATE INDEX IF NOT EXISTS idx_tokens_user ON notification_tokens(user_id)');
createIndex('CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token)');
console.log('✅ Database indexes created');

// ============ CONFIG HELPER ============
const DEFAULT_CONFIG = {
    points_per_ad: '10',
    points_per_xno: '500',
    daily_limit: '100',
    min_redeem_points: '50',
    streak_bonus_multiplier: '2',
    referral_bonus: '5'
};

function getConfigValue(key) {
    try {
        const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
        if (row) return row.value;
        const defaultValue = DEFAULT_CONFIG[key];
        if (defaultValue !== undefined) {
            db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)').run(key, defaultValue);
            return defaultValue;
        }
        return null;
    } catch (error) {
        console.error('❌ getConfigValue error:', error.message);
        return DEFAULT_CONFIG[key] || null;
    }
}

function setConfigValue(key, value) {
    try {
        const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
        stmt.run(key, String(value));
        console.log(`✅ Config updated: ${key} = ${value}`);
        return true;
    } catch (error) {
        console.error('❌ setConfigValue error:', error.message);
        return false;
    }
}

// Khởi tạo config mặc định
Object.keys(DEFAULT_CONFIG).forEach(key => {
    const existing = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    if (!existing) {
        setConfigValue(key, DEFAULT_CONFIG[key]);
    }
});

function getAllConfig() {
    try {
        const rows = db.prepare('SELECT key, value FROM config').all();
        const config = {};
        rows.forEach(row => { config[row.key] = row.value; });
        Object.keys(DEFAULT_CONFIG).forEach(key => {
            if (!(key in config)) {
                config[key] = DEFAULT_CONFIG[key];
            }
        });
        return config;
    } catch (error) {
        console.error('❌ getAllConfig error:', error.message);
        return DEFAULT_CONFIG;
    }
}

// ============ SERVER-SIDE CONFIG CACHE ============
let configCache = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 60 * 1000; // 1 phút

// ============ SSE CLIENTS & BROADCAST ============
const sseClients = [];

function broadcastConfigUpdate(config) {
    const data = JSON.stringify({ event: 'config-updated', config });
    sseClients.forEach((res, index) => {
        try {
            res.write(`data: ${data}\n\n`);
        } catch (err) {
            sseClients.splice(index, 1);
        }
    });
}

// ============ HELPERS ============
const hashPassword = (password) => {
    try {
        return bcrypt.hashSync(password, 12);
    } catch (error) {
        console.error('❌ Password hashing failed:', error.message);
        throw new Error('Password hashing failed');
    }
};

const verifyPassword = (password, hash) => {
    try {
        return bcrypt.compareSync(password, hash);
    } catch (error) {
        console.error('❌ Password verification failed:', error.message);
        return false;
    }
};

const generateToken = (userId) => {
    try {
        return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
    } catch (error) {
        console.error('❌ Token generation failed:', error.message);
        throw new Error('Token generation failed');
    }
};

const generateRefreshToken = () => {
    try {
        return crypto.randomBytes(32).toString('hex');
    } catch (error) {
        console.error('❌ Refresh token generation failed:', error.message);
        throw new Error('Refresh token generation failed');
    }
};

const generateOTP = () => {
    try {
        return Math.floor(1000 + Math.random() * 9000).toString();
    } catch (error) {
        console.error('❌ OTP generation failed:', error.message);
        return '0000';
    }
};

const saveOTP = (email, code) => {
    try {
        db.prepare('DELETE FROM email_verifications WHERE email = ?').run(email);
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        db.prepare(`
            INSERT INTO email_verifications (email, code, expires_at)
            VALUES (?, ?, ?)
        `).run(email, code, expiresAt);
        return true;
    } catch (error) {
        console.error('❌ Save OTP failed:', { email, error: error.message });
        throw new Error('Failed to save verification code');
    }
};

const verifyOTP = (email, code) => {
    try {
        const now = new Date().toISOString();
        const result = db.prepare(`
            SELECT * FROM email_verifications
            WHERE email = ? AND code = ? AND expires_at > ?
        `).get(email, code, now);

        if (result) {
            db.prepare('DELETE FROM email_verifications WHERE email = ?').run(email);
            return true;
        }
        return false;
    } catch (error) {
        console.error('❌ OTP verification failed:', { email, error: error.message });
        return false;
    }
};

const sendEmail = async (to, subject, html) => {
    if (!process.env.SMTP_HOST) {
        console.log('⚠️ Email not sent (no SMTP config)');
        return { success: false, message: 'SMTP not configured' };
    }

    try {
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT),
            secure: false,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            },
            debug: process.env.NODE_ENV === 'development',
            logger: process.env.NODE_ENV === 'development'
        });

        await transporter.verify();

        const info = await transporter.sendMail({
            from: process.env.EMAIL_FROM || 'noreply@xno-rewards.com',
            to,
            subject,
            html
        });

        console.log('📧 Email sent:', { to, subject, messageId: info.messageId });
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('❌ Email send failed:', {
            to,
            subject,
            error: error.message,
            stack: error.stack
        });
        return { success: false, message: error.message };
    }
};

// ============ HCAPTCHA VERIFICATION ============
const verifyHCaptcha = async (token) => {
    if (!process.env.HCAPTCHA_SECRET) {
        console.log('⚠️ hCaptcha disabled (no secret key)');
        return true;
    }

    if (!token) {
        console.log('⚠️ hCaptcha token missing');
        return false;
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
                },
                timeout: 10000
            }
        );

        console.log('🔍 hCaptcha response:', {
            success: response.data.success,
            challenge_ts: response.data.challenge_ts,
            hostname: response.data.hostname
        });

        if (response.data.success) {
            return true;
        } else {
            console.error('❌ hCaptcha failed:', {
                errorCodes: response.data['error-codes'] || 'Unknown error'
            });
            return false;
        }
    } catch (error) {
        console.error('❌ hCaptcha error:', {
            message: error.message,
            code: error.code,
            stack: error.stack
        });
        return false;
    }
};

// ============ MIDDLEWARE ============
app.set('trust proxy', true);

app.use((req, res, next) => {
    if (req.url.length > 2048) {
        return res.status(414).json({ error: 'URI too long' });
    }
    next();
});

app.use(cookieParser());

app.use(helmet({
    contentSecurityPolicy: false
}));

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

app.use((req, res, next) => {
    console.log(`📨 ${req.method} ${req.url} - ${req.ip} - ${req.get('origin') || 'same-origin'}`);
    next();
});

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: {
        trustProxy: false,
        xForwardedForHeader: false
    }
});
app.use('/api', limiter);

const auth = (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = db.prepare('SELECT id, username, email, role, points, is_verified, wallet_address, referred_by FROM users WHERE id = ?').get(decoded.userId);

        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        req.user = user;
        req.token = token;
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Invalid token' });
        }
        console.error('❌ Auth error:', error.message);
        return res.status(500).json({ error: 'Authentication failed' });
    }
};

const admin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

const adminAuthWeb = (req, res, next) => {
    const token = req.cookies?.adminToken;
    if (!token) {
        return res.redirect('/admin/login');
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = db.prepare('SELECT id, username, email, role, points, is_verified, wallet_address, referred_by FROM users WHERE id = ?').get(decoded.userId);
        if (!user || user.role !== 'admin') {
            return res.redirect('/admin/login');
        }
        req.user = user;
        req.token = token;
        next();
    } catch (error) {
        return res.redirect('/admin/login');
    }
};

// ============ API ROUTES ============

// ----- CONFIG (có cache server) -----
app.get('/api/config', (req, res) => {
    const now = Date.now();
    if (configCache && (now - configCacheTime) < CONFIG_CACHE_TTL) {
        return res.json(configCache);
    }

    const config = getAllConfig();
    configCache = {
        ...config,
        hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY || '5aa632cc-e278-444e-90aa-59aa63e00a36',
        adminEmail: ADMIN_EMAIL
    };
    configCacheTime = now;
    res.json(configCache);
});

// ============ SSE STREAM ============
app.get('/api/config/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    const config = getAllConfig();
    res.write(`data: ${JSON.stringify({ event: 'config-updated', config })}\n\n`);

    sseClients.push(res);

    req.on('close', () => {
        const index = sseClients.indexOf(res);
        if (index > -1) sseClients.splice(index, 1);
    });
});

app.put('/api/admin/config', auth, admin, (req, res) => {
    try {
        const { key, value } = req.body;
        if (!key || value === undefined) {
            return res.status(400).json({ error: 'key and value are required' });
        }
        const allowedKeys = Object.keys(DEFAULT_CONFIG);
        if (!allowedKeys.includes(key)) {
            return res.status(400).json({ error: 'Invalid config key' });
        }
        const numericValue = parseFloat(value);
        if (isNaN(numericValue) || numericValue <= 0) {
            return res.status(400).json({ error: 'Value must be a positive number' });
        }
        if (setConfigValue(key, numericValue)) {
            const newConfig = getAllConfig();
            configCache = null;
            configCacheTime = 0;
            broadcastConfigUpdate(newConfig);
            res.json({ 
                success: true, 
                message: `Config ${key} updated to ${numericValue}`,
                config: newConfig
            });
        } else {
            res.status(500).json({ error: 'Failed to update config' });
        }
    } catch (error) {
        console.error('❌ Update config error:', error.message);
        res.status(500).json({ error: 'Failed to update config' });
    }
});

// -------- AUTH --------
app.post('/api/auth/send-otp', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email is required' });
        }

        try {
            const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
            if (existing) {
                return res.status(400).json({ error: 'Email already registered' });
            }
        } catch (error) {
            console.error('❌ Database error:', error.message);
            return res.status(500).json({ error: 'Database error' });
        }

        const code = generateOTP();
        saveOTP(email, code);

        if (process.env.SMTP_HOST) {
            const emailResult = await sendEmail(email, 'Your Verification Code',
                `<h1>XNO Rewards</h1>
                 <p>Your verification code is:</p>
                 <h2 style="font-size: 32px; color: #0A84FF; letter-spacing: 4px; padding: 12px; background: #f0f7ff; border-radius: 8px;">${code}</h2>
                 <p>This code will expire in 5 minutes.</p>
                 <p>If you didn't request this, please ignore this email.</p>`
            );

            if (!emailResult.success) {
                console.error('❌ Failed to send email:', emailResult.message);
            }
        } else {
            console.log(`⚠️ No SMTP configured. OTP for ${email}: ${code}`);
            return res.json({
                message: 'OTP sent (dev mode)',
                devCode: code
            });
        }

        res.json({ message: 'Verification code sent to your email' });
    } catch (error) {
        console.error('❌ Send OTP error:', {
            message: error.message,
            stack: error.stack
        });
        res.status(500).json({ error: 'Failed to send verification code' });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password, walletAddress, hcaptchaToken, otpCode, refCode } = req.body;

        if (!username || username.length < 3) {
            return res.status(400).json({ error: 'Username must be at least 3 characters' });
        }
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email is required' });
        }
        if (!password || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        if (!otpCode || otpCode.length !== 4) {
            return res.status(400).json({ error: 'Please enter 4-digit verification code' });
        }

        if (process.env.HCAPTCHA_SECRET) {
            const isValid = await verifyHCaptcha(hcaptchaToken);
            if (!isValid) {
                return res.status(400).json({ error: 'hCaptcha verification failed' });
            }
        }

        const isValidOTP = verifyOTP(email, otpCode);
        if (!isValidOTP) {
            return res.status(400).json({ error: 'Invalid or expired verification code' });
        }

        try {
            const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
            if (existing) {
                return res.status(400).json({ error: 'Email or username already registered' });
            }
        } catch (error) {
            console.error('❌ Database error:', error.message);
            return res.status(500).json({ error: 'Database error' });
        }

        const passwordHash = hashPassword(password);
        
        const isAdmin = email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
        const role = isAdmin ? 'admin' : 'user';
        
        if (isAdmin) {
            console.log(`👑 Admin account registration: ${email}`);
        }

        // Xử lý referral
        let referredBy = null;
        if (refCode) {
            const referrer = db.prepare('SELECT id FROM users WHERE username = ?').get(refCode);
            if (referrer) {
                referredBy = referrer.id;
                // Thưởng cho người giới thiệu
                const referralBonus = parseInt(getConfigValue('referral_bonus')) || 5;
                db.prepare('UPDATE users SET points = points + ? WHERE id = ?')
                    .run(referralBonus, referrer.id);
                db.prepare(`
                    INSERT INTO point_transactions (user_id, amount, type, source)
                    VALUES (?, ?, 'referral_bonus', ?)
                `).run(referrer.id, referralBonus, `ref_${username}`);
                // Gửi thông báo
                db.prepare(`
                    INSERT INTO notifications (user_id, title, message, type)
                    VALUES (?, '🎉 Referral Bonus!', 'You earned ${referralBonus} points for referring ${username}', 'success')
                `).run(referrer.id);
            }
        }

        const stmt = db.prepare(`
            INSERT INTO users (username, email, password_hash, wallet_address, is_verified, role, referred_by)
            VALUES (?, ?, ?, ?, 1, ?, ?)
        `);
        const info = stmt.run(username, email, passwordHash, walletAddress || null, role, referredBy);

        db.prepare('DELETE FROM email_verifications WHERE email = ?').run(email);

        const welcomeMessage = isAdmin 
            ? 'Welcome Admin! You have full access to the dashboard.' 
            : 'Start earning points by watching ads.';

        db.prepare(`
            INSERT INTO notifications (user_id, title, message, type)
            VALUES (?, 'Welcome to XNO Rewards! 🎉', ?, 'success')
        `).run(info.lastInsertRowid, welcomeMessage);

        res.status(201).json({
            message: isAdmin 
                ? 'Admin account created successfully! You can now login to admin dashboard.' 
                : 'Registration successful! You can now login.',
            userId: info.lastInsertRowid,
            role: role
        });
    } catch (error) {
        console.error('❌ Register error:', {
            message: error.message,
            stack: error.stack
        });
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password, hcaptchaToken } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        if (process.env.HCAPTCHA_SECRET && hcaptchaToken) {
            const isValid = await verifyHCaptcha(hcaptchaToken);
            if (!isValid) {
                return res.status(400).json({ error: 'hCaptcha verification failed' });
            }
        }

        let user;
        try {
            user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        } catch (error) {
            console.error('❌ Database error:', error.message);
            return res.status(500).json({ error: 'Database error' });
        }

        if (!user || !verifyPassword(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!user.is_verified) {
            return res.status(403).json({ error: 'Please verify your email first' });
        }

        if (user.role === 'banned') {
            return res.status(403).json({ error: 'Your account has been banned' });
        }

        const token = generateToken(user.id);
        const refreshToken = generateRefreshToken();

        try {
            db.prepare('UPDATE users SET refresh_token = ? WHERE id = ?').run(refreshToken, user.id);

            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)')
                .run(user.id, refreshToken, expiresAt);
        } catch (error) {
            console.error('❌ Session error:', error.message);
            return res.status(500).json({ error: 'Session creation failed' });
        }

        db.prepare('UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

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
        console.error('❌ Login error:', {
            message: error.message,
            stack: error.stack
        });
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/auth/refresh', (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(400).json({ error: 'Refresh token required' });
        }

        const now = new Date().toISOString();
        let session;
        try {
            session = db.prepare(`
                SELECT * FROM sessions WHERE token = ? AND expires_at > ?
            `).get(refreshToken, now);
        } catch (error) {
            console.error('❌ Database error:', error.message);
            return res.status(500).json({ error: 'Database error' });
        }

        if (!session) {
            return res.status(401).json({ error: 'Invalid or expired refresh token' });
        }

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
        const newToken = generateToken(user.id);

        res.json({ accessToken: newToken });
    } catch (error) {
        console.error('❌ Refresh error:', error.message);
        res.status(500).json({ error: 'Refresh failed' });
    }
});

app.post('/api/auth/logout', auth, (req, res) => {
    try {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
        db.prepare('UPDATE users SET refresh_token = NULL WHERE id = ?').run(req.user.id);
        res.json({ message: 'Logged out' });
    } catch (error) {
        console.error('❌ Logout error:', error.message);
        res.status(500).json({ error: 'Logout failed' });
    }
});

app.get('/api/auth/me', auth, (req, res) => {
    res.json({ user: req.user });
});

// ============ FORGOT / RESET PASSWORD ============
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });

        const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (!user) {
            return res.status(404).json({ error: 'Email not found' });
        }

        db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        db.prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)')
            .run(user.id, token, expiresAt);

        const resetLink = `${req.protocol}://${req.get('host')}/reset-password/${token}`;

        if (process.env.SMTP_HOST) {
            await sendEmail(email, 'Reset Your Password',
                `<h1>Password Reset</h1>
                 <p>Click the link below to reset your password (expires in 15 minutes):</p>
                 <p><a href="${resetLink}">${resetLink}</a></p>
                 <p>If you didn't request this, please ignore this email.</p>`
            );
        } else {
            console.log(`🔑 Reset link: ${resetLink}`);
            return res.json({
                message: 'Reset link generated (dev mode)',
                devLink: resetLink
            });
        }

        res.json({ message: 'Password reset link sent to your email' });
    } catch (error) {
        console.error('❌ Forgot password error:', error);
        res.status(500).json({ error: 'Failed to process request' });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token) return res.status(400).json({ error: 'Token required' });
        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const now = new Date().toISOString();
        const reset = db.prepare(`
            SELECT user_id FROM password_resets
            WHERE token = ? AND expires_at > ?
        `).get(token, now);

        if (!reset) {
            return res.status(400).json({ error: 'Invalid or expired token' });
        }

        const hashed = hashPassword(newPassword);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashed, reset.user_id);
        db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);

        res.json({ message: 'Password reset successfully' });
    } catch (error) {
        console.error('❌ Reset password error:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
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

        const dailyLimit = parseInt(getConfigValue('daily_limit')) || 100;

        res.json({
            points: user.points,
            stats: {
                totalWatched: stats.total_watched || 0,
                totalEarned: stats.total_earned || 0,
                totalSpent: stats.total_spent || 0,
                dailyLimit: dailyLimit,
                dailyUsed: today.today_points || 0
            }
        });
    } catch (error) {
        console.error('❌ Points error:', error.message);
        res.status(500).json({ error: 'Failed to get points' });
    }
});

// -------- AD VERIFICATION --------
app.post('/api/ad/start', auth, (req, res) => {
    try {
        const now = new Date().toISOString();
        db.prepare('DELETE FROM ad_watch_history WHERE expires_at < ?').run(now);

        const sessionId = crypto.randomBytes(16).toString('hex');
        const userAgent = req.headers['user-agent'] || 'unknown';
        const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

        const stmt = db.prepare(`
            INSERT INTO ad_watch_history (user_id, session_id, status, ip_address, user_agent, expires_at)
            VALUES (?, ?, 'started', ?, ?, ?)
        `);
        const info = stmt.run(req.user.id, sessionId, ipAddress, userAgent, expiresAt);

        res.json({
            success: true,
            sessionId: sessionId,
            recordId: info.lastInsertRowid
        });
    } catch (error) {
        console.error('❌ Ad start error:', {
            message: error.message,
            stack: error.stack,
            userId: req.user.id
        });
        res.status(500).json({ error: 'Failed to start ad session' });
    }
});

app.post('/api/ad/verify', auth, (req, res) => {
    try {
        const { sessionId, watchDuration, adId } = req.body;

        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID required' });
        }

        let session;
        try {
            const now = new Date().toISOString();
            session = db.prepare(`
                SELECT * FROM ad_watch_history
                WHERE session_id = ? AND user_id = ? AND status = 'started' AND expires_at > ?
            `).get(sessionId, req.user.id, now);
        } catch (error) {
            console.error('❌ Database error:', error.message);
            return res.status(500).json({ error: 'Database error' });
        }

        if (!session) {
            return res.status(400).json({ error: 'Invalid or expired session' });
        }

        const minDuration = 15000;
        if (!watchDuration || watchDuration < minDuration) {
            try {
                db.prepare(`
                    UPDATE ad_watch_history
                    SET status = 'suspicious', completed_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(session.id);
            } catch (error) {
                console.error('❌ Update error:', error.message);
            }
            return res.status(400).json({ error: 'Watch duration too short' });
        }

        const maxDuration = 120000;
        if (watchDuration > maxDuration) {
            try {
                db.prepare(`
                    UPDATE ad_watch_history
                    SET status = 'suspicious', completed_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(session.id);
            } catch (error) {
                console.error('❌ Update error:', error.message);
            }
            return res.status(400).json({ error: 'Watch duration too long' });
        }

        let today;
        try {
            today = db.prepare(`
                SELECT SUM(amount) as today_points FROM point_transactions
                WHERE user_id = ? AND type = 'watch_ad' AND date(created_at) = date('now')
            `).get(req.user.id);
        } catch (error) {
            console.error('❌ Database error:', error.message);
            return res.status(500).json({ error: 'Database error' });
        }

        const pointsPerAd = parseInt(getConfigValue('points_per_ad')) || 10;
        const dailyLimit = parseInt(getConfigValue('daily_limit')) || 100;

        if ((today.today_points || 0) + pointsPerAd > dailyLimit) {
            return res.status(429).json({ error: `Daily limit reached (${dailyLimit} points/day)` });
        }

        let existing;
        try {
            existing = db.prepare(`
                SELECT * FROM point_transactions
                WHERE user_id = ? AND reference_id = ? AND type = 'watch_ad'
            `).get(req.user.id, sessionId);
        } catch (error) {
            console.error('❌ Database error:', error.message);
            return res.status(500).json({ error: 'Database error' });
        }

        if (existing) {
            return res.status(400).json({ error: 'Points already claimed for this session' });
        }

        try {
            db.prepare(`
                UPDATE ad_watch_history
                SET status = 'completed', completed_at = CURRENT_TIMESTAMP, verified_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(session.id);
        } catch (error) {
            console.error('❌ Update error:', error.message);
            return res.status(500).json({ error: 'Failed to update session' });
        }

        try {
            db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(pointsPerAd, req.user.id);

            db.prepare(`
                INSERT INTO point_transactions (user_id, amount, type, source, reference_id)
                VALUES (?, ?, 'watch_ad', 'aads', ?)
            `).run(req.user.id, pointsPerAd, sessionId);

            console.log(`✅ ${pointsPerAd} points added successfully for user:`, req.user.id);
        } catch (error) {
            console.error('❌ Points update error:', {
                message: error.message,
                stack: error.stack,
                userId: req.user.id
            });
            return res.status(500).json({ error: 'Failed to add points' });
        }

        const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);

        res.json({
            success: true,
            pointsAdded: pointsPerAd,
            newTotal: user.points,
            verified: true
        });

    } catch (error) {
        console.error('❌ Ad verify error:', {
            message: error.message,
            stack: error.stack,
            userId: req.user.id
        });
        res.status(500).json({ error: 'Failed to verify ad watch' });
    }
});

// -------- REDEEM --------
app.post('/api/redeem', auth, async (req, res) => {
    try {
        const { points, walletAddress } = req.body;
        const pointsToRedeem = parseInt(points) || 0;
        const targetWallet = walletAddress || req.user.wallet_address;

        if (!targetWallet) {
            return res.status(400).json({ error: 'Wallet address required' });
        }

        const pointsPerXNO = parseFloat(getConfigValue('points_per_xno')) || 500;
        const minRedeemPoints = parseInt(getConfigValue('min_redeem_points')) || 50;

        if (pointsToRedeem < minRedeemPoints) {
            return res.status(400).json({ 
                error: `Minimum redeem is ${minRedeemPoints} points (${(minRedeemPoints / pointsPerXNO).toFixed(6)} XNO)` 
            });
        }

        const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
        if (user.points < pointsToRedeem) {
            return res.status(400).json({ error: 'Insufficient points' });
        }

        const xnoAmount = pointsToRedeem / pointsPerXNO;

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

        db.prepare(`
            INSERT INTO notifications (user_id, title, message, type)
            VALUES (?, 'Redeem Successful! 🎉', 'You redeemed ${pointsToRedeem} points for ${xnoAmount.toFixed(6)} XNO', 'success')
        `).run(req.user.id);

        res.json({
            success: true,
            pointsUsed: pointsToRedeem,
            xnoAmount: xnoAmount,
            walletAddress: targetWallet,
            txHash: txHash,
            message: `Successfully redeemed ${pointsToRedeem} points for ${xnoAmount.toFixed(6)} XNO`
        });
    } catch (error) {
        console.error('❌ Redeem error:', {
            message: error.message,
            stack: error.stack,
            userId: req.user.id
        });
        res.status(500).json({ error: 'Redeem failed' });
    }
});

// -------- USER PROFILE (PUT) --------
app.get('/api/user/profile', auth, (req, res) => {
    try {
        const user = db.prepare(`
            SELECT id, username, email, wallet_address, points, role, is_verified, created_at
            FROM users WHERE id = ?
        `).get(req.user.id);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({ user });
    } catch (error) {
        console.error('❌ Profile error:', error.message);
        res.status(500).json({ error: 'Failed to get profile' });
    }
});

app.put('/api/user/profile', auth, (req, res) => {
    try {
        const { username, walletAddress } = req.body;
        const updates = [];
        const params = [];
        
        if (username) {
            const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
            if (existing) {
                return res.status(400).json({ error: 'Username already taken' });
            }
            updates.push('username = ?');
            params.push(username);
        }
        
        if (walletAddress !== undefined) {
            updates.push('wallet_address = ?');
            params.push(walletAddress);
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        
        params.push(req.user.id);
        db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        
        const user = db.prepare('SELECT id, username, email, wallet_address, points, role, is_verified FROM users WHERE id = ?').get(req.user.id);
        res.json({ success: true, user });
    } catch (error) {
        console.error('❌ Update profile error:', error.message);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// -------- TRANSACTIONS --------
app.get('/api/transactions', auth, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        
        const pointTx = db.prepare(`
            SELECT amount, type, source, created_at 
            FROM point_transactions 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `).all(req.user.id, limit, offset);
        
        const xnoTx = db.prepare(`
            SELECT points_used, amount_xno, wallet_address, status, created_at 
            FROM xno_transactions 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `).all(req.user.id, limit, offset);
        
        const totalPoints = db.prepare('SELECT COUNT(*) as count FROM point_transactions WHERE user_id = ?').get(req.user.id);
        const totalXno = db.prepare('SELECT COUNT(*) as count FROM xno_transactions WHERE user_id = ?').get(req.user.id);
        
        res.json({
            points: pointTx,
            xno: xnoTx,
            totals: {
                points: totalPoints.count || 0,
                xno: totalXno.count || 0
            }
        });
    } catch (error) {
        console.error('❌ Transactions error:', error.message);
        res.status(500).json({ error: 'Failed to get transactions' });
    }
});

// -------- REFERRAL --------
app.get('/api/referral/stats', auth, (req, res) => {
    try {
        const count = db.prepare(`
            SELECT COUNT(*) as count FROM users WHERE referred_by = ?
        `).get(req.user.id);
        
        const bonus = db.prepare(`
            SELECT SUM(amount) as total FROM point_transactions 
            WHERE user_id = ? AND type = 'referral_bonus'
        `).get(req.user.id);
        
        const referralCode = `${req.user.username}-${req.user.id.toString().padStart(4, '0')}`;
        
        res.json({
            referralCode,
            totalReferrals: count.count || 0,
            bonusPoints: bonus.total || 0
        });
    } catch (error) {
        console.error('❌ Referral stats error:', error.message);
        res.status(500).json({ error: 'Failed to get referral stats' });
    }
});

app.post('/api/referral/claim', auth, (req, res) => {
    try {
        const { referralCode } = req.body;
        if (!referralCode) {
            return res.status(400).json({ error: 'Referral code required' });
        }
        
        const referred = db.prepare('SELECT id, points FROM users WHERE username = ?').get(referralCode.split('-')[0]);
        if (!referred) {
            return res.status(404).json({ error: 'Invalid referral code' });
        }
        
        if (referred.id === req.user.id) {
            return res.status(400).json({ error: 'Cannot refer yourself' });
        }
        
        const existing = db.prepare(`
            SELECT * FROM point_transactions 
            WHERE user_id = ? AND type = 'referral_bonus' AND source = ?
        `).get(req.user.id, referralCode);
        
        if (existing) {
            return res.status(400).json({ error: 'Already claimed this referral' });
        }
        
        const referralBonus = parseInt(getConfigValue('referral_bonus')) || 5;
        
        db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(referralBonus, req.user.id);
        db.prepare(`
            INSERT INTO point_transactions (user_id, amount, type, source)
            VALUES (?, ?, 'referral_bonus', ?)
        `).run(req.user.id, referralBonus, referralCode);
        
        const user = db.prepare('SELECT referred_by FROM users WHERE id = ?').get(referred.id);
        if (!user.referred_by) {
            db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(req.user.id, referred.id);
        }
        
        const newPoints = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
        res.json({
            success: true,
            bonus: referralBonus,
            newTotal: newPoints.points,
            message: `🎉 Referral bonus claimed! +${referralBonus} points`
        });
    } catch (error) {
        console.error('❌ Claim referral error:', error.message);
        res.status(500).json({ error: 'Failed to claim referral' });
    }
});

// -------- LEADERBOARD --------
app.get('/api/leaderboard', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const topUsers = db.prepare(`
            SELECT username, points, 
                   (SELECT COUNT(*) FROM users u2 WHERE u2.points > u1.points) + 1 as rank
            FROM users u1
            WHERE points > 0
            ORDER BY points DESC
            LIMIT ?
        `).all(limit);
        
        res.json({ leaderboard: topUsers });
    } catch (error) {
        console.error('❌ Leaderboard error:', error.message);
        res.status(500).json({ error: 'Failed to get leaderboard' });
    }
});

// -------- DAILY BONUS --------
app.post('/api/daily-bonus', auth, (req, res) => {
    try {
        const today = db.prepare(`
            SELECT * FROM point_transactions 
            WHERE user_id = ? AND type = 'daily_bonus' AND date(created_at) = date('now')
        `).get(req.user.id);
        
        if (today) {
            return res.status(400).json({ error: 'Daily bonus already claimed' });
        }
        
        const yesterday = db.prepare(`
            SELECT * FROM point_transactions 
            WHERE user_id = ? AND type = 'daily_bonus' AND date(created_at) = date('now', '-1 day')
        `).get(req.user.id);
        
        const streakMultiplier = parseInt(getConfigValue('streak_bonus_multiplier')) || 2;
        let bonus = 5;
        let streak = 0;
        
        if (yesterday) {
            const streakData = db.prepare(`
                SELECT COUNT(*) as streak FROM point_transactions 
                WHERE user_id = ? AND type = 'daily_bonus' 
                AND date(created_at) >= date('now', '-30 day')
            `).get(req.user.id);
            streak = (streakData.streak || 0) + 1;
            bonus = Math.min(5 + streak * streakMultiplier, 50);
        }
        
        db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(bonus, req.user.id);
        db.prepare(`
            INSERT INTO point_transactions (user_id, amount, type, source)
            VALUES (?, ?, 'daily_bonus', ?)
        `).run(req.user.id, bonus, `day_${streak}`);
        
        const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
        res.json({
            success: true,
            bonus: bonus,
            streak: streak,
            newTotal: user.points,
            message: `🎁 Daily bonus: +${bonus} points (${streak} day streak!)`
        });
    } catch (error) {
        console.error('❌ Daily bonus error:', error.message);
        res.status(500).json({ error: 'Failed to claim daily bonus' });
    }
});

app.get('/api/streak', auth, (req, res) => {
    try {
        const streakData = db.prepare(`
            SELECT COUNT(*) as streak FROM point_transactions 
            WHERE user_id = ? AND type = 'daily_bonus' 
            AND date(created_at) >= date('now', '-30 day')
        `).get(req.user.id);
        
        const today = db.prepare(`
            SELECT * FROM point_transactions 
            WHERE user_id = ? AND type = 'daily_bonus' AND date(created_at) = date('now')
        `).get(req.user.id);
        
        res.json({
            streak: streakData.streak || 0,
            claimedToday: !!today
        });
    } catch (error) {
        console.error('❌ Streak error:', error.message);
        res.status(500).json({ error: 'Failed to get streak' });
    }
});

// -------- NOTIFICATIONS --------
app.get('/api/notifications', auth, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const notifications = db.prepare(`
            SELECT * FROM notifications 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT ?
        `).all(req.user.id, limit);
        
        // Không tự động đánh dấu đã đọc, để client tự xử lý
        res.json({ notifications });
    } catch (error) {
        console.error('❌ Notifications error:', error.message);
        res.status(500).json({ error: 'Failed to get notifications' });
    }
});

app.put('/api/notifications/:id/read', auth, (req, res) => {
    try {
        const { id } = req.params;
        const result = db.prepare(`
            UPDATE notifications SET is_read = 1 
            WHERE id = ? AND user_id = ?
        `).run(id, req.user.id);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Notification not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Mark read error:', error.message);
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

app.put('/api/notifications/read-all', auth, (req, res) => {
    try {
        db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Mark all read error:', error.message);
        res.status(500).json({ error: 'Failed to mark all as read' });
    }
});

app.delete('/api/notifications/:id', auth, (req, res) => {
    try {
        const { id } = req.params;
        const result = db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?')
            .run(id, req.user.id);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Notification not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Delete notification error:', error.message);
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});

app.post('/api/notification-token', auth, (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({ error: 'Token required' });
        }
        
        db.prepare(`
            INSERT OR REPLACE INTO notification_tokens (user_id, token, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        `).run(req.user.id, token);
        
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Notification token error:', error.message);
        res.status(500).json({ error: 'Failed to save notification token' });
    }
});

// -------- CHECK AVAILABILITY --------
app.get('/api/check-username/:username', (req, res) => {
    try {
        const { username } = req.params;
        const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        res.json({ available: !user });
    } catch (error) {
        console.error('❌ Check username error:', error.message);
        res.status(500).json({ error: 'Failed to check username' });
    }
});

app.get('/api/check-email/:email', (req, res) => {
    try {
        const { email } = req.params;
        const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        res.json({ available: !user });
    } catch (error) {
        console.error('❌ Check email error:', error.message);
        res.status(500).json({ error: 'Failed to check email' });
    }
});

// ============ ADMIN API ============
app.get('/api/admin/stats', auth, admin, (req, res) => {
    try {
        const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
        const totalPoints = db.prepare('SELECT SUM(points) as total FROM users').get();
        const totalXNO = db.prepare('SELECT SUM(amount_xno) as total FROM xno_transactions WHERE status = ?').get('completed');
        const totalAds = db.prepare('SELECT COUNT(*) as count FROM point_transactions WHERE type = ?').get('watch_ad');
        const totalRedeemed = db.prepare('SELECT SUM(-amount) as total FROM point_transactions WHERE type = ?').get('redeem');

        res.json({
            users: totalUsers.count || 0,
            points: totalPoints.total || 0,
            xno: totalXNO.total || 0,
            ads: totalAds.count || 0,
            redeemed: totalRedeemed.total || 0
        });
    } catch (error) {
        console.error('❌ Admin stats error:', error.message);
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
        console.error('❌ Admin users error:', error.message);
        res.status(500).json({ error: 'Failed to get users' });
    }
});

app.get('/api/admin/transactions', auth, admin, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;
        const txs = db.prepare(`
            SELECT pt.id, u.username, pt.amount, pt.type, pt.source, pt.created_at
            FROM point_transactions pt
            JOIN users u ON pt.user_id = u.id
            ORDER BY pt.created_at DESC
            LIMIT ? OFFSET ?
        `).all(limit, offset);
        const total = db.prepare('SELECT COUNT(*) as total FROM point_transactions').get();
        res.json({ transactions: txs, total: total.total });
    } catch (error) {
        console.error('❌ Admin transactions error:', error.message);
        res.status(500).json({ error: 'Failed to get transactions' });
    }
});

app.get('/api/admin/suspicious', auth, admin, (req, res) => {
    try {
        const suspicious = db.prepare(`
            SELECT
                a.id,
                a.user_id,
                a.session_id,
                a.status,
                a.started_at as created_at,
                a.completed_at,
                a.verified_at,
                a.ip_address,
                u.username,
                u.email,
                u.points
            FROM ad_watch_history a
            JOIN users u ON a.user_id = u.id
            WHERE a.status = ?
            ORDER BY a.started_at DESC
            LIMIT 100
        `).all('suspicious');
        res.json({ suspicious });
    } catch (error) {
        console.error('❌ Admin suspicious error:', error.message);
        res.status(500).json({ error: 'Failed to get suspicious activities' });
    }
});

app.post('/api/admin/ban/:userId', auth, admin, (req, res) => {
    try {
        const userId = req.params.userId;
        const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run('banned', userId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ success: true, message: 'User banned successfully' });
    } catch (error) {
        console.error('❌ Ban user error:', error.message);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// ============ ADMIN WEB ROUTES ============
app.get('/admin/login', (req, res) => {
    const token = req.cookies?.adminToken;
    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = db.prepare('SELECT role FROM users WHERE id = ?').get(decoded.userId);
            if (user && user.role === 'admin') {
                return res.redirect('/admin');
            }
        } catch (e) {}
    }

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Admin Login - XNO Rewards</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
            <style>
                * { margin:0; padding:0; box-sizing:border-box; }
                body {
                    font-family: 'Inter', sans-serif;
                    background: #0A0A0F;
                    color: #F5F5FF;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                .container {
                    background: #1A1A2E;
                    padding: 48px 40px;
                    border-radius: 28px;
                    max-width: 420px;
                    width: 100%;
                    border: 1px solid rgba(255,255,255,0.08);
                    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                }
                h1 {
                    font-size: 28px;
                    font-weight: 800;
                    background: linear-gradient(135deg, #0A84FF, #7C3AED);
                    -webkit-background-clip: text;
                    background-clip: text;
                    color: transparent;
                    text-align: center;
                    margin-bottom: 8px;
                }
                p.sub {
                    color: #A0A0B8;
                    text-align: center;
                    font-size: 14px;
                    margin-bottom: 24px;
                }
                .form-group {
                    margin-bottom: 16px;
                }
                label {
                    display: block;
                    font-size: 13px;
                    font-weight: 600;
                    color: #A0A0B8;
                    margin-bottom: 6px;
                }
                input {
                    width: 100%;
                    padding: 12px 16px;
                    border: 2px solid rgba(255,255,255,0.08);
                    border-radius: 12px;
                    font-size: 15px;
                    background: #1E1E32;
                    color: #F5F5FF;
                    font-family: 'Inter', sans-serif;
                    transition: all 0.3s;
                }
                input:focus {
                    outline: none;
                    border-color: #0A84FF;
                    box-shadow: 0 0 0 4px rgba(10,132,255,0.1);
                }
                .btn {
                    width: 100%;
                    padding: 14px;
                    background: linear-gradient(135deg, #0A84FF, #7C3AED);
                    color: #fff;
                    border: none;
                    border-radius: 12px;
                    font-size: 16px;
                    font-weight: 700;
                    cursor: pointer;
                    transition: all 0.3s;
                    font-family: 'Inter', sans-serif;
                }
                .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(10,132,255,0.3); }
                .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
                .error {
                    background: rgba(255,55,95,0.1);
                    border: 1px solid rgba(255,55,95,0.2);
                    color: #FF375F;
                    padding: 12px 16px;
                    border-radius: 12px;
                    font-size: 14px;
                    margin-bottom: 16px;
                    display: none;
                }
                .spinner {
                    display: inline-block;
                    width: 20px;
                    height: 20px;
                    border: 2.5px solid rgba(255,255,255,0.2);
                    border-radius: 50%;
                    border-top-color: #fff;
                    animation: spin 0.7s linear infinite;
                    vertical-align: middle;
                }
                @keyframes spin { to { transform: rotate(360deg); } }
                .back-link {
                    text-align: center;
                    margin-top: 16px;
                    font-size: 14px;
                    color: #A0A0B8;
                }
                .back-link a { color: #0A84FF; text-decoration: none; font-weight: 600; }
                .back-link a:hover { text-decoration: underline; }
                .alert-info {
                    background: rgba(10,132,255,0.1);
                    border: 1px solid rgba(10,132,255,0.2);
                    color: #0A84FF;
                    padding: 12px 16px;
                    border-radius: 12px;
                    font-size: 14px;
                    margin-bottom: 16px;
                }
                .admin-hint {
                    text-align: center;
                    margin-top: 12px;
                    font-size: 12px;
                    color: #6B7280;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🛡️ Admin Login</h1>
                <p class="sub">Enter your admin credentials</p>
                ${req.query.logout ? '<div class="alert-info">✅ You have been logged out.</div>' : ''}
                <div id="error" class="error"></div>
                <form id="loginForm">
                    <div class="form-group">
                        <label>Email</label>
                        <input type="email" id="email" placeholder="admin@example.com" required autofocus>
                    </div>
                    <div class="form-group">
                        <label>Password</label>
                        <input type="password" id="password" placeholder="••••••••" required>
                    </div>
                    <button type="submit" class="btn" id="loginBtn">Sign In</button>
                </form>
                <div class="admin-hint">
                    💡 Admin email được cấu hình trong .env: <strong>${ADMIN_EMAIL}</strong>
                </div>
                <div class="back-link">
                    <a href="/">← Back to main site</a>
                </div>
            </div>
            <script>
                const form = document.getElementById('loginForm');
                const errorEl = document.getElementById('error');
                const btn = document.getElementById('loginBtn');

                form.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const email = document.getElementById('email').value;
                    const password = document.getElementById('password').value;

                    errorEl.style.display = 'none';
                    btn.disabled = true;
                    btn.innerHTML = '<span class="spinner"></span>';

                    try {
                        const res = await fetch('/admin/login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email, password })
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Login failed');

                        window.location.href = '/admin';
                    } catch (err) {
                        errorEl.textContent = err.message || 'Something went wrong.';
                        errorEl.style.display = 'block';
                    } finally {
                        btn.disabled = false;
                        btn.textContent = 'Sign In';
                    }
                });
            </script>
        </body>
        </html>
    `);
});

app.post('/admin/login', express.json(), async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (!user || !verifyPassword(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        if (user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const token = generateToken(user.id);

        res.cookie('adminToken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({ success: true, redirect: '/admin' });
    } catch (error) {
        console.error('❌ Admin login error:', error.message);
        res.status(500).json({ error: 'Admin login failed' });
    }
});

app.get('/admin/logout', (req, res) => {
    res.clearCookie('adminToken');
    res.redirect('/admin/login?logout=1');
});

app.get('/admin', adminAuthWeb, (req, res) => {
    const token = req.token;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Dashboard - XNO Rewards</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: 'Inter', -apple-system, sans-serif; 
                    padding: 20px; 
                    background: #f4f4f5; 
                }
                .container { max-width: 1200px; margin: 0 auto; }
                .card { 
                    background: white; 
                    padding: 20px; 
                    border-radius: 12px; 
                    margin-bottom: 20px; 
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1); 
                }
                table { width: 100%; border-collapse: collapse; }
                th, td { 
                    padding: 8px 12px; 
                    text-align: left; 
                    border-bottom: 1px solid #e4e4e7; 
                }
                th { background: #f8f8fa; font-weight: 600; }
                .suspicious { background: #fef2f2; }
                .badge { 
                    padding: 4px 8px; 
                    border-radius: 9999px; 
                    font-size: 12px; 
                    display: inline-block; 
                }
                .badge-danger { background: #fee2e2; color: #dc2626; }
                .badge-success { background: #dcfce7; color: #16a34a; }
                .badge-warning { background: #fef3c7; color: #d97706; }
                .btn-ban { 
                    background: #dc2626; 
                    color: white; 
                    border: none; 
                    padding: 4px 12px; 
                    border-radius: 6px; 
                    cursor: pointer; 
                    font-size: 12px; 
                }
                .btn-ban:hover { background: #b91c1c; }
                .stats-grid { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); 
                    gap: 16px; 
                }
                .stat { 
                    padding: 16px; 
                    background: white; 
                    border-radius: 8px; 
                    text-align: center; 
                }
                .stat-value { font-size: 32px; font-weight: 700; }
                .stat-label { font-size: 14px; color: #6b7280; }
                h1 { margin-bottom: 20px; }
                .header { 
                    display: flex; 
                    justify-content: space-between; 
                    align-items: center; 
                    margin-bottom: 20px; 
                }
                .btn-logout { 
                    background: #6b7280; 
                    color: white; 
                    border: none; 
                    padding: 8px 16px; 
                    border-radius: 6px; 
                    cursor: pointer; 
                    font-family: 'Inter', sans-serif;
                    font-weight: 600;
                }
                .btn-logout:hover { background: #4b5563; }
                .config-section { 
                    margin-top: 16px; 
                    padding: 16px; 
                    background: #f0f4ff; 
                    border-radius: 8px; 
                }
                .config-row { 
                    display: flex; 
                    align-items: center; 
                    gap: 12px; 
                    flex-wrap: wrap; 
                    margin-bottom: 8px; 
                }
                .config-row label { 
                    font-weight: 600; 
                    min-width: 160px; 
                    font-size: 13px;
                }
                .config-row input { 
                    padding: 6px 12px; 
                    border: 1px solid #ccc; 
                    border-radius: 6px; 
                    width: 140px; 
                    font-family: 'Inter', sans-serif;
                }
                .config-row button { 
                    background: #0A84FF; 
                    color: white; 
                    border: none; 
                    padding: 6px 16px; 
                    border-radius: 6px; 
                    cursor: pointer; 
                    font-family: 'Inter', sans-serif;
                    font-weight: 600;
                }
                .config-row button:hover { background: #006EDC; }
                .config-row .current-value {
                    font-size: 13px;
                    color: #6b7280;
                    margin-left: 4px;
                }
                .admin-user {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: #374151;
                    font-weight: 600;
                }
                .admin-user .avatar {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #0A84FF, #7C3AED);
                    color: white;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 700;
                    font-size: 14px;
                }
                .config-description {
                    font-size: 12px;
                    color: #6b7280;
                    margin-left: 12px;
                }
                .tabs {
                    display: flex;
                    gap: 8px;
                    margin-bottom: 16px;
                }
                .tab {
                    padding: 8px 16px;
                    background: #e4e4e7;
                    border-radius: 6px;
                    cursor: pointer;
                    font-weight: 600;
                    border: none;
                }
                .tab.active {
                    background: #0A84FF;
                    color: white;
                }
                .tab-content {
                    display: none;
                }
                .tab-content.active {
                    display: block;
                }
                @media (max-width: 600px) {
                    .stats-grid { grid-template-columns: 1fr 1fr; }
                    table { font-size: 12px; }
                    th, td { padding: 4px 6px; }
                    .config-row { flex-direction: column; align-items: stretch; }
                    .config-row label { min-width: auto; }
                    .config-row input { width: 100%; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div style="display:flex;align-items:center;gap:16px;">
                        <h1>🛡️ Admin Dashboard</h1>
                        <span class="admin-user">
                            <span class="avatar">${req.user.username.charAt(0).toUpperCase()}</span>
                            ${req.user.username}
                        </span>
                    </div>
                    <button class="btn-logout" onclick="logout()">Logout</button>
                </div>
                <div id="stats" class="card"></div>
                <div class="card">
                    <div class="tabs">
                        <button class="tab active" data-tab="suspicious">🚨 Suspicious</button>
                        <button class="tab" data-tab="users">👥 Users</button>
                        <button class="tab" data-tab="transactions">📜 Transactions</button>
                        <button class="tab" data-tab="config">⚙️ Config</button>
                    </div>
                    <div id="tab-suspicious" class="tab-content active"></div>
                    <div id="tab-users" class="tab-content"></div>
                    <div id="tab-transactions" class="tab-content"></div>
                    <div id="tab-config" class="tab-content"></div>
                </div>
            </div>
            <script>
                const API_URL = window.location.origin + '/api';
                const adminToken = '${token}';

                const CONFIG_DESCRIPTIONS = {
                    points_per_ad: 'Points earned per ad watched',
                    points_per_xno: 'Points needed to redeem 1 XNO',
                    daily_limit: 'Maximum points can earn per day',
                    min_redeem_points: 'Minimum points to redeem',
                    streak_bonus_multiplier: 'Bonus points per streak day',
                    referral_bonus: 'Points rewarded for each referral'
                };

                async function fetchWithAuth(url) {
                    const res = await fetch(url, {
                        headers: { 'Authorization': 'Bearer ' + adminToken }
                    });
                    if (!res.ok) {
                        if (res.status === 401 || res.status === 403) {
                            window.location.href = '/admin/login';
                            return null;
                        }
                        const errorData = await res.json().catch(() => ({}));
                        throw new Error(errorData.error || 'HTTP ' + res.status);
                    }
                    return res.json();
                }

                async function loadStats() {
                    try {
                        const data = await fetchWithAuth(API_URL + '/admin/stats');
                        if (!data) return;
                        document.getElementById('stats').innerHTML = \`
                            <div class="stats-grid">
                                <div class="stat"><div class="stat-value">\${data.users}</div><div class="stat-label">Total Users</div></div>
                                <div class="stat"><div class="stat-value">\${data.points}</div><div class="stat-label">Total Points</div></div>
                                <div class="stat"><div class="stat-value">\${data.redeemed || 0}</div><div class="stat-label">Points Redeemed</div></div>
                                <div class="stat"><div class="stat-value">\${data.xno || 0}</div><div class="stat-label">XNO Distributed</div></div>
                                <div class="stat"><div class="stat-value">\${data.ads}</div><div class="stat-label">Ads Watched</div></div>
                            </div>
                        \`;
                    } catch (e) {
                        console.error('Failed to load stats:', e);
                        document.getElementById('stats').innerHTML = '<p style="color:red;">❌ Failed to load stats: ' + e.message + '</p>';
                    }
                }

                async function loadSuspicious() {
                    try {
                        const data = await fetchWithAuth(API_URL + '/admin/suspicious');
                        if (!data) return;
                        let html = '<h3>🚨 Suspicious Activities</h3>';
                        if (data.suspicious.length === 0) {
                            html += '<p>✅ No suspicious activities found.</p>';
                        } else {
                            html += '<div style="overflow-x:auto;"><table><thead><tr><th>User</th><th>Email</th><th>Status</th><th>Time</th><th>Action</th></tr></thead><tbody>';
                            data.suspicious.forEach(s => {
                                html += \`
                                    <tr class="suspicious">
                                        <td>\${s.username}</td>
                                        <td>\${s.email}</td>
                                        <td><span class="badge badge-danger">\${s.status}</span></td>
                                        <td>\${new Date(s.created_at).toLocaleString()}</td>
                                        <td><button class="btn-ban" onclick="banUser(\${s.user_id})">Ban</button></td>
                                    </tr>
                                \`;
                            });
                            html += '</tbody></table></div>';
                        }
                        document.getElementById('tab-suspicious').innerHTML = html;
                    } catch (e) {
                        console.error('Failed to load suspicious:', e);
                        document.getElementById('tab-suspicious').innerHTML = '<p style="color:red;">❌ Failed to load suspicious activities: ' + e.message + '</p>';
                    }
                }

                async function loadUsers() {
                    try {
                        const data = await fetchWithAuth(API_URL + '/admin/users');
                        if (!data) return;
                        let html = '<h3>👥 Users</h3><div style="overflow-x:auto;"><table><thead><tr><th>ID</th><th>Username</th><th>Email</th><th>Points</th><th>Role</th><th>Verified</th><th>Created</th></tr></thead><tbody>';
                        data.forEach(u => {
                            html += \`
                                <tr>
                                    <td>\${u.id}</td>
                                    <td>\${u.username}</td>
                                    <td>\${u.email}</td>
                                    <td>\${u.points}</td>
                                    <td>\${u.role}</td>
                                    <td>\${u.is_verified ? '✅' : '❌'}</td>
                                    <td>\${new Date(u.created_at).toLocaleString()}</td>
                                </tr>
                            \`;
                        });
                        html += '</tbody></table></div>';
                        document.getElementById('tab-users').innerHTML = html;
                    } catch (e) {
                        console.error('Failed to load users:', e);
                        document.getElementById('tab-users').innerHTML = '<p style="color:red;">❌ Failed to load users: ' + e.message + '</p>';
                    }
                }

                async function loadTransactions() {
                    try {
                        const data = await fetchWithAuth(API_URL + '/admin/transactions?limit=100');
                        if (!data) return;
                        let html = '<h3>📜 Transactions</h3><div style="overflow-x:auto;"><table><thead><tr><th>ID</th><th>User</th><th>Amount</th><th>Type</th><th>Source</th><th>Time</th></tr></thead><tbody>';
                        data.transactions.forEach(tx => {
                            html += \`
                                <tr>
                                    <td>\${tx.id}</td>
                                    <td>\${tx.username}</td>
                                    <td style="color:\${tx.amount > 0 ? 'green' : 'red'}">\${tx.amount > 0 ? '+' : ''}\${tx.amount}</td>
                                    <td>\${tx.type}</td>
                                    <td>\${tx.source || '-'}</td>
                                    <td>\${new Date(tx.created_at).toLocaleString()}</td>
                                </tr>
                            \`;
                        });
                        html += '</tbody></table></div>';
                        document.getElementById('tab-transactions').innerHTML = html;
                    } catch (e) {
                        console.error('Failed to load transactions:', e);
                        document.getElementById('tab-transactions').innerHTML = '<p style="color:red;">❌ Failed to load transactions: ' + e.message + '</p>';
                    }
                }

                async function loadConfig() {
                    try {
                        const data = await fetchWithAuth(API_URL + '/config');
                        if (!data) return;
                        const configKeys = ['points_per_ad', 'points_per_xno', 'daily_limit', 'min_redeem_points', 'streak_bonus_multiplier', 'referral_bonus'];
                        let formHtml = '';
                        configKeys.forEach(key => {
                            const value = data[key] || '';
                            const desc = CONFIG_DESCRIPTIONS[key] || '';
                            formHtml += \`
                                <div class="config-row">
                                    <label>\${key.replace(/_/g, ' ').toUpperCase()}</label>
                                    <input type="number" id="cfg_\${key}" value="\${value}" min="1" step="1">
                                    <button onclick="updateConfig('\${key}', document.getElementById('cfg_\${key}').value)">Update</button>
                                    <span class="current-value">Current: \${value}</span>
                                    <span class="config-description">(\${desc})</span>
                                </div>
                            \`;
                        });
                        document.getElementById('tab-config').innerHTML = '<h3>⚙️ System Config</h3><div class="config-section">' + formHtml + '</div>';
                    } catch (e) {
                        console.error('Failed to load config:', e);
                        document.getElementById('tab-config').innerHTML = '<p style="color:red;">❌ Failed to load config: ' + e.message + '</p>';
                    }
                }

                async function updateConfig(key, value) {
                    const btn = event.target;
                    const originalText = btn.textContent;
                    btn.disabled = true;
                    btn.textContent = '⏳';
                    
                    try {
                        const res = await fetch(API_URL + '/admin/config', {
                            method: 'PUT',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': 'Bearer ' + adminToken
                            },
                            body: JSON.stringify({ key, value })
                        });
                        const data = await res.json();
                        if (res.ok) {
                            alert('✅ Config updated successfully!');
                            loadConfig();
                            loadStats();
                        } else {
                            alert('❌ Error: ' + (data.error || 'Unknown error'));
                        }
                    } catch (e) {
                        alert('❌ Failed to update config: ' + e.message);
                    } finally {
                        btn.disabled = false;
                        btn.textContent = originalText;
                    }
                }

                async function banUser(userId) {
                    if (!confirm('Ban this user?')) return;
                    try {
                        const res = await fetch(API_URL + '/admin/ban/' + userId, {
                            method: 'POST',
                            headers: { 'Authorization': 'Bearer ' + adminToken }
                        });
                        const data = await res.json();
                        if (res.ok) {
                            alert('✅ User banned successfully!');
                            loadSuspicious();
                            loadStats();
                            loadUsers();
                        } else {
                            alert('❌ Error: ' + (data.error || 'Unknown error'));
                        }
                    } catch (e) {
                        alert('❌ Failed to ban user: ' + e.message);
                    }
                }

                function logout() {
                    window.location.href = '/admin/logout';
                }

                // Tab switching
                document.querySelectorAll('.tab').forEach(tab => {
                    tab.addEventListener('click', function() {
                        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                        this.classList.add('active');
                        document.getElementById('tab-' + this.dataset.tab).classList.add('active');
                        // Load content if not loaded
                        if (this.dataset.tab === 'users') loadUsers();
                        if (this.dataset.tab === 'transactions') loadTransactions();
                        if (this.dataset.tab === 'config') loadConfig();
                    });
                });

                // Load initial tabs
                loadStats();
                loadSuspicious();
            </script>
        </body>
        </html>
    `);
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ============ SERVE RESET PASSWORD PAGE ============
app.get('/reset-password/:token', (req, res) => {
    const { token } = req.params;
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Reset Password - XNO Rewards</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
            <style>
                * { margin:0; padding:0; box-sizing:border-box; }
                body {
                    font-family: 'Inter', sans-serif;
                    background: #0A0A0F;
                    color: #F5F5FF;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                .container {
                    background: #1A1A2E;
                    padding: 48px 40px;
                    border-radius: 28px;
                    max-width: 440px;
                    width: 100%;
                    border: 1px solid rgba(255,255,255,0.08);
                    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                }
                h1 {
                    font-size: 28px;
                    font-weight: 800;
                    background: linear-gradient(135deg, #0A84FF, #7C3AED);
                    -webkit-background-clip: text;
                    background-clip: text;
                    color: transparent;
                    text-align: center;
                    margin-bottom: 8px;
                }
                p.sub {
                    color: #A0A0B8;
                    text-align: center;
                    font-size: 14px;
                    margin-bottom: 24px;
                }
                .form-group {
                    margin-bottom: 16px;
                }
                label {
                    display: block;
                    font-size: 13px;
                    font-weight: 600;
                    color: #A0A0B8;
                    margin-bottom: 6px;
                }
                input {
                    width: 100%;
                    padding: 12px 16px;
                    border: 2px solid rgba(255,255,255,0.08);
                    border-radius: 12px;
                    font-size: 15px;
                    background: #1E1E32;
                    color: #F5F5FF;
                    font-family: 'Inter', sans-serif;
                }
                input:focus {
                    outline: none;
                    border-color: #0A84FF;
                    box-shadow: 0 0 0 4px rgba(10,132,255,0.1);
                }
                .btn {
                    width: 100%;
                    padding: 14px;
                    background: linear-gradient(135deg, #0A84FF, #7C3AED);
                    color: #fff;
                    border: none;
                    border-radius: 12px;
                    font-size: 16px;
                    font-weight: 700;
                    cursor: pointer;
                    transition: all 0.3s;
                    font-family: 'Inter', sans-serif;
                }
                .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(10,132,255,0.3); }
                .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
                .error {
                    background: rgba(255,55,95,0.1);
                    border: 1px solid rgba(255,55,95,0.2);
                    color: #FF375F;
                    padding: 12px 16px;
                    border-radius: 12px;
                    font-size: 14px;
                    margin-bottom: 16px;
                    display: none;
                }
                .success {
                    background: rgba(50,215,75,0.1);
                    border: 1px solid rgba(50,215,75,0.2);
                    color: #32D74B;
                    padding: 12px 16px;
                    border-radius: 12px;
                    font-size: 14px;
                    margin-bottom: 16px;
                    display: none;
                }
                .back-link {
                    text-align: center;
                    margin-top: 16px;
                    font-size: 14px;
                    color: #A0A0B8;
                }
                .back-link a { color: #0A84FF; text-decoration: none; font-weight: 600; }
                .back-link a:hover { text-decoration: underline; }
                .spinner {
                    display: inline-block;
                    width: 20px;
                    height: 20px;
                    border: 2.5px solid rgba(255,255,255,0.2);
                    border-radius: 50%;
                    border-top-color: #fff;
                    animation: spin 0.7s linear infinite;
                    vertical-align: middle;
                }
                @keyframes spin { to { transform: rotate(360deg); } }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>XNO Rewards</h1>
                <p class="sub">Enter your new password</p>
                <div id="error" class="error"></div>
                <div id="success" class="success"></div>
                <form id="resetForm">
                    <input type="hidden" id="token" value="${token}">
                    <div class="form-group">
                        <label>New Password</label>
                        <input type="password" id="newPassword" placeholder="Min 8 characters" required>
                    </div>
                    <div class="form-group">
                        <label>Confirm Password</label>
                        <input type="password" id="confirmPassword" placeholder="Confirm password" required>
                    </div>
                    <button type="submit" class="btn" id="resetBtn">Reset Password</button>
                </form>
                <div class="back-link">
                    <a href="/">← Back to login</a>
                </div>
            </div>
            <script>
                const form = document.getElementById('resetForm');
                const errorEl = document.getElementById('error');
                const successEl = document.getElementById('success');
                const btn = document.getElementById('resetBtn');

                form.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const token = document.getElementById('token').value;
                    const newPassword = document.getElementById('newPassword').value;
                    const confirm = document.getElementById('confirmPassword').value;

                    errorEl.style.display = 'none';
                    successEl.style.display = 'none';

                    if (newPassword.length < 8) {
                        errorEl.textContent = 'Password must be at least 8 characters.';
                        errorEl.style.display = 'block';
                        return;
                    }
                    if (newPassword !== confirm) {
                        errorEl.textContent = 'Passwords do not match.';
                        errorEl.style.display = 'block';
                        return;
                    }

                    btn.disabled = true;
                    btn.innerHTML = '<span class="spinner"></span>';

                    try {
                        const res = await fetch('/api/auth/reset-password', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ token, newPassword })
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Failed to reset password');
                        successEl.textContent = data.message || 'Password reset successfully! You can now login.';
                        successEl.style.display = 'block';
                        form.reset();
                    } catch (err) {
                        errorEl.textContent = err.message || 'Something went wrong.';
                        errorEl.style.display = 'block';
                    } finally {
                        btn.disabled = false;
                        btn.textContent = 'Reset Password';
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// ============ SERVE FRONTEND STATIC FILES ============
app.use(express.static(path.join(__dirname, 'frontend'), {
    maxAge: '1d',
    etag: true
}));

// ============ 404 HANDLER ============
app.get('*', (req, res) => {
    if (req.path.startsWith('/admin')) {
        return res.redirect('/admin/login');
    }
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ============ GLOBAL ERROR HANDLING MIDDLEWARE ============
app.use((req, res) => {
    console.log('⚠️ 404 Not Found:', req.method, req.url);
    if (req.path.startsWith('/api')) {
        res.status(404).json({
            error: 'Endpoint not found',
            path: req.url,
            method: req.method
        });
    } else {
        res.status(404).send('Not Found');
    }
});

app.use((err, req, res, next) => {
    console.error('❌ Global error handler:', {
        message: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        ip: req.ip
    });

    if (err.code === 'SQLITE_ERROR') {
        return res.status(500).json({ error: 'Database error' });
    }

    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({ error: 'Invalid token' });
    }

    if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
    }

    if (err.message === 'CORS not allowed') {
        return res.status(403).json({ error: 'CORS not allowed' });
    }

    if (process.env.NODE_ENV === 'production') {
        return res.status(500).json({ error: 'Internal server error' });
    }

    res.status(500).json({
        error: err.message,
        stack: err.stack,
        code: err.code
    });
});

// ============ START SERVER ============
const server = app.listen(PORT, () => {
    console.log(`\n🚀 XNO Rewards Server running on http://localhost:${PORT}`);
    console.log(`📊 API: http://localhost:${PORT}/api/health`);
    console.log(`🌐 Frontend: http://localhost:${PORT}`);
    console.log(`👑 Admin email: ${ADMIN_EMAIL}`);
    console.log(`📁 Database: ${process.env.DB_PATH || './database.db'}`);
    console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📋 CORS: All origins allowed\n`);
});

process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, closing server...');
    server.close(() => {
        console.log('✅ Server closed');
        db.close();
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received, closing server...');
    server.close(() => {
        console.log('✅ Server closed');
        db.close();
        process.exit(0);
    });
});
