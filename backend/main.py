"""
BlueChip Signals Backend
FastHTML application for managing trading signals
"""

from fasthtml.common import *
from datetime import datetime
import sqlite3
import json
from pathlib import Path

# Initialize FastHTML app
app, rt = fast_app(
    db_file='signals.db',
    hdrs=(
        Script(src="https://cdn.jsdelivr.net/npm/chart.js"),
        Link(rel="stylesheet", href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css")
    )
)

# Database setup
def init_db():
    """Initialize database with signals table"""
    conn = sqlite3.connect('signals.db')
    c = conn.cursor()
    
    # Signals table
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
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Admin users table
    c.execute('''
        CREATE TABLE IF NOT EXISTS admin_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    conn.commit()
    conn.close()

# Initialize database on startup
init_db()

# ============================================
# API ENDPOINTS (For GitHub Action)
# ============================================

@rt('/api/signals/new', methods=['POST'])
async def create_signal(request):
    """
    Receive new signal from GitHub Action
    
    Expected JSON format:
    {
        "stock": "TSLA",
        "price": 339.96,
        "vwap": 339.39,
        "mfi": 63.00,
        "contract": {
            "type": "Call",
            "strike": 337.50,
            "premium": 3.48,
            "expiration": "2025-05-23",
            "volume": 66367
        }
    }
    """
    try:
        data = await request.json()
        
        # Validate required fields
        required = ['stock', 'price', 'vwap', 'mfi', 'contract']
        if not all(field in data for field in required):
            return JSONResponse(
                {'error': 'Missing required fields'}, 
                status_code=400
            )
        
        # Extract contract details
        contract = data['contract']
        
        # Insert into database
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
        
        return JSONResponse({
            'success': True,
            'signal_id': signal_id,
            'message': f'Signal for {data["stock"]} saved successfully'
        })
        
    except Exception as e:
        return JSONResponse(
            {'error': str(e)}, 
            status_code=500
        )

@rt('/api/signals/latest')
def get_latest_signals(limit: int = 50):
    """Get latest signals for dashboard"""
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
    return JSONResponse({'signals': signals})

@rt('/api/signals/filter')
def filter_signals(
    stock: str = None,
    start_date: str = None,
    end_date: str = None,
    limit: int = 50
):
    """Filter signals by stock and date range"""
    conn = sqlite3.connect('signals.db')
    c = conn.cursor()
    
    query = 'SELECT * FROM signals WHERE 1=1'
    params = []
    
    if stock:
        query += ' AND stock = ?'
        params.append(stock)
    
    if start_date:
        query += ' AND DATE(timestamp) >= ?'
        params.append(start_date)
    
    if end_date:
        query += ' AND DATE(timestamp) <= ?'
        params.append(end_date)
    
    query += ' ORDER BY timestamp DESC LIMIT ?'
    params.append(limit)
    
    c.execute(query, params)
    signals = [dict(zip([col[0] for col in c.description], row)) for row in c.fetchall()]
    
    conn.close()
    return JSONResponse({'signals': signals})

# ============================================
# ADMIN PANEL
# ============================================

# Simple session storage (replace with proper auth later)
sessions = {}

def check_admin(request):
    """Check if user is logged in as admin"""
    session_id = request.cookies.get('admin_session')
    return session_id in sessions

@rt('/admin')
def admin_home(request):
    """Admin dashboard"""
    if not check_admin(request):
        return RedirectResponse('/admin/login')
    
    # Get stats
    conn = sqlite3.connect('signals.db')
    c = conn.cursor()
    
    # Total signals
    c.execute('SELECT COUNT(*) FROM signals')
    total_signals = c.fetchone()[0]
    
    # Signals today
    c.execute('SELECT COUNT(*) FROM signals WHERE DATE(timestamp) = DATE("now")')
    signals_today = c.fetchone()[0]
    
    # Latest signals
    c.execute('''
        SELECT stock, price, vwap, mfi, contract_type, strike_price, 
               premium, expiration, timestamp 
        FROM signals 
        ORDER BY timestamp DESC 
        LIMIT 10
    ''')
    recent_signals = c.fetchall()
    
    conn.close()
    
    return Html(
        Head(
            Title("Admin Dashboard - BlueChip Signals"),
            Meta(charset="UTF-8"),
            Meta(name="viewport", content="width=device-width, initial-scale=1.0"),
            Link(rel="stylesheet", href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"),
            Style("""
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
            """)
        ),
        Body(
            Div(
                Div(
                    H1("Admin Dashboard"),
                    Div(
                        A("Post Signal", href="/admin/post-signal", cls="btn", style="margin-right: 1rem;"),
                        A("Logout", href="/admin/logout", cls="btn logout-btn")
                    )
                , cls="header"),
                
                Div(
                    Div(
                        Div(str(total_signals), cls="stat-value"),
                        Div("Total Signals", cls="stat-label")
                    , cls="stat-card"),
                    Div(
                        Div(str(signals_today), cls="stat-value"),
                        Div("Signals Today", cls="stat-label")
                    , cls="stat-card")
                , cls="stats"),
                
                Div(
                    H2("Recent Signals", style="margin-bottom: 1rem; color: #b3a17d;"),
                    Table(
                        Thead(
                            Tr(
                                Th("Stock"),
                                Th("Price"),
                                Th("VWAP"),
                                Th("MFI"),
                                Th("Contract"),
                                Th("Strike"),
                                Th("Premium"),
                                Th("Time")
                            )
                        ),
                        Tbody(
                            *[Tr(
                                Td(Span(signal[0], cls=f"stock-badge stock-{signal[0].lower()}")),
                                Td(f"${signal[1]:.2f}"),
                                Td(f"${signal[2]:.2f}"),
                                Td(f"{signal[3]:.2f}"),
                                Td(signal[4]),
                                Td(f"${signal[5]:.2f}"),
                                Td(f"${signal[6]:.2f}"),
                                Td(signal[8].split('.')[0] if '.' in signal[8] else signal[8])
                            ) for signal in recent_signals]
                        )
                    )
                , cls="signals-table")
            )
        )
    )

@rt('/admin/login')
def admin_login_page():
    """Admin login page"""
    return Html(
        Head(
            Title("Admin Login - BlueChip Signals"),
            Meta(charset="UTF-8"),
            Meta(name="viewport", content="width=device-width, initial-scale=1.0"),
            Style("""
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
            """)
        ),
        Body(
            Div(
                H1("Admin Login"),
                Form(
                    Input(type="password", name="password", placeholder="Enter admin password", required=True),
                    Button("Login", type="submit")
                , method="POST", action="/admin/login")
            , cls="login-box")
        )
    )

@rt('/admin/login', methods=['POST'])
async def admin_login(request):
    """Process admin login"""
    form = await request.form()
    password = form.get('password')
    
    # Simple password check (replace with proper auth later)
    if password == 'Pumrvb12!':
        # Create session
        import uuid
        session_id = str(uuid.uuid4())
        sessions[session_id] = {'logged_in': True}
        
        response = RedirectResponse('/admin', status_code=303)
        response.set_cookie('admin_session', session_id, max_age=86400)  # 24 hours
        return response
    else:
        return RedirectResponse('/admin/login?error=1')

@rt('/admin/logout')
def admin_logout(request):
    """Logout admin"""
    session_id = request.cookies.get('admin_session')
    if session_id in sessions:
        del sessions[session_id]
    
    response = RedirectResponse('/admin/login')
    response.delete_cookie('admin_session')
    return response

@rt('/admin/post-signal')
def post_signal_page(request):
    """Manual signal posting form"""
    if not check_admin(request):
        return RedirectResponse('/admin/login')
    
    return Html(
        Head(
            Title("Post Signal - Admin"),
            Meta(charset="UTF-8"),
            Style("""
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
                }
            """)
        ),
        Body(
            Div(
                H1("Post New Signal"),
                Form(
                    Div(
                        Label("Stock Symbol", _for="stock"),
                        Select(
                            Option("SPY", value="SPY"),
                            Option("TSLA", value="TSLA"),
                            Option("META", value="META"),
                            Option("AAPL", value="AAPL"),
                            Option("NVDA", value="NVDA"),
                            Option("AMZN", value="AMZN"),
                            name="stock", id="stock", required=True
                        )
                    , cls="form-group"),
                    Div(
                        Label("Price", _for="price"),
                        Input(type="number", step="0.01", name="price", id="price", required=True)
                    , cls="form-group"),
                    Div(
                        Label("VWAP", _for="vwap"),
                        Input(type="number", step="0.01", name="vwap", id="vwap", required=True)
                    , cls="form-group"),
                    Div(
                        Label("MFI", _for="mfi"),
                        Input(type="number", step="0.01", name="mfi", id="mfi", required=True)
                    , cls="form-group"),
                    Div(
                        Label("Contract Type", _for="contract_type"),
                        Select(
                            Option("Call", value="Call"),
                            Option("Put", value="Put"),
                            name="contract_type", id="contract_type", required=True
                        )
                    , cls="form-group"),
                    Div(
                        Label("Strike Price", _for="strike"),
                        Input(type="number", step="0.01", name="strike", id="strike", required=True)
                    , cls="form-group"),
                    Div(
                        Label("Premium", _for="premium"),
                        Input(type="number", step="0.01", name="premium", id="premium", required=True)
                    , cls="form-group"),
                    Div(
                        Label("Expiration (YYYY-MM-DD)", _for="expiration"),
                        Input(type="date", name="expiration", id="expiration", required=True)
                    , cls="form-group"),
                    Div(
                        Label("Volume (Optional)", _for="volume"),
                        Input(type="number", name="volume", id="volume", placeholder="0")
                    , cls="form-group"),
                    Button("Post Signal", type="submit"),
                    A("Back to Dashboard", href="/admin", cls="back-btn", style="text-decoration: none; display: inline-block; padding: 1rem 2rem; margin-left: 1rem;")
                , method="POST", action="/admin/post-signal")
            , cls="container")
        )
    )

@rt('/admin/post-signal', methods=['POST'])
async def submit_signal(request):
    """Process manual signal submission"""
    if not check_admin(request):
        return RedirectResponse('/admin/login')
    
    form = await request.form()
    
    conn = sqlite3.connect('signals.db')
    c = conn.cursor()
    c.execute('''
        INSERT INTO signals 
        (stock, price, vwap, mfi, contract_type, strike_price, premium, expiration, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        form['stock'],
        float(form['price']),
        float(form['vwap']),
        float(form['mfi']),
        form['contract_type'],
        float(form['strike']),
        float(form['premium']),
        form['expiration'],
        int(form.get('volume', 0))
    ))
    conn.commit()
    conn.close()
    
    return RedirectResponse('/admin', status_code=303)

# ============================================
# HEALTH CHECK
# ============================================

@rt('/')
def home():
    """Health check endpoint"""
    return JSONResponse({
        'status': 'online',
        'service': 'BlueChip Signals Backend',
        'version': '1.0.0'
    })

# Start the server
if __name__ == '__main__':
    serve()

