"""
Blue Chip Signals Backend - Flask Version
Simple and reliable backend for managing trading signals
"""

from flask import Flask, request, jsonify, render_template_string, redirect, session, make_response
from flask_cors import CORS
from datetime import datetime
import sqlite3
import json
import re
import os
from functools import wraps

import firebase_admin
from firebase_admin import credentials, firestore as fs_admin

app = Flask(__name__)
app.secret_key = 'bluechip-signals-secret-key-change-in-production'
CORS(app, resources={r"/api/*": {"origins": "*"}})

# ── Firebase Admin SDK ──────────────────────────────────────────────────────
# Set FIREBASE_SERVICE_ACCOUNT_JSON in Railway env vars as the full JSON string
# of a Firebase service-account key file.  If the var is missing the app still
# works — Firestore writes are silently skipped.
_firestore_client = None
try:
    _sa_json = os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '')
    if _sa_json:
        _sa_dict = json.loads(_sa_json)
        _cred = credentials.Certificate(_sa_dict)
        firebase_admin.initialize_app(_cred)
        _firestore_client = fs_admin.client()
        print('[BCS] Firebase Admin SDK initialised — Firestore writes enabled.')
    else:
        print('[BCS] FIREBASE_SERVICE_ACCOUNT_JSON not set — Firestore writes disabled.')
except Exception as _e:
    print(f'[BCS] Firebase Admin SDK init failed: {_e}')

# Initialize database
def init_db():
    conn = sqlite3.connect('signals.db')
    c = conn.cursor()
    
    c.execute('''
        CREATE TABLE IF NOT EXISTS signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stock TEXT NOT NULL,
            price REAL NOT NULL,
            vwap REAL NOT NULL,
            mfi REAL NOT NULL,
            contract_type TEXT NOT NULL,
            strike_price REAL NOT NULL,
            premium REAL NOT NULL,
            expiration TEXT NOT NULL,
            volume INTEGER,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    conn.commit()
    conn.close()

init_db()


def insert_signal(stock, price, vwap, mfi, contract_type, strike_price, premium, expiration, volume=0):
    """
    Write one signal to SQLite (always) and Firestore (if SDK is initialised).
    Returns the new SQLite row id.
    """
    conn = sqlite3.connect('signals.db')
    c = conn.cursor()
    c.execute(
        '''INSERT INTO signals
           (stock, price, vwap, mfi, contract_type, strike_price, premium, expiration, volume)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (stock, price, vwap, mfi, contract_type, strike_price, premium, expiration, volume)
    )
    conn.commit()
    signal_id = c.lastrowid
    conn.close()

    # Mirror to Firestore for the historical signals page
    if _firestore_client:
        try:
            _firestore_client.collection('signals').add({
                'stock':        stock,
                'price':        price,
                'vwap':         vwap,
                'mfi':          mfi,
                'contractType': contract_type,
                'strike':       strike_price,
                'premium':      premium,
                'expiration':   expiration,
                'volume':       volume,
                'timestamp':    fs_admin.SERVER_TIMESTAMP,
            })
        except Exception as _fe:
            print(f'[BCS] Firestore write failed (non-fatal): {_fe}')

    return signal_id


# Admin authentication decorator
def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('admin_logged_in'):
            return redirect('/admin/login')
        return f(*args, **kwargs)
    return decorated_function

# ============================================
# API ENDPOINTS
# ============================================

@app.route('/')
def home():
    return jsonify({
        'status': 'online',
        'service': 'Blue Chip Signals Backend',
        'version': '1.0.0'
    })

@app.route('/api/signals/new', methods=['POST'])
def create_signal():
    try:
        data = request.get_json()
        
        required = ['stock', 'price', 'vwap', 'mfi', 'contract']
        if not all(field in data for field in required):
            return jsonify({'error': 'Missing required fields'}), 400
        
        contract = data['contract']

        signal_id = insert_signal(
            stock=data['stock'],
            price=data['price'],
            vwap=data['vwap'],
            mfi=data['mfi'],
            contract_type=contract['type'],
            strike_price=contract['strike'],
            premium=contract['premium'],
            expiration=contract['expiration'],
            volume=contract.get('volume', 0),
        )

        return jsonify({
            'success': True,
            'signal_id': signal_id,
            'message': f'Signal for {data["stock"]} saved successfully'
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/signals/latest')
def get_latest_signals():
    limit = request.args.get('limit', 50, type=int)
    
    conn = sqlite3.connect('signals.db')
    c = conn.cursor()
    
    c.execute('''
        SELECT id, stock, price, vwap, mfi, 
               contract_type, strike_price, premium, expiration, volume,
               timestamp
        FROM signals 
        ORDER BY timestamp DESC 
        LIMIT ?
    ''', (limit,))
    
    signals = []
    for row in c.fetchall():
        signals.append({
            'id': row[0],
            'stock': row[1],
            'price': row[2],
            'vwap': row[3],
            'mfi': row[4],
            'contract': {
                'type': row[5],
                'strike': row[6],
                'premium': row[7],
                'expiration': row[8],
                'volume': row[9]
            },
            'timestamp': row[10]
        })
    
    conn.close()
    return jsonify({'signals': signals})

@app.route('/api/signals/<int:signal_id>', methods=['DELETE'])
def delete_signal(signal_id):
    try:
        conn = sqlite3.connect('signals.db')
        c = conn.cursor()
        c.execute('DELETE FROM signals WHERE id = ?', (signal_id,))
        deleted = c.rowcount
        conn.commit()
        conn.close()
        if deleted == 0:
            return jsonify({'error': 'Signal not found'}), 404
        return jsonify({'success': True, 'deleted_id': signal_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/signals/all', methods=['DELETE'])
def delete_all_signals():
    try:
        conn = sqlite3.connect('signals.db')
        c = conn.cursor()
        c.execute('DELETE FROM signals')
        deleted = c.rowcount
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'deleted_count': deleted})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ============================================
# TELEGRAM WEBHOOK
# ============================================

def parse_signal_message(text):
    """
    Parse a signal message in the format sent by all 6 bots, e.g.:
        🚨 SPY Buy Signal [Breakout]
        Price: $592.10
        VWAP: $589.45
        MFI: 67.32
        Suggested Contract:
        Ticker: SPY
        C/P: Call
        Strike Price: $595.00
        Premium: $3.20
        Volume: 142300
        Exp: 2026-03-10
    Returns a dict ready to insert, or None if parsing fails.
    """
    try:
        stock   = re.search(r'(\w+)\s+(?:Buy|Sell)\s+Signal', text)
        price   = re.search(r'Price:\s*\$?([\d.]+)', text)
        vwap    = re.search(r'VWAP:\s*\$?([\d.]+)', text)
        mfi     = re.search(r'MFI:\s*([\d.]+)', text)
        cp      = re.search(r'C/P:\s*(\w+)', text)
        strike  = re.search(r'Strike Price:\s*\$?([\d.]+)', text)
        premium = re.search(r'Premium:\s*\$?([\d.]+)', text)
        volume  = re.search(r'Volume:\s*([\d]+)', text)
        exp     = re.search(r'Exp:\s*(\S+)', text)

        if not all([stock, price, vwap, mfi, cp, strike, premium, exp]):
            return None

        contract_type = cp.group(1).strip()
        if contract_type.lower() == 'call':
            contract_type = 'Call'
        elif contract_type.lower() == 'put':
            contract_type = 'Put'

        return {
            'stock':         stock.group(1).upper(),
            'price':         float(price.group(1)),
            'vwap':          float(vwap.group(1)),
            'mfi':           float(mfi.group(1)),
            'contract_type': contract_type,
            'strike_price':  float(strike.group(1)),
            'premium':       float(premium.group(1)),
            'expiration':    exp.group(1),
            'volume':        int(volume.group(1)) if volume else 0,
        }
    except Exception:
        return None


@app.route('/telegram/webhook', methods=['POST'])
def telegram_webhook():
    # Verify secret token set in Railway env vars
    webhook_secret = os.environ.get('TELEGRAM_WEBHOOK_SECRET', '')
    if webhook_secret:
        incoming = request.headers.get('X-Telegram-Bot-Api-Secret-Token', '')
        if incoming != webhook_secret:
            return jsonify({'error': 'Unauthorized'}), 401

    update = request.get_json(silent=True)
    if not update:
        return jsonify({'ok': True})

    # channel_post is the update type for messages the bot sends to a channel
    post = update.get('channel_post') or update.get('message')
    if not post:
        return jsonify({'ok': True})

    text = post.get('text', '')
    if not text or 'Buy Signal' not in text:
        return jsonify({'ok': True})

    signal = parse_signal_message(text)
    if not signal:
        return jsonify({'ok': True, 'note': 'Message received but could not be parsed'})

    try:
        signal_id = insert_signal(
            stock=signal['stock'],
            price=signal['price'],
            vwap=signal['vwap'],
            mfi=signal['mfi'],
            contract_type=signal['contract_type'],
            strike_price=signal['strike_price'],
            premium=signal['premium'],
            expiration=signal['expiration'],
            volume=signal['volume'],
        )
        return jsonify({'ok': True, 'signal_id': signal_id})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


# ============================================
# ADMIN PANEL
# ============================================

@app.route('/admin/login', methods=['GET', 'POST'])
def admin_login():
    if request.method == 'POST':
        password = request.form.get('password')
        if password == 'Pumrvb12!':
            session['admin_logged_in'] = True
            return redirect('/admin')
        else:
            return render_template_string(ADMIN_LOGIN_HTML, error=True)
    
    return render_template_string(ADMIN_LOGIN_HTML, error=False)

@app.route('/admin/logout')
def admin_logout():
    session.pop('admin_logged_in', None)
    return redirect('/admin/login')

@app.route('/admin')
@admin_required
def admin_dashboard():
    conn = sqlite3.connect('signals.db')
    c = conn.cursor()
    
    c.execute('SELECT COUNT(*) FROM signals')
    total_signals = c.fetchone()[0]
    
    c.execute('SELECT COUNT(*) FROM signals WHERE DATE(timestamp) = DATE("now")')
    signals_today = c.fetchone()[0]
    
    c.execute('''
        SELECT id, stock, price, vwap, mfi, contract_type, strike_price, 
               premium, expiration, timestamp 
        FROM signals 
        ORDER BY timestamp DESC 
        LIMIT 20
    ''')
    recent_signals = c.fetchall()
    
    conn.close()
    
    return render_template_string(ADMIN_DASHBOARD_HTML, 
                                   total_signals=total_signals,
                                   signals_today=signals_today,
                                   recent_signals=recent_signals)

@app.route('/admin/demo-accounts', methods=['GET', 'POST'])
@admin_required
def demo_accounts():
    message = None
    error   = None

    if request.method == 'POST':
        action = request.form.get('action', '').strip()
        email  = request.form.get('email', '').strip().lower()

        if not email:
            error = 'Please enter an email address.'
        elif not _firestore_client:
            error = 'Firestore is not configured on this server (FIREBASE_SERVICE_ACCOUNT_JSON missing).'
        else:
            try:
                import firebase_admin.auth as fb_auth
                user_record = fb_auth.get_user_by_email(email)
                uid = user_record.uid
                if action == 'add':
                    _firestore_client.collection('users').document(uid).set(
                        {
                            'isDemo':             True,
                            'setupCompleted':     True,
                            'plan':               'bundle',
                            'subscriptionStatus': 'Active',
                        },
                        merge=True
                    )
                    message = f'✓ {email} is now a demo account.'
                elif action == 'remove':
                    _firestore_client.collection('users').document(uid).set(
                        {'isDemo': False},
                        merge=True
                    )
                    message = f'✓ Demo status removed from {email}.'
                else:
                    error = 'Unknown action.'
            except Exception as e:
                error = f'Error: {e}'

    # Fetch current demo accounts
    demo_users = []
    if _firestore_client:
        try:
            docs = _firestore_client.collection('users').where('isDemo', '==', True).stream()
            for d in docs:
                data = d.to_dict()
                # Try to resolve a display email via Firebase Auth
                try:
                    import firebase_admin.auth as fb_auth
                    u = fb_auth.get_user(d.id)
                    demo_users.append({'email': u.email or d.id, 'uid': d.id})
                except Exception:
                    demo_users.append({'email': data.get('email', d.id), 'uid': d.id})
        except Exception as e:
            error = (error or '') + f' (list fetch error: {e})'

    return render_template_string(DEMO_ACCOUNTS_HTML,
                                  demo_users=demo_users,
                                  message=message,
                                  error=error)


@app.route('/admin/post-signal', methods=['GET', 'POST'])
@admin_required
def post_signal():
    if request.method == 'POST':
        conn = sqlite3.connect('signals.db')
        c = conn.cursor()
        c.execute('''
            INSERT INTO signals 
            (stock, price, vwap, mfi, contract_type, strike_price, premium, expiration, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            request.form['stock'],
            float(request.form['price']),
            float(request.form['vwap']),
            float(request.form['mfi']),
            request.form['contract_type'],
            float(request.form['strike']),
            float(request.form['premium']),
            request.form['expiration'],
            int(request.form.get('volume', 0))
        ))
        conn.commit()
        conn.close()
        
        return redirect('/admin')
    
    return render_template_string(POST_SIGNAL_HTML)

# ============================================
# HTML TEMPLATES
# ============================================

ADMIN_LOGIN_HTML = '''
<!DOCTYPE html>
<html>
<head>
    <title>Admin Login - Blue Chip Signals</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0e27;
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }
        .login-box {
            background: rgba(26, 31, 46, 0.8);
            border: 1px solid rgba(179, 161, 125, 0.3);
            border-radius: 16px;
            padding: 3rem;
            width: 100%;
            max-width: 400px;
        }
        h1 {
            color: #b3a17d;
            margin-bottom: 2rem;
            text-align: center;
        }
        input {
            width: 100%;
            padding: 1rem;
            background: rgba(179, 161, 125, 0.1);
            border: 1px solid rgba(179, 161, 125, 0.3);
            border-radius: 8px;
            color: #fff;
            margin-bottom: 1rem;
            font-size: 1rem;
        }
        input:focus {
            outline: none;
            border-color: #b3a17d;
        }
        button {
            width: 100%;
            padding: 1rem;
            background: linear-gradient(135deg, #b3a17d, #E2CFB5);
            color: #000;
            border: none;
            border-radius: 8px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
        }
        button:hover {
            transform: translateY(-2px);
        }
        .error {
            color: #ff3b3b;
            margin-bottom: 1rem;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="login-box">
        <h1>Admin Login</h1>
        {% if error %}
        <p class="error">Invalid password. Please try again.</p>
        {% endif %}
        <form method="POST">
            <input type="password" name="password" placeholder="Enter admin password" required>
            <button type="submit">Login</button>
        </form>
    </div>
</body>
</html>
'''

ADMIN_DASHBOARD_HTML = '''
<!DOCTYPE html>
<html>
<head>
    <title>Admin Dashboard - Blue Chip Signals</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0e27;
            color: #fff;
            padding: 2rem;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
        }
        h1 { color: #b3a17d; }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }
        .stat-card {
            background: rgba(179, 161, 125, 0.1);
            border: 1px solid rgba(179, 161, 125, 0.3);
            border-radius: 10px;
            padding: 1.5rem;
        }
        .stat-value {
            font-size: 2rem;
            font-weight: bold;
            color: #b3a17d;
        }
        .stat-label {
            color: #aaa;
            font-size: 0.9rem;
        }
        .signals-table {
            background: rgba(26, 31, 46, 0.5);
            border-radius: 10px;
            padding: 1.5rem;
            overflow-x: auto;
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            padding: 1rem;
            text-align: left;
            border-bottom: 1px solid rgba(179, 161, 125, 0.2);
        }
        th {
            color: #b3a17d;
            font-weight: 600;
        }
        .btn {
            padding: 0.6rem 1.2rem;
            background: linear-gradient(135deg, #b3a17d, #E2CFB5);
            color: #000;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
            font-weight: 600;
        }
        .btn:hover {
            transform: translateY(-2px);
        }
        .logout-btn {
            background: rgba(255, 59, 59, 0.2);
            color: #ff3b3b;
            border: 1px solid #ff3b3b;
        }
        .danger-btn {
            background: rgba(255, 59, 59, 0.15);
            color: #ff3b3b;
            border: 1px solid rgba(255,59,59,0.4);
            padding: 0.35rem 0.75rem;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.8rem;
            font-weight: 600;
        }
        .danger-btn:hover { background: rgba(255,59,59,0.28); }
        .stock-badge {
            padding: 0.3rem 0.8rem;
            border-radius: 5px;
            font-weight: bold;
            font-size: 0.9rem;
        }
        .stock-tsla { background: #E82127; }
        .stock-meta { background: #1877F2; }
        .stock-aapl { background: #999999; }
        .stock-spy { background: #b3a17d; color: #000; }
        .stock-nvda { background: #76B900; }
        .stock-amzn { background: #FF9900; }
        .clear-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Admin Dashboard</h1>
        <div>
            <a href="/admin/post-signal" class="btn" style="margin-right: 0.75rem;">Post Signal</a>
            <a href="/admin/demo-accounts" class="btn" style="margin-right: 0.75rem; background: rgba(201,176,55,0.15); color: #c9b037; border: 1px solid rgba(201,176,55,0.4);">Demo Accounts</a>
            <a href="/admin/logout" class="btn logout-btn">Logout</a>
        </div>
    </div>
    
    <div class="stats">
        <div class="stat-card">
            <div class="stat-value">{{ total_signals }}</div>
            <div class="stat-label">Total Signals</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">{{ signals_today }}</div>
            <div class="stat-label">Signals Today</div>
        </div>
    </div>
    
    <div class="signals-table">
        <div class="clear-bar">
            <h2 style="color: #b3a17d;">Recent Signals</h2>
            <button class="danger-btn" onclick="clearAllSignals()">🗑 Clear All Signals</button>
        </div>
        <table>
            <thead>
                <tr>
                    <th>Stock</th>
                    <th>Price</th>
                    <th>VWAP</th>
                    <th>MFI</th>
                    <th>Contract</th>
                    <th>Strike</th>
                    <th>Premium</th>
                    <th>Time</th>
                    <th></th>
                </tr>
            </thead>
            <tbody id="signals-tbody">
                {% for signal in recent_signals %}
                <tr id="row-{{ signal[0] }}">
                    <td><span class="stock-badge stock-{{ signal[1]|lower }}">{{ signal[1] }}</span></td>
                    <td>${{ "%.2f"|format(signal[2]) }}</td>
                    <td>${{ "%.2f"|format(signal[3]) }}</td>
                    <td>{{ "%.2f"|format(signal[4]) }}</td>
                    <td>{{ signal[5] }}</td>
                    <td>${{ "%.2f"|format(signal[6]) }}</td>
                    <td>${{ "%.2f"|format(signal[7]) }}</td>
                    <td>{{ signal[9].split('.')[0] if '.' in signal[9] else signal[9] }}</td>
                    <td><button class="danger-btn" onclick="deleteSignal({{ signal[0] }})">Delete</button></td>
                </tr>
                {% endfor %}
            </tbody>
        </table>
    </div>
    <script>
        async function deleteSignal(id) {
            if (!confirm('Delete signal #' + id + '?')) return;
            const res = await fetch('/api/signals/' + id, { method: 'DELETE' });
            if (res.ok) {
                document.getElementById('row-' + id)?.remove();
            } else {
                alert('Failed to delete signal.');
            }
        }
        async function clearAllSignals() {
            if (!confirm('Delete ALL signals? This cannot be undone.')) return;
            const res = await fetch('/api/signals/all', { method: 'DELETE' });
            if (res.ok) {
                document.getElementById('signals-tbody').innerHTML =
                    '<tr><td colspan="9" style="color:#aaa;text-align:center;padding:1.5rem;">No signals</td></tr>';
            } else {
                alert('Failed to clear signals.');
            }
        }
    </script>
</body>
</html>
'''

DEMO_ACCOUNTS_HTML = '''
<!DOCTYPE html>
<html>
<head>
    <title>Demo Accounts - Admin</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #0a0e27; color: #fff; padding: 2rem;
        }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
        h1 { color: #b3a17d; }
        .btn {
            padding: 0.6rem 1.2rem;
            background: linear-gradient(135deg, #b3a17d, #E2CFB5);
            color: #000; border: none; border-radius: 8px;
            cursor: pointer; text-decoration: none;
            display: inline-block; font-weight: 600;
        }
        .btn:hover { transform: translateY(-2px); }
        .btn-ghost {
            background: rgba(179,161,125,0.12);
            color: #b3a17d;
            border: 1px solid rgba(179,161,125,0.35);
        }
        .logout-btn { background: rgba(255,59,59,0.2); color: #ff3b3b; border: 1px solid #ff3b3b; }
        .card {
            background: rgba(26,31,46,0.7);
            border: 1px solid rgba(179,161,125,0.2);
            border-radius: 12px; padding: 1.75rem; margin-bottom: 1.5rem;
        }
        h2 { color: #b3a17d; margin-bottom: 1rem; font-size: 1rem; text-transform: uppercase; letter-spacing: 0.06em; }
        .form-row { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
        input[type="email"] {
            flex: 1; min-width: 220px;
            padding: 0.7rem 1rem;
            background: rgba(179,161,125,0.08);
            border: 1px solid rgba(179,161,125,0.3);
            border-radius: 8px; color: #fff; font-size: 0.95rem;
        }
        input[type="email"]:focus { outline: none; border-color: #b3a17d; }
        .msg-success {
            background: rgba(46,125,50,0.15); border: 1px solid rgba(76,175,80,0.3);
            color: #81c784; border-radius: 8px; padding: 0.7rem 1rem; margin-bottom: 1rem;
        }
        .msg-error {
            background: rgba(255,59,59,0.12); border: 1px solid rgba(255,59,59,0.3);
            color: #ff6b6b; border-radius: 8px; padding: 0.7rem 1rem; margin-bottom: 1rem;
        }
        .demo-list { display: flex; flex-direction: column; gap: 0.6rem; }
        .demo-row {
            display: flex; align-items: center; justify-content: space-between;
            background: rgba(201,176,55,0.07); border: 1px solid rgba(201,176,55,0.2);
            border-radius: 8px; padding: 0.75rem 1rem; gap: 1rem;
        }
        .demo-email { color: #c9b037; font-weight: 600; font-size: 0.9rem; }
        .demo-uid   { color: rgba(255,255,255,0.3); font-size: 0.72rem; font-family: monospace; }
        .remove-btn {
            background: rgba(255,59,59,0.12); color: #ff6b6b;
            border: 1px solid rgba(255,59,59,0.3); border-radius: 6px;
            padding: 0.3rem 0.8rem; cursor: pointer; font-size: 0.8rem; font-weight: 600;
            white-space: nowrap;
        }
        .remove-btn:hover { background: rgba(255,59,59,0.25); }
        .empty { color: rgba(255,255,255,0.3); font-size: 0.88rem; padding: 0.5rem 0; }
        .note { color: rgba(255,255,255,0.35); font-size: 0.78rem; margin-top: 0.75rem; line-height: 1.5; }
    </style>
</head>
<body>
    <div class="header">
        <h1><i class="fas fa-eye" style="color:#c9b037;margin-right:0.5rem;"></i> Demo Accounts</h1>
        <div>
            <a href="/admin/post-signal" class="btn btn-ghost" style="margin-right:0.75rem;">Post Signal</a>
            <a href="/admin" class="btn btn-ghost" style="margin-right:0.75rem;">Dashboard</a>
            <a href="/admin/logout" class="btn logout-btn">Logout</a>
        </div>
    </div>

    {% if message %}
    <div class="msg-success"><i class="fas fa-circle-check"></i> {{ message }}</div>
    {% endif %}
    {% if error %}
    <div class="msg-error"><i class="fas fa-circle-exclamation"></i> {{ error }}</div>
    {% endif %}

    <!-- Add demo account -->
    <div class="card">
        <h2>Make an Account a Demo</h2>
        <form method="POST" class="form-row">
            <input type="email" name="email" placeholder="user@example.com" required>
            <input type="hidden" name="action" value="add">
            <button type="submit" class="btn">Make Demo</button>
        </form>
        <p class="note">
            <i class="fas fa-circle-info"></i>
            The account must already exist in Firebase Auth.
            This sets <code>isDemo: true</code>, <code>plan: bundle</code>, and <code>subscriptionStatus: Active</code>
            on their Firestore document so they see mock data on all pages.
        </p>
    </div>

    <!-- Current demo accounts -->
    <div class="card">
        <h2>Current Demo Accounts</h2>
        {% if demo_users %}
        <div class="demo-list">
            {% for u in demo_users %}
            <div class="demo-row">
                <div>
                    <div class="demo-email"><i class="fas fa-eye" style="font-size:0.75rem;margin-right:0.4rem;"></i>{{ u.email }}</div>
                    <div class="demo-uid">uid: {{ u.uid }}</div>
                </div>
                <form method="POST" style="margin:0;">
                    <input type="hidden" name="email" value="{{ u.email }}">
                    <input type="hidden" name="action" value="remove">
                    <button type="submit" class="remove-btn" onclick="return confirm(\'Remove demo status from {{ u.email }}?\')">
                        <i class="fas fa-xmark"></i> Remove
                    </button>
                </form>
            </div>
            {% endfor %}
        </div>
        {% else %}
        <p class="empty">No demo accounts configured yet.</p>
        {% endif %}
    </div>
</body>
</html>
'''

POST_SIGNAL_HTML = '''
<!DOCTYPE html>
<html>
<head>
    <title>Post Signal - Admin</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0e27;
            color: #fff;
            padding: 2rem;
        }
        .container { max-width: 800px; margin: 0 auto; }
        h1 { color: #b3a17d; margin-bottom: 2rem; }
        .form-group { margin-bottom: 1.5rem; }
        label { display: block; margin-bottom: 0.5rem; color: #b3a17d; }
        input, select {
            width: 100%;
            padding: 0.8rem;
            background: rgba(179, 161, 125, 0.1);
            border: 1px solid rgba(179, 161, 125, 0.3);
            border-radius: 8px;
            color: #fff;
            font-size: 1rem;
        }
        button {
            padding: 1rem 2rem;
            background: linear-gradient(135deg, #b3a17d, #E2CFB5);
            color: #000;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
        }
        .back-btn {
            background: rgba(179, 161, 125, 0.2);
            color: #b3a17d;
            margin-left: 1rem;
            text-decoration: none;
            display: inline-block;
            padding: 1rem 2rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Post New Signal</h1>
        <form method="POST">
            <div class="form-group">
                <label for="stock">Stock Symbol</label>
                <select name="stock" id="stock" required>
                    <option value="SPY">SPY</option>
                    <option value="TSLA">TSLA</option>
                    <option value="META">META</option>
                    <option value="AAPL">AAPL</option>
                    <option value="NVDA">NVDA</option>
                    <option value="AMZN">AMZN</option>
                </select>
            </div>
            <div class="form-group">
                <label for="price">Price</label>
                <input type="number" step="0.01" name="price" id="price" required>
            </div>
            <div class="form-group">
                <label for="vwap">VWAP</label>
                <input type="number" step="0.01" name="vwap" id="vwap" required>
            </div>
            <div class="form-group">
                <label for="mfi">MFI</label>
                <input type="number" step="0.01" name="mfi" id="mfi" required>
            </div>
            <div class="form-group">
                <label for="contract_type">Contract Type</label>
                <select name="contract_type" id="contract_type" required>
                    <option value="Call">Call</option>
                    <option value="Put">Put</option>
                </select>
            </div>
            <div class="form-group">
                <label for="strike">Strike Price</label>
                <input type="number" step="0.01" name="strike" id="strike" required>
            </div>
            <div class="form-group">
                <label for="premium">Premium</label>
                <input type="number" step="0.01" name="premium" id="premium" required>
            </div>
            <div class="form-group">
                <label for="expiration">Expiration (YYYY-MM-DD)</label>
                <input type="date" name="expiration" id="expiration" required>
            </div>
            <div class="form-group">
                <label for="volume">Volume (Optional)</label>
                <input type="number" name="volume" id="volume" placeholder="0">
            </div>
            <button type="submit">Post Signal</button>
            <a href="/admin" class="back-btn">Back to Dashboard</a>
        </form>
    </div>
</body>
</html>
'''

if __name__ == '__main__':
    import os
    port = int(os.environ.get('PORT', 5001))
    print("\n🚀 Blue Chip Signals Backend Starting...")
    print(f"📊 Admin Panel: http://0.0.0.0:{port}/admin")
    print("🔑 Password: Pumrvb12!")
    print(f"📡 API: http://0.0.0.0:{port}/api/signals/new\n")
    app.run(debug=False, host='0.0.0.0', port=port)

