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

      CREATE TRIGGER IF NOT EXISTS update_users_updated_at
      AFTER UPDATE ON users
      BEGIN
        UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
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

// ============ FIX: Thêm cột reference_id nếu chưa có ============
try {
    db.exec('ALTER TABLE point_transactions ADD COLUMN reference_id TEXT');
    console.log('✅ Added reference_id column to point_transactions');
} catch (e) {
    console.log('ℹ️ reference_id column already exists');
}

// ============ FIX: Thêm cột expires_at nếu chưa có ============
try {
    db.exec('ALTER TABLE ad_watch_history ADD COLUMN expires_at DATETIME');
    console.log('✅ Added expires_at column to ad_watch_history');
} catch (e) {
    console.log('ℹ️ expires_at column already exists');
}

// Tạo index an toàn
const createIndex = (sql) => {
    try {
        db.exec(sql);
    } catch (e) {
        // Index already exists, ignore
    }
};
try {
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
    console.log('✅ Database indexes created');
} catch (error) {
    console.error('⚠️ Some indexes may already exist:', error.message);
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
            from: process.env.EMAIL_FROM || 'noreply@duco-rewards.com',
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
app.set('trust proxy', false);

app.use(helmet({
    contentSecurityPolicy: false
}));

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
        const user = db.prepare('SELECT id, username, email, role, points, is_verified, wallet_address FROM users WHERE id = ?').get(decoded.userId);

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

// ============ API ROUTES ============

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
                `<h1>Duco Rewards</h1>
                 <p>Your verification code is:</p>
                 <h2 style="font-size: 32px; color: #22c55e; letter-spacing: 4px; padding: 12px; background: #f0fdf4; border-radius: 8px;">${code}</h2>
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
        const { username, email, password, walletAddress, hcaptchaToken, otpCode } = req.body;

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
        const stmt = db.prepare(`
            INSERT INTO users (username, email, password_hash, wallet_address, is_verified)
            VALUES (?, ?, ?, ?, 1)
        `);
        const info = stmt.run(username, email, passwordHash, walletAddress || null);

        db.prepare('DELETE FROM email_verifications WHERE email = ?').run(email);

        res.status(201).json({
            message: 'Registration successful! You can now login.',
            userId: info.lastInsertRowid
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

        if (process.env.HCAPTCHA_SECRET) {
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
        console.error('❌ Points error:', error.message);
        res.status(500).json({ error: 'Failed to get points' });
    }
});

// -------- AD VERIFICATION (A-Ads) --------
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

        console.log('🔍 Ad verify request:', { sessionId, watchDuration, adId, userId: req.user.id });

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

        const currentIp = req.ip || req.connection.remoteAddress || 'unknown';
        if (session.ip_address !== currentIp && session.ip_address !== 'unknown' && currentIp !== 'unknown') {
            db.prepare(`
                UPDATE ad_watch_history
                SET status = 'suspicious', completed_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(session.id);
            return res.status(400).json({ error: 'IP mismatch detected' });
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

        if ((today.today_points || 0) + 10 > 100) {
            return res.status(429).json({ error: 'Daily limit reached (100 points/day)' });
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
            db.prepare('UPDATE users SET points = points + 10 WHERE id = ?').run(req.user.id);

            db.prepare(`
                INSERT INTO point_transactions (user_id, amount, type, source, reference_id)
                VALUES (?, 10, 'watch_ad', 'aads', ?)
            `).run(req.user.id, sessionId);

            console.log('✅ Points added successfully for user:', req.user.id);
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
            pointsAdded: 10,
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
        console.error('❌ Redeem error:', {
            message: error.message,
            stack: error.stack,
            userId: req.user.id
        });
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

app.get('/api/admin/suspicious', auth, admin, (req, res) => {
    try {
        const suspicious = db.prepare(`
            SELECT
                a.*,
                u.username,
                u.email,
                u.points
            FROM ad_watch_history a
            JOIN users u ON a.user_id = u.id
            WHERE a.status = 'suspicious'
            ORDER BY a.created_at DESC
            LIMIT 100
        `).all();
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

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ============ ADMIN DASHBOARD ============
app.get('/admin', auth, admin, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Dashboard</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: 'Inter', -apple-system, sans-serif; padding: 20px; background: #f4f4f5; }
                .container { max-width: 1200px; margin: 0 auto; }
                .card { background: white; padding: 20px; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                table { width: 100%; border-collapse: collapse; }
                th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e4e4e7; }
                th { background: #f8f8fa; font-weight: 600; }
                .suspicious { background: #fef2f2; }
                .badge { padding: 4px 8px; border-radius: 9999px; font-size: 12px; display: inline-block; }
                .badge-danger { background: #fee2e2; color: #dc2626; }
                .badge-success { background: #dcfce7; color: #16a34a; }
                .badge-warning { background: #fef3c7; color: #d97706; }
                .btn-ban { background: #dc2626; color: white; border: none; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
                .btn-ban:hover { background: #b91c1c; }
                .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; }
                .stat { padding: 16px; background: white; border-radius: 8px; text-align: center; }
                .stat-value { font-size: 32px; font-weight: 700; }
                .stat-label { font-size: 14px; color: #6b7280; }
                h1 { margin-bottom: 20px; }
                .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
                .btn-logout { background: #6b7280; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
                .btn-logout:hover { background: #4b5563; }
                @media (max-width: 600px) {
                    .stats-grid { grid-template-columns: 1fr 1fr; }
                    table { font-size: 12px; }
                    th, td { padding: 4px 6px; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🛡️ Admin Dashboard</h1>
                    <button class="btn-logout" onclick="logout()">Logout</button>
                </div>
                <div id="stats" class="card"></div>
                <div id="suspicious" class="card"></div>
            </div>
            <script>
                const API_URL = '${req.protocol}://${req.get('host')}/api';

                async function fetchWithAuth(url) {
                    const res = await fetch(url, {
                        headers: { 'Authorization': 'Bearer ${req.token}' }
                    });
                    return res.json();
                }

                async function loadStats() {
                    try {
                        const data = await fetchWithAuth(API_URL + '/admin/stats');
                        document.getElementById('stats').innerHTML = \`
                            <div class="stats-grid">
                                <div class="stat"><div class="stat-value">\${data.users}</div><div class="stat-label">Total Users</div></div>
                                <div class="stat"><div class="stat-value">\${data.points}</div><div class="stat-label">Total Points</div></div>
                                <div class="stat"><div class="stat-value">\${data.xno}</div><div class="stat-label">XNO Distributed</div></div>
                                <div class="stat"><div class="stat-value">\${data.ads}</div><div class="stat-label">Ads Watched</div></div>
                            </div>
                        \`;
                    } catch (e) {
                        console.error('Failed to load stats:', e);
                    }
                }

                async function loadSuspicious() {
                    try {
                        const data = await fetchWithAuth(API_URL + '/admin/suspicious');
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
                        document.getElementById('suspicious').innerHTML = html;
                    } catch (e) {
                        console.error('Failed to load suspicious:', e);
                    }
                }

                async function banUser(userId) {
                    if (!confirm('Ban this user?')) return;
                    try {
                        const res = await fetch(API_URL + '/admin/ban/' + userId, {
                            method: 'POST',
                            headers: { 'Authorization': 'Bearer ${req.token}' }
                        });
                        const data = await res.json();
                        if (res.ok) {
                            alert('User banned!');
                            loadSuspicious();
                            loadStats();
                        } else {
                            alert('Error: ' + data.error);
                        }
                    } catch (e) {
                        alert('Failed to ban user');
                    }
                }

                async function logout() {
                    try {
                        await fetch(API_URL + '/auth/logout', {
                            method: 'POST',
                            headers: { 'Authorization': 'Bearer ${req.token}' }
                        });
                    } catch (e) {}
                    window.location.href = '/';
                }

                loadStats();
                loadSuspicious();
            </script>
        </body>
        </html>
    `);
});

// ============ SERVE FRONTEND STATIC FILES ============
app.use(express.static(path.join(__dirname, 'frontend')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ============ GLOBAL ERROR HANDLING MIDDLEWARE ============
app.use((req, res) => {
    console.log('⚠️ 404 Not Found:', req.method, req.url);
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.url,
        method: req.method
    });
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
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 API: http://localhost:${PORT}/api/health`);
    console.log(`🌐 Frontend: http://localhost:${PORT}`);
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
