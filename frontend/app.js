const API_URL = window.location.origin + '/api';

// ============ STATE ============
let state = {
    user: null,
    points: 0,
    stats: { totalWatched: 0, totalEarned: 0, dailyLimit: 100, dailyUsed: 0 },
    isLoading: false,
    page: 'login',
    level: 1,
    xp: 0,
    streak: 0,
    notifications: []
};

// ============ AD STATE ============
let adVisibleDuration = 0;
let adWatchInterval = null;
let isAdWatching = false;
let adObserver = null;
let isAdVisible = false;
let currentAdSessionId = null;
let isAdCompletedCalled = false;

// ============ DOM REFS ============
let app = null;

// ============ API CLIENT ============
const api = {
    get: async (endpoint) => {
        const token = localStorage.getItem('accessToken');
        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
        const res = await fetch(`${API_URL}${endpoint}`, { headers });
        if (!res.ok) {
            if (res.status === 401) {
                const refreshed = await refreshToken();
                if (refreshed) {
                    const newToken = localStorage.getItem('accessToken');
                    const retry = await fetch(`${API_URL}${endpoint}`, {
                        headers: { 'Authorization': `Bearer ${newToken}`, 'Content-Type': 'application/json' }
                    });
                    return retry.json();
                }
                throw new Error('Session expired. Please login again.');
            }
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return res.json();
    },
    post: async (endpoint, data) => {
        const token = localStorage.getItem('accessToken');
        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
        const res = await fetch(`${API_URL}${endpoint}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(data)
        });
        if (!res.ok) {
            if (res.status === 401) {
                const refreshed = await refreshToken();
                if (refreshed) {
                    const newToken = localStorage.getItem('accessToken');
                    const retry = await fetch(`${API_URL}${endpoint}`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${newToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(data)
                    });
                    return retry.json();
                }
                throw new Error('Session expired. Please login again.');
            }
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${res.status}: ${res.statusText}`);
        }
        return res.json();
    }
};

// ============ REFRESH TOKEN ============
async function refreshToken() {
    try {
        const refreshToken = localStorage.getItem('refreshToken');
        if (!refreshToken) return false;
        const res = await fetch(`${API_URL}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken })
        });
        if (!res.ok) return false;
        const data = await res.json();
        localStorage.setItem('accessToken', data.accessToken);
        return true;
    } catch (error) {
        console.error('Refresh token error:', error);
        return false;
    }
}

// ============ HCAPTCHA HELPERS ============
let captchaWidgetId = null;

function renderCaptcha(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    const captchaDiv = document.createElement('div');
    captchaDiv.className = 'h-captcha';
    captchaDiv.setAttribute('data-sitekey', '5aa632cc-e278-444e-90aa-59aa63e00a36');
    container.appendChild(captchaDiv);
    if (typeof hcaptcha !== 'undefined') {
        captchaWidgetId = hcaptcha.render(captchaDiv);
    }
}

function getCaptchaResponse() {
    try {
        if (typeof hcaptcha === 'undefined') return null;
        return hcaptcha.getResponse(captchaWidgetId);
    } catch (e) { return null; }
}

function resetCaptcha() {
    try {
        if (typeof hcaptcha !== 'undefined' && captchaWidgetId !== null) {
            hcaptcha.reset(captchaWidgetId);
        }
    } catch (e) {}
}

// ============ THEME TOGGLE ============
function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('xno_theme', next);
    updateThemeIcon(next);
}

function updateThemeIcon(theme) {
    const icon = document.getElementById('themeIcon');
    if (!icon) return;
    icon.className = theme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
}

function loadTheme() {
    const saved = localStorage.getItem('xno_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcon(saved);
}

// ============ LEVEL SYSTEM ============
function calculateLevel(points) {
    const level = Math.floor(points / 100) + 1;
    const xp = points % 100;
    return { level, xp, nextLevelXp: 100 };
}

// ============ INTERSECTION OBSERVER ============
function initAdObserver() {
    const banner = document.getElementById('aadsBanner');
    if (!banner) return;
    if (adObserver) { adObserver.disconnect(); adObserver = null; }
    adObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                isAdVisible = true;
                if (isAdWatching && adWatchInterval === null) startAdCounting();
            } else {
                isAdVisible = false;
                if (adWatchInterval) stopAdCounting();
            }
        });
    }, { threshold: 0.3 });
    adObserver.observe(banner);
}

// ============ AD COUNTING ============
function startAdCounting() {
    if (adWatchInterval) return;
    adVisibleDuration = 0;
    isAdCompletedCalled = false;
    updateAdStatus();
    adWatchInterval = setInterval(() => {
        adVisibleDuration = Math.min(15, adVisibleDuration + 1);
        updateAdStatus();
        if (adVisibleDuration >= 15 && !isAdCompletedCalled) {
            clearInterval(adWatchInterval);
            adWatchInterval = null;
            isAdWatching = false;
            isAdCompletedCalled = true;
            onAdCompleted();
        }
    }, 1000);
}

function stopAdCounting() {
    if (adWatchInterval) { clearInterval(adWatchInterval); adWatchInterval = null; }
    updateAdStatus();
}

function updateAdStatus() {
    const status = document.getElementById('aadsStatus');
    const progress = document.getElementById('aadsProgress');
    if (status) {
        const pct = Math.min(100, Math.round((adVisibleDuration / 15) * 100));
        if (isAdWatching && isAdVisible) {
            status.textContent = `⏳ Watching... ${pct}%`;
            status.style.color = '';
        } else if (isAdWatching && !isAdVisible) {
            status.textContent = `👀 Scroll to continue... ${pct}%`;
            status.style.color = 'var(--primary)';
        } else if (adVisibleDuration >= 15) {
            status.textContent = '✅ Completed!';
            status.style.color = 'var(--success)';
        } else {
            status.textContent = '⏳ Click "Watch Ad" to start';
            status.style.color = '';
        }
    }
    if (progress) {
        progress.style.width = Math.min(100, (adVisibleDuration / 15) * 100) + '%';
    }
}

function resetAdState(keepVisible = false) {
    if (adWatchInterval) { clearInterval(adWatchInterval); adWatchInterval = null; }
    if (adObserver) { adObserver.disconnect(); adObserver = null; }
    isAdWatching = false;
    isAdVisible = false;
    adVisibleDuration = 0;
    isAdCompletedCalled = false;
    currentAdSessionId = null;
    const banner = document.getElementById('aadsBanner');
    if (banner) {
        banner.classList.remove('expanded');
        if (!keepVisible) {
            banner.style.display = 'none';
        }
    }
    updateAdStatus();
    const btn = document.getElementById('watchBtn');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-play"></i> Watch Ad (+10 pts)'; }
}

// ============ UPDATE REDEEM BUTTON ============
function updateRedeemButton() {
    const btn = document.getElementById('redeemBtn');
    if (!btn) return;
    if (state.points < 50) {
        btn.disabled = true;
        btn.textContent = '🔒 Need 50 pts';
    } else {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-exchange-alt"></i> Redeem';
    }
}

// ============ SHOW NOTIFICATION ============
function showNotification(message, type = 'success') {
    const colors = { success: '#32D74B', error: '#FF375F', warning: '#FF9F0A', info: '#0A84FF' };
    const el = document.createElement('div');
    el.style.cssText = `
        position: fixed; top: 20px; right: 20px; padding: 14px 24px;
        background: var(--bg-card); color: var(--text-primary);
        border: 1px solid ${colors[type] || colors.info};
        border-radius: var(--radius-md);
        font-weight: 600; font-size: 14px;
        box-shadow: var(--shadow); z-index: 9999;
        max-width: 400px; animation: fadeUp 0.3s ease-out;
        font-family: 'Inter', sans-serif; cursor: pointer;
        border-left: 4px solid ${colors[type] || colors.info};
    `;
    el.textContent = message;
    el.onclick = () => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); };
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 4000);
}

// ============ RENDER FUNCTIONS ============
function render() {
    app = document.getElementById('app');
    if (!state.user) {
        app.innerHTML = state.page === 'login' ? renderLogin() : renderRegister();
        setTimeout(() => renderCaptcha('captcha-container'), 100);
        attachEvents();
        return;
    }
    app.innerHTML = renderDashboard();
    attachEvents();
    updateRedeemButton();
}

// ============ LOGIN PAGE ============
function renderLogin() {
    return `
        <div class="auth-container">
            <div class="auth-card">
                <div class="auth-logo">
                    <svg class="logo-icon" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect width="200" height="200" rx="40" fill="url(#grad)" />
                        <text x="100" y="140" font-family="Inter, sans-serif" font-size="100" font-weight="800" fill="white" text-anchor="middle">Ӿ</text>
                        <defs>
                            <linearGradient id="grad" x1="0" y1="0" x2="200" y2="200">
                                <stop offset="0%" stop-color="#0A84FF" />
                                <stop offset="100%" stop-color="#7C3AED" />
                            </linearGradient>
                        </defs>
                    </svg>
                    <h1>XNO Rewards</h1>
                    <p>Earn Nano by watching ads</p>
                </div>
                <div id="error" class="auth-error"></div>
                <form id="loginForm" class="auth-form">
                    <div class="form-group">
                        <label>Email Address</label>
                        <input type="email" id="email" placeholder="you@example.com" required>
                    </div>
                    <div class="form-group">
                        <label>Password</label>
                        <input type="password" id="password" placeholder="••••••••" required>
                    </div>
                    <div id="captcha-container" class="form-group"></div>
                    <button type="submit" class="btn-primary" id="loginBtn">
                        <i class="fas fa-sign-in-alt"></i> Sign In
                    </button>
                </form>
                <div class="auth-footer">
                    Don't have an account? <a href="#" onclick="state.page='register'; render();">Create one</a>
                    <br><small><a href="#" onclick="forgotPassword()">Forgot password?</a></small>
                </div>
            </div>
        </div>
    `;
}

// ============ REGISTER PAGE ============
function renderRegister() {
    return `
        <div class="auth-container">
            <div class="auth-card">
                <div class="auth-logo">
                    <svg class="logo-icon" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect width="200" height="200" rx="40" fill="url(#grad)" />
                        <text x="100" y="140" font-family="Inter, sans-serif" font-size="100" font-weight="800" fill="white" text-anchor="middle">Ӿ</text>
                        <defs>
                            <linearGradient id="grad" x1="0" y1="0" x2="200" y2="200">
                                <stop offset="0%" stop-color="#0A84FF" />
                                <stop offset="100%" stop-color="#7C3AED" />
                            </linearGradient>
                        </defs>
                    </svg>
                    <h1>Create Account</h1>
                    <p>Get verified with a 4-digit code</p>
                </div>
                <div id="error" class="auth-error"></div>
                <form id="registerForm" class="auth-form">
                    <div class="form-group">
                        <label>Username</label>
                        <input type="text" id="username" placeholder="Choose a username" required>
                    </div>
                    <div class="form-group">
                        <label>Email Address</label>
                        <div class="input-with-button">
                            <input type="email" id="email" placeholder="you@example.com" required>
                            <button type="button" id="sendOtpBtn" class="btn-primary" style="width:auto; padding:12px 20px; font-size:13px;">
                                <i class="fas fa-paper-plane"></i> Send
                            </button>
                        </div>
                        <div id="otpStatus" class="otp-status"></div>
                    </div>
                    <div class="form-group">
                        <label>Verification Code</label>
                        <input type="text" id="otpCode" placeholder="0000" maxlength="4" style="text-align:center; font-size:24px; letter-spacing:8px;" required>
                    </div>
                    <div class="form-group">
                        <label>Password</label>
                        <input type="password" id="password" placeholder="Min 8 characters" required>
                    </div>
                    <div class="form-group">
                        <label>Nano Wallet <small style="color:var(--text-tertiary);font-weight:400;">(optional)</small></label>
                        <input type="text" id="wallet" placeholder="nano_1...">
                    </div>
                    <div id="captcha-container" class="form-group"></div>
                    <button type="submit" class="btn-primary" id="registerBtn">
                        <i class="fas fa-user-plus"></i> Create Account
                    </button>
                </form>
                <div class="auth-footer">
                    Already have an account? <a href="#" onclick="state.page='login'; render();">Sign in</a>
                </div>
            </div>
        </div>
    `;
}

// ============ DASHBOARD ============
function renderDashboard() {
    const { user, points, stats } = state;
    const progress = Math.min((stats.dailyUsed / stats.dailyLimit * 100), 100);
    const xnoEarned = (stats.totalEarned / 50 * 0.1).toFixed(4);
    const { level, xp, nextLevelXp } = calculateLevel(points);
    const levelProgress = Math.min((xp / nextLevelXp) * 100, 100);

    return `
        <div class="dashboard">
            <nav class="navbar">
                <a href="#" class="navbar-brand" onclick="renderDashboard(); return false;">
                    <svg class="brand-icon" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" style="height:32px;width:auto;">
                        <rect width="200" height="200" rx="40" fill="url(#brandGrad)" />
                        <text x="100" y="140" font-family="Inter, sans-serif" font-size="100" font-weight="800" fill="white" text-anchor="middle">Ӿ</text>
                        <defs>
                            <linearGradient id="brandGrad" x1="0" y1="0" x2="200" y2="200">
                                <stop offset="0%" stop-color="#0A84FF" />
                                <stop offset="100%" stop-color="#7C3AED" />
                            </linearGradient>
                        </defs>
                    </svg>
                    XNO<span>Rewards</span>
                </a>
                <div class="navbar-actions">
                    <span class="user-info">
                        <span class="avatar">${user.username.charAt(0).toUpperCase()}</span>
                        <span class="username"><strong>${user.username}</strong></span>
                    </span>
                    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">
                        <i class="fas fa-moon" id="themeIcon"></i>
                    </button>
                    <button class="btn-logout" onclick="logout()" title="Logout">
                        <i class="fas fa-sign-out-alt"></i>
                    </button>
                </div>
            </nav>

            <div class="dashboard-content">
                <!-- Hero -->
                <div class="hero-section">
                    <div class="hero-content">
                        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                            <h2>Welcome back, ${user.username} 👋</h2>
                            <span class="level-badge">🏆 Level ${level}</span>
                        </div>
                        <p>Watch ads to earn points and redeem for real Nano (XNO)</p>
                        <div class="hero-stats">
                            <div class="stat-item">
                                <span class="value">${points}</span>
                                <span class="label">Total Points</span>
                            </div>
                            <div class="stat-item">
                                <span class="value">${xnoEarned}</span>
                                <span class="label">XNO Earned</span>
                            </div>
                            <div class="stat-item">
                                <span class="value">${stats.totalWatched}</span>
                                <span class="label">Ads Watched</span>
                            </div>
                            <div class="stat-item">
                                <span class="value">${state.streak || 0}🔥</span>
                                <span class="label">Day Streak</span>
                            </div>
                        </div>
                        <div style="margin-top:12px;">
                            <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-tertiary);">
                                <span>Level ${level} (${xp}/${nextLevelXp} XP)</span>
                                <span>${Math.round(levelProgress)}%</span>
                            </div>
                            <div class="daily-progress">
                                <div class="progress-bar">
                                    <div class="fill" style="width:${levelProgress}%;background:var(--gradient-warning);"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Stats -->
                <div class="stats-grid">
                    <div class="stat-card primary">
                        <div class="stat-icon">🪙</div>
                        <div class="stat-label">Available Points</div>
                        <div class="stat-value" id="pointsDisplay">${points.toLocaleString()}</div>
                    </div>
                    <div class="stat-card success">
                        <div class="stat-icon">⚡</div>
                        <div class="stat-label">XNO Balance</div>
                        <div class="stat-value">${xnoEarned}</div>
                    </div>
                    <div class="stat-card warning">
                        <div class="stat-icon">📺</div>
                        <div class="stat-label">Ads Watched</div>
                        <div class="stat-value">${stats.totalWatched}</div>
                    </div>
                    <div class="stat-card purple">
                        <div class="stat-icon">📊</div>
                        <div class="stat-label">Daily Progress</div>
                        <div class="daily-progress">
                            <div class="progress-bar">
                                <div class="fill" style="width:${progress}%"></div>
                            </div>
                            <span class="progress-text">${stats.dailyUsed}/${stats.dailyLimit}</span>
                        </div>
                    </div>
                </div>

                <!-- Actions -->
                <div class="actions-grid">
                    <div class="action-card">
                        <h3>📺 Watch Ad</h3>
                        <p class="subtitle">Watch a short ad and earn <strong>10 points</strong></p>
                        <button onclick="watchAd()" id="watchBtn" class="btn-action btn-watch">
                            <i class="fas fa-play"></i> Watch Ad (+10 pts)
                        </button>
                        <div id="adMessage" class="action-message"></div>
                    </div>
                    <div class="action-card">
                        <h3>🔄 Redeem XNO</h3>
                        <p class="subtitle"><strong>50 points</strong> = <strong>0.1 XNO</strong></p>
                        <div class="redeem-input">
                            <input type="number" id="redeemPoints" min="50" step="50" value="50" placeholder="Points">
                            <input type="text" id="redeemWallet" placeholder="nano_1...">
                            <button onclick="redeem()" id="redeemBtn" class="btn-action btn-redeem">
                                <i class="fas fa-exchange-alt"></i> Redeem
                            </button>
                        </div>
                        <div id="redeemMessage" class="action-message"></div>
                    </div>
                </div>

                <!-- Daily Bonus -->
                <div style="margin-bottom:16px;display:flex;gap:12px;flex-wrap:wrap;">
                    <button onclick="claimDailyBonus()" id="dailyBonusBtn" class="btn-action" style="background:var(--gradient-warning);padding:12px 24px;width:auto;border-radius:var(--radius-md);font-weight:700;">
                        🎁 Daily Bonus
                    </button>
                    <button onclick="showLeaderboard()" id="leaderboardBtn" class="btn-action" style="background:var(--gradient-primary);padding:12px 24px;width:auto;border-radius:var(--radius-md);font-weight:700;">
                        🏆 Leaderboard
                    </button>
                </div>

                <!-- Referral -->
                <div class="referral-section">
                    <div class="referral-header">
                        <h3><i class="fas fa-link" style="color:var(--primary);"></i> Referral Program</h3>
                        <div class="referral-code">
                            <code>${user.username}-XNO</code>
                            <button class="copy-btn" onclick="copyReferral()" title="Copy referral link">
                                <i class="fas fa-copy"></i>
                            </button>
                        </div>
                    </div>
                    <p style="font-size:13px;color:var(--text-secondary);margin-top:8px;">
                        Share your referral link and earn <strong style="color:var(--success);">5 points</strong> for each friend who joins!
                    </p>
                </div>

                <!-- Log -->
                <div class="log-card">
                    <div class="log-header">
                        <h3><i class="fas fa-list-ul"></i> Activity Log</h3>
                        <button class="btn-clear" onclick="clearLog()"><i class="fas fa-trash-alt"></i> Clear</button>
                    </div>
                    <div id="log" class="log-container">
                        <div class="log-entry" style="color:var(--text-tertiary);">
                            <span class="time">—</span> Ready to earn points!
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- A-ADS Banner -->
        <div class="aads-banner" id="aadsBanner">
            <div class="aads-banner-header">
                <span style="font-size:0.6rem;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.06em;">Sponsored</span>
                <button class="aads-banner-close" id="aadsBannerClose">✕</button>
            </div>
            <iframe class="aads-iframe" data-aa="2451472" src="//acceptable.a-ads.com/2451472/?size=Adaptive" id="aadsIframe"></iframe>
            <div class="aads-progress-bar">
                <div class="aads-progress-fill" id="aadsProgress"></div>
            </div>
            <div class="aads-status" id="aadsStatus">⏳ Click "Watch Ad" to start</div>
        </div>
    `;
}

// ============ EVENTS ============
function attachEvents() {
    loadTheme();

    document.getElementById('sendOtpBtn')?.addEventListener('click', async () => {
        const email = document.getElementById('email').value;
        const statusEl = document.getElementById('otpStatus');
        const btn = document.getElementById('sendOtpBtn');
        if (!email || !email.includes('@')) {
            statusEl.textContent = '❌ Please enter a valid email';
            statusEl.className = 'otp-status error';
            return;
        }
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner spinner-sm"></span>';
        statusEl.textContent = '⏳ Sending...';
        statusEl.className = 'otp-status info';
        try {
            const res = await fetch(`${API_URL}/auth/send-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to send code');
            if (data.devCode) {
                statusEl.textContent = `⚠️ DEV MODE - Code: ${data.devCode}`;
                statusEl.className = 'otp-status warning';
                document.getElementById('otpCode').value = data.devCode;
            } else {
                statusEl.textContent = '✅ Code sent! Check your email';
                statusEl.className = 'otp-status success';
            }
        } catch (error) {
            statusEl.textContent = '❌ ' + error.message;
            statusEl.className = 'otp-status error';
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send';
        }
    });

    document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const token = getCaptchaResponse();
        if (!token || token.length === 0) { showError('Please complete hCaptcha verification'); return; }
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const btn = document.getElementById('loginBtn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
        try {
            const res = await fetch(`${API_URL}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, hcaptchaToken: token })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Login failed');
            localStorage.setItem('accessToken', data.accessToken);
            localStorage.setItem('refreshToken', data.refreshToken);
            state.user = data.user;
            await fetchPoints();
            resetCaptcha();
            showNotification('Welcome back! 🎉', 'success');
            render();
        } catch (error) {
            showError(error.message);
            resetCaptcha();
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
        }
    });

    document.getElementById('registerForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const token = getCaptchaResponse();
        if (!token || token.length === 0) { showError('Please complete hCaptcha verification'); return; }
        const username = document.getElementById('username').value;
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const wallet = document.getElementById('wallet').value;
        const otpCode = document.getElementById('otpCode').value;
        const btn = document.getElementById('registerBtn');
        if (!otpCode || otpCode.length !== 4) { showError('Please enter 4-digit verification code'); return; }
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
        try {
            const res = await fetch(`${API_URL}/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, email, password, walletAddress: wallet, hcaptchaToken: token, otpCode })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Registration failed');
            showNotification('✅ Account created! Please login.', 'success');
            resetCaptcha();
            state.page = 'login';
            render();
        } catch (error) {
            showError(error.message);
            resetCaptcha();
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-user-plus"></i> Create Account';
        }
    });

    document.getElementById('aadsBannerClose')?.addEventListener('click', () => {
        resetAdState(false);
        const banner = document.getElementById('aadsBanner');
        if (banner) banner.style.display = 'none';
        updateRedeemButton();
    });
}

// ============ FORGOT PASSWORD ============
async function forgotPassword() {
    const email = prompt('Enter your email address:');
    if (!email) return;
    try {
        const res = await fetch(`${API_URL}/auth/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to send reset link');
        showNotification('📧 Password reset link sent!', 'success');
    } catch (error) {
        showNotification('❌ ' + error.message, 'error');
    }
}

// ============ COPY REFERRAL ============
function copyReferral() {
    const code = document.querySelector('.referral-code code')?.textContent;
    if (code) {
        navigator.clipboard?.writeText(`${window.location.origin}/?ref=${code}`).then(() => {
            showNotification('✅ Referral link copied!', 'success');
        }).catch(() => {
            const input = document.createElement('input');
            input.value = `${window.location.origin}/?ref=${code}`;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            showNotification('✅ Referral link copied!', 'success');
        });
    }
}

// ============ DAILY BONUS ============
async function claimDailyBonus() {
    try {
        const btn = document.getElementById('dailyBonusBtn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
        const res = await api.post('/daily-bonus', {});
        if (res.error) throw new Error(res.error);
        state.points = res.newTotal;
        state.streak = res.streak;
        await fetchPoints();
        showNotification(res.message, 'success');
        updateStats();
        updateRedeemButton();
    } catch (error) {
        showNotification('❌ ' + (error.message || 'Failed to claim daily bonus'), 'error');
    } finally {
        const btn = document.getElementById('dailyBonusBtn');
        btn.disabled = false;
        btn.innerHTML = '🎁 Daily Bonus';
    }
}

// ============ LEADERBOARD ============
async function showLeaderboard() {
    try {
        const res = await api.get('/leaderboard?limit=10');
        if (res.error) throw new Error(res.error);
        let html = '<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;background:var(--bg-card);border:1px solid var(--border-color);border-radius:var(--radius-xl);padding:32px;max-width:400px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:var(--shadow);">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;"><h2 style="font-size:24px;font-weight:700;">🏆 Leaderboard</h2><button onclick="this.parentElement.parentElement.remove()" style="background:none;border:none;color:var(--text-tertiary);font-size:24px;cursor:pointer;">✕</button></div>';
        html += '<div style="display:flex;flex-direction:column;gap:8px;">';
        res.leaderboard.forEach((user, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
            html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--bg-input);border-radius:var(--radius-md);">
                <span style="font-weight:600;">${medal} ${user.username}</span>
                <span style="font-weight:700;color:var(--primary);">${user.points} pts</span>
            </div>`;
        });
        html += '</div></div>';
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);';
        overlay.onclick = () => { overlay.remove(); };
        document.body.appendChild(overlay);
        const temp = document.createElement('div');
        temp.innerHTML = html;
        document.body.appendChild(temp.firstElementChild);
    } catch (error) {
        showNotification('❌ Failed to load leaderboard', 'error');
    }
}

// ============ DASHBOARD ACTIONS ============

// ====== WATCH AD ======
async function watchAd() {
    const btn = document.getElementById('watchBtn');
    const msg = document.getElementById('adMessage');
    if (isAdWatching) { showNotification('⏳ Please wait', 'warning'); return; }
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Loading...';
    msg.textContent = '';
    msg.className = 'action-message';
    try {
        const startRes = await api.post('/ad/start', {});
        if (startRes.error) throw new Error(startRes.error);
        currentAdSessionId = startRes.sessionId;
        localStorage.setItem('adSessionId', currentAdSessionId);
        const banner = document.getElementById('aadsBanner');
        if (banner) {
            if (banner.style.display === 'none') {
                banner.style.display = 'block';
            }
            banner.classList.add('expanded');
        }
        isAdWatching = true;
        isAdVisible = false;
        isAdCompletedCalled = false;
        btn.innerHTML = '<span class="spinner"></span> Scroll to ad...';
        msg.textContent = '📜 Please scroll down to view the ad';
        msg.className = 'action-message info';
        initAdObserver();
    } catch (error) {
        console.error('❌ Ad watch error:', error);
        msg.textContent = '❌ ' + (error.message || 'Failed to watch ad');
        msg.className = 'action-message error';
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-play"></i> Watch Ad (+10 pts)';
    }
}

// ====== ON AD COMPLETED (Fix: reload ad after completion) ======
async function onAdCompleted() {
    try {
        const sessionId = currentAdSessionId || localStorage.getItem('adSessionId');
        if (!sessionId) { showNotification('❌ No session found', 'error'); resetAdState(false); return; }
        const verifyRes = await api.post('/ad/verify', {
            sessionId: sessionId,
            watchDuration: 15000,
            adId: 'aads_2451472'
        });
        if (verifyRes.error) throw new Error(verifyRes.error);
        state.points = verifyRes.newTotal;
        await fetchPoints();
        addLog('🎯 +10 points from ad');
        showNotification('✅ +10 points earned!', 'success');
        updateStats();
        updateRedeemButton();
        // Reset ad state but KEEP banner visible and reload iframe
        resetAdState(true);
        // Reload iframe để tải ad mới
        const iframe = document.getElementById('aadsIframe');
        if (iframe) {
            iframe.src = iframe.src;
        }
        // Reset progress and status
        const status = document.getElementById('aadsStatus');
        if (status) {
            status.textContent = '⏳ Click "Watch Ad" to start';
            status.style.color = '';
        }
        const progress = document.getElementById('aadsProgress');
        if (progress) {
            progress.style.width = '0%';
        }
    } catch (error) {
        console.error('❌ Ad verify error:', error);
        showNotification('❌ ' + error.message, 'error');
        resetAdState(false);
    }
}

// ====== REDEEM ======
async function redeem() {
    const pointsInput = document.getElementById('redeemPoints');
    const walletInput = document.getElementById('redeemWallet');
    const msg = document.getElementById('redeemMessage');
    const btn = document.getElementById('redeemBtn');
    const points = parseInt(pointsInput.value) || 50;
    const wallet = walletInput.value.trim();
    if (state.points < 50) { msg.textContent = '❌ Need at least 50 points'; msg.className = 'action-message error'; return; }
    if (points < 50) { msg.textContent = '❌ Minimum 50 points'; msg.className = 'action-message error'; return; }
    if (points > state.points) { msg.textContent = `❌ You have ${state.points} points`; msg.className = 'action-message error'; return; }
    if (!wallet) { msg.textContent = '❌ Enter your Nano wallet'; msg.className = 'action-message error'; return; }
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    msg.textContent = '';
    msg.className = 'action-message';
    try {
        const res = await api.post('/redeem', { points, walletAddress: wallet });
        if (res.error) throw new Error(res.error);
        state.points = state.points - points;
        await fetchPoints();
        msg.textContent = `✅ Redeemed ${points} pts → ${res.xnoAmount} XNO!`;
        msg.className = 'action-message success';
        addLog(`🔄 Redeemed ${points} pts → ${res.xnoAmount} XNO`);
        showNotification(`✅ Redeemed ${res.xnoAmount} XNO`, 'success');
        updateStats();
        updateRedeemButton();
        walletInput.value = '';
    } catch (error) {
        msg.textContent = '❌ ' + (error.message || 'Failed to redeem');
        msg.className = 'action-message error';
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-exchange-alt"></i> Redeem';
    }
}

async function fetchPoints() {
    try {
        const data = await api.get('/points');
        if (!data.error) {
            state.points = data.points;
            state.stats = data.stats;
            updateRedeemButton();
        }
    } catch (error) {
        console.error('Failed to fetch points:', error);
        if (error.message.includes('Session expired')) logout();
    }
}

function updateStats() {
    const pointsEl = document.getElementById('pointsDisplay');
    if (pointsEl) pointsEl.textContent = state.points.toLocaleString();
    const xnoEl = document.querySelector('.stat-card.success .stat-value');
    if (xnoEl) xnoEl.textContent = (state.stats.totalEarned / 50 * 0.1).toFixed(4);
    const adsEl = document.querySelector('.stat-card.warning .stat-value');
    if (adsEl) adsEl.textContent = state.stats.totalWatched;
    const progressEl = document.querySelector('.stat-card.purple .fill');
    const progressText = document.querySelector('.stat-card.purple .progress-text');
    if (progressEl) {
        const progress = Math.min((state.stats.dailyUsed / state.stats.dailyLimit * 100), 100);
        progressEl.style.width = progress + '%';
    }
    if (progressText) progressText.textContent = `${state.stats.dailyUsed}/${state.stats.dailyLimit}`;
    const heroPoints = document.querySelector('.hero-stats .stat-item:first-child .value');
    if (heroPoints) heroPoints.textContent = state.points;
    const heroXno = document.querySelector('.hero-stats .stat-item:nth-child(2) .value');
    if (heroXno) heroXno.textContent = (state.stats.totalEarned / 50 * 0.1).toFixed(4);
    const heroAds = document.querySelector('.hero-stats .stat-item:nth-child(3) .value');
    if (heroAds) heroAds.textContent = state.stats.totalWatched;
    const { level, xp, nextLevelXp } = calculateLevel(state.points);
    const levelBadge = document.querySelector('.level-badge');
    if (levelBadge) levelBadge.textContent = `🏆 Level ${level}`;
    const levelProgress = document.querySelector('.hero-section .daily-progress .fill');
    if (levelProgress) levelProgress.style.width = Math.min((xp / nextLevelXp) * 100, 100) + '%';
    const levelText = document.querySelector('.hero-section .daily-progress ~ div span:first-child');
    if (levelText) levelText.textContent = `Level ${level} (${xp}/${nextLevelXp} XP)`;
}

function addLog(msg) {
    const log = document.getElementById('log');
    if (log) {
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `<span class="time">${new Date().toLocaleTimeString()}</span> ${msg}`;
        log.prepend(entry);
        while (log.children.length > 100) log.removeChild(log.lastChild);
    }
}

function clearLog() {
    const log = document.getElementById('log');
    if (log) log.innerHTML = `<div class="log-entry" style="color:var(--text-tertiary);"><span class="time">—</span> Log cleared</div>`;
}

function logout() {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    state.user = null;
    showNotification('👋 Logged out', 'info');
    render();
}

function showError(msg) {
    const el = document.getElementById('error');
    if (el) { el.textContent = msg; el.className = 'auth-error show'; }
}

// ============ BOOT ============
async function init() {
    loadTheme();
    const token = localStorage.getItem('accessToken');
    if (token) {
        try {
            const data = await api.get('/auth/me');
            if (!data.error) {
                state.user = data.user;
                await fetchPoints();
                const streakRes = await api.get('/streak');
                if (!streakRes.error) state.streak = streakRes.streak || 0;
            }
        } catch (error) {
            localStorage.removeItem('accessToken');
            localStorage.removeItem('refreshToken');
        }
    }
    render();
}

window.state = state;
window.render = render;
window.watchAd = watchAd;
window.redeem = redeem;
window.logout = logout;
window.clearLog = clearLog;
window.addLog = addLog;
window.updateStats = updateStats;
window.forgotPassword = forgotPassword;
window.updateRedeemButton = updateRedeemButton;
window.toggleTheme = toggleTheme;
window.copyReferral = copyReferral;
window.claimDailyBonus = claimDailyBonus;
window.showLeaderboard = showLeaderboard;

document.addEventListener('DOMContentLoaded', init);
console.log('🚀 XNO Rewards App Loaded');
