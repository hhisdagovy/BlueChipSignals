"""
Blue Chip Signals Backend - Flask Version
Simple and reliable backend for managing trading signals
"""

from flask import Flask, request, jsonify, render_template_string, redirect, session, make_response
from datetime import datetime
import sqlite3
import json
from functools import wraps

app = Flask(__name__)
app.secret_key = 'bluechip-signals-secret-key-change-in-production'

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
        
        conn = sqlite3.connect('signals.db')
        c = conn.cursor()
        c.execute('''
            INSERT INTO signals 
            (stock, price, vwap, mfi, contract_type, strike_price, premium, expiration, volume)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            data['stock'],
            data['price'],
            data['vwap'],
            data['mfi'],
            contract['type'],
            contract['strike'],
            contract['premium'],
            contract['expiration'],
            contract.get('volume', 0)
        ))
        conn.commit()
        signal_id = c.lastrowid
        conn.close()
        
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
        SELECT stock, price, vwap, mfi, contract_type, strike_price, 
               premium, expiration, timestamp 
        FROM signals 
        ORDER BY timestamp DESC 
        LIMIT 10
    ''')
    recent_signals = c.fetchall()
    
    conn.close()
    
    return render_template_string(ADMIN_DASHBOARD_HTML, 
                                   total_signals=total_signals,
                                   signals_today=signals_today,
                                   recent_signals=recent_signals)

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
    </style>
</head>
<body>
    <div class="header">
        <h1>Admin Dashboard</h1>
        <div>
            <a href="/admin/post-signal" class="btn" style="margin-right: 1rem;">Post Signal</a>
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
        <h2 style="margin-bottom: 1rem; color: #b3a17d;">Recent Signals</h2>
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
                </tr>
            </thead>
            <tbody>
                {% for signal in recent_signals %}
                <tr>
                    <td><span class="stock-badge stock-{{ signal[0]|lower }}">{{ signal[0] }}</span></td>
                    <td>${{ "%.2f"|format(signal[1]) }}</td>
                    <td>${{ "%.2f"|format(signal[2]) }}</td>
                    <td>{{ "%.2f"|format(signal[3]) }}</td>
                    <td>{{ signal[4] }}</td>
                    <td>${{ "%.2f"|format(signal[5]) }}</td>
                    <td>${{ "%.2f"|format(signal[6]) }}</td>
                    <td>{{ signal[8].split('.')[0] if '.' in signal[8] else signal[8] }}</td>
                </tr>
                {% endfor %}
            </tbody>
        </table>
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
    print("\n🚀 Blue Chip Signals Backend Starting...")
    print("📊 Admin Panel: http://127.0.0.1:5001/admin")
    print("🔑 Password: Pumrvb12!")
    print("📡 API: http://127.0.0.1:5001/api/signals/new\n")
    app.run(debug=True, host='0.0.0.0', port=5001)

