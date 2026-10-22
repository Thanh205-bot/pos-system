const express = require('express');
const mysql = require('mysql2/promise');
const client = require('prom-client');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. Prometheus Metrics
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ register: client.register });

const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status']
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2]
});

// Logging middleware chuẩn JSON
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    httpRequestCounter.inc({ method: req.method, route: req.path, status: res.statusCode });
    httpRequestDuration.observe({ method: req.method, route: req.path, status: res.statusCode }, duration);

    const logEntry = {
      timestamp: new Date().toISOString(),
      client_ip: req.ip || req.connection.remoteAddress,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration_ms: Math.round(duration * 1000),
      service: 'pos-app',
      level: res.statusCode >= 500 ? 'error' : 'info',
      message: res.statusCode >= 500 ? 'Internal Server Error' : 'HTTP Request Processed'
    };
    console.log(JSON.stringify(logEntry));
  });
  next();
});

// 2. Kết nối MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'pos_user',
  password: process.env.DB_PASSWORD || 'pos_password_123',
  database: process.env.DB_NAME || 'pos_db',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 3. API Xác thực Đăng nhập
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === 'admin' && password === 'admin123') {
    return res.json({
      success: true,
      user: { username: 'admin', fullname: 'Quản Trị Viên', role: 'ADMIN' }
    });
  } else if (username === 'nhanvien' && password === '123456') {
    return res.json({
      success: true,
      user: { username: 'nhanvien', fullname: 'Nguyễn Văn Thu Ngân', role: 'STAFF' }
    });
  }

  return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không chính xác!' });
});

// 4. Endpoints Giám sát
app.get('/health', (req, res) => res.json({ status: 'UP', service: 'pos-app', timestamp: new Date() }));
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.get('/api/trigger-error', (req, res) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'pos-app',
    level: 'error',
    message: 'Test Loki Error: Lỗi giả lập hệ thống POS thanh toán thất bại!'
  }));
  res.status(500).json({ error: 'Đã sinh lỗi 500 phục vụ kiểm thử Loki!' });
});

// 5. APIs Quản lý Hàng hóa
app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', async (req, res) => {
  const { product_code, name, price, stock, category } = req.body;
  if (!product_code || !name || !price) {
    return res.status(400).json({ error: 'Vui lòng điền đủ thông tin bắt buộc!' });
  }
  try {
    const [result] = await pool.query(
      'INSERT INTO products (product_code, name, price, stock, category) VALUES (?, ?, ?, ?, ?)',
      [product_code.trim(), name.trim(), Number(price), Number(stock) || 0, category ? category.trim() : 'Hàng hóa']
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Mã sản phẩm này đã tồn tại!' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM order_items WHERE product_id = ?', [id]);
    const [result] = await conn.query('DELETE FROM products WHERE id = ?', [id]);
    await conn.commit();
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm!' });
    }
    res.json({ success: true, message: 'Đã xóa sản phẩm thành công!' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// 6. APIs Đơn hàng & Bán hàng
app.get('/api/orders', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM orders ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders', async (req, res) => {
  const { cart, paymentMethod } = req.body;
  if (!cart || !cart.length) return res.status(400).json({ error: 'Giỏ hàng đang trống!' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let total = 0;

    for (const item of cart) {
      const [prod] = await conn.query('SELECT * FROM products WHERE id = ? FOR UPDATE', [item.id]);
      if (!prod.length || prod[0].stock < item.quantity) {
        throw new Error(`Sản phẩm ${prod[0]?.name || item.id} không đủ tồn kho!`);
      }
      total += prod[0].price * item.quantity;
    }

    const orderCode = 'POS-' + Math.floor(100000 + Math.random() * 900000);
    const [orderRes] = await conn.query(
      'INSERT INTO orders (order_code, total_amount, status, payment_method) VALUES (?, ?, ?, ?)',
      [orderCode, total, 'PAID', paymentMethod || 'CASH']
    );

    for (const item of cart) {
      await conn.query(
        'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
        [orderRes.insertId, item.id, item.quantity, item.price]
      );
      await conn.query('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.id]);
    }

    await conn.commit();
    res.json({ success: true, orderCode, total });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// 7. Thống kê chung vận hành kho
app.get('/api/stats', async (req, res) => {
  try {
    const [[stock]] = await pool.query("SELECT COALESCE(SUM(stock), 0) AS totalStock, COUNT(CASE WHEN stock <= 20 THEN 1 END) AS lowStock, COUNT(id) AS totalItems FROM products");
    const [[orders]] = await pool.query("SELECT COUNT(id) AS totalOrders FROM orders WHERE status = 'PAID'");
    res.json({
      totalStock: stock.totalStock,
      lowStock: stock.lowStock,
      totalItems: stock.totalItems,
      totalOrders: orders.totalOrders
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Báo cáo Doanh thu theo Ngày & Tháng
app.get('/api/reports/daily', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Thiếu ngày!' });

  try {
    const [[summary]] = await pool.query(`
      SELECT COALESCE(SUM(total_amount), 0) AS revenue, COUNT(id) AS orders
      FROM orders WHERE status = 'PAID' AND DATE(created_at) = ?
    `, [date]);

    const [orders] = await pool.query(`
      SELECT order_code, total_amount, payment_method, created_at
      FROM orders WHERE status = 'PAID' AND DATE(created_at) = ?
      ORDER BY id DESC
    `, [date]);

    res.json({ date, summary, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/monthly', async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: 'Thiếu tháng!' });

  try {
    const [yearPart, monthPart] = month.split('-');
    const [[summary]] = await pool.query(`
      SELECT COALESCE(SUM(total_amount), 0) AS revenue, COUNT(id) AS orders
      FROM orders WHERE status = 'PAID' AND YEAR(created_at) = ? AND MONTH(created_at) = ?
    `, [yearPart, monthPart]);

    const [dailyBreakdown] = await pool.query(`
      SELECT DATE(created_at) AS order_date, COALESCE(SUM(total_amount), 0) AS daily_revenue, COUNT(id) AS daily_orders
      FROM orders WHERE status = 'PAID' AND YEAR(created_at) = ? AND MONTH(created_at) = ?
      GROUP BY DATE(created_at) ORDER BY order_date DESC
    `, [yearPart, monthPart]);

    res.json({ month, summary, dailyBreakdown });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Giao diện Web SPA hoàn thiện có Màn hình Đăng nhập
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>POS SYSTEM - Quản Lý Cửa Hàng & Bán Hàng</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .sidebar { background-color: #0f172a; min-height: 100vh; color: #94a3b8; }
    .sidebar .nav-link { color: #94a3b8; border-radius: 8px; margin-bottom: 6px; font-weight: 500; cursor: pointer; text-decoration: none; display: block; padding: 10px 14px; }
    .sidebar .nav-link.active, .sidebar .nav-link:hover { background-color: #1e293b; color: #38bdf8; }
    .kpi-card { border: none; border-radius: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.04); }
    .product-card { border: 1px solid #e2e8f0; border-radius: 12px; cursor: pointer; transition: all 0.2s; background: white; }
    .product-card:hover { border-color: #0284c7; box-shadow: 0 4px 12px rgba(2,132,199,0.12); transform: translateY(-2px); }
    .cart-box { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .tab-content-area { display: none !important; }
    .tab-content-area.active { display: block !important; }
    
    /* Phân quyền hiển thị */
  
    body.role-staff .admin-only { display: none !important; }

    /* Màn hình Đăng nhập */
    #login-overlay {
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      background: #0f172a; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
    }
    .login-card {
      width: 100%; max-width: 420px; background: white;
      border-radius: 16px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.3);
      padding: 35px;
    }
  </style>
</head>
<body>

  <!-- MÀN HÌNH ĐĂNG NHẬP (BẢO VỆ TOÀN BỘ HỆ THỐNG) -->
  <div id="login-overlay">
    <div class="login-card">
      <div class="text-center mb-4">
        <h3 class="font-weight-bold text-dark">HỆ THỐNG POS</h3>
        <p class="text-secondary small">Đăng nhập tài khoản để vào hệ thống bán hàng</p>
      </div>

      <div id="login-error-alert" class="alert alert-danger py-2 small" style="display: none;"></div>

      <form onsubmit="handleLoginSubmit(event)">
        <div class="mb-3">
          <label class="form-label small fw-bold">Tên đăng nhập</label>
          <input type="text" id="login-username" class="form-control" placeholder="admin hoặc nhanvien" required>
        </div>
        <div class="mb-3">
          <label class="form-label small fw-bold">Mật khẩu</label>
          <input type="password" id="login-password" class="form-control" placeholder="••••••••" required>
        </div>
        <button type="submit" class="btn btn-primary w-100 py-2 fw-bold shadow-sm mb-3">Đăng Nhập</button>
      </form>

      <div class="border-top pt-3 text-muted small bg-light p-2 rounded">
        <b>Tài khoản Demo hệ thống:</b><br>
        • Quản trị viên: <code>admin</code> / <code>admin123</code> (Đầy đủ quyền)<br>
        • Nhân viên bán hàng: <code>nhanvien</code> / <code>123456</code> (Bị khóa báo cáo)
      </div>
    </div>
  </div>

  <!-- GIAO DIỆN ỨNG DỤNG SAU KHI ĐĂNG NHẬP -->
  <div class="container-fluid" id="main-app" style="display: none;">
    <div class="row">
      <!-- Sidebar -->
      <div class="col-md-2 p-3 sidebar d-flex flex-column justify-content-between">
        <div>
          <div class="mb-3 px-2 text-white">
            <h4 class="m-0 font-weight-bold text-info">POS SYSTEM</h4>
            <small class="text-secondary" style="font-size: 11px;">Quản Lý & Bán Hàng</small>
          </div>

          <!-- Thông tin tài khoản đăng nhập & Nút đăng xuất -->
          <div class="bg-dark p-2 rounded mb-3 border border-secondary text-white">
            <div class="d-flex justify-content-between align-items-center">
              <div>
                <b class="d-block text-truncate small" id="current-user-name">Quản Trị Viên</b>
                <span class="badge" id="current-user-badge">ADMIN</span>
              </div>
              <button onclick="handleLogout()" class="btn btn-outline-danger btn-sm py-0 px-2" title="Đăng xuất">Thoát</button>
            </div>
          </div>

          <nav class="nav flex-column">
            <a class="nav-link active" onclick="switchTab('pos-tab', this)">Thu Ngân / POS</a>
            <a class="nav-link" onclick="switchTab('inventory-tab', this)">Kho Sản Phẩm</a>
            <a class="nav-link" onclick="switchTab('orders-tab', this)">Hóa Đơn Bán</a>
            <a class="nav-link admin-only" onclick="switchTab('reports-tab', this)">Báo Cáo Doanh Thu</a>
          </nav>
        </div>

        <div class="pt-3 border-top border-secondary">
          <small class="text-uppercase text-secondary" style="font-size: 10px; letter-spacing: 0.5px;">Hạ Tầng Giám Sát</small>
          <div class="mt-2 d-grid gap-2">
            <a href="/metrics" target="_blank" class="btn btn-outline-info btn-sm text-start">Prometheus Metrics</a>
            <a href="/health" target="_blank" class="btn btn-outline-success btn-sm text-start">Healthcheck</a>
            <button onclick="triggerError()" class="btn btn-danger btn-sm text-start">Test Loki Error</button>
          </div>
        </div>
      </div>

      <!-- Nội Dung Chính -->
      <div class="col-md-10 p-4">
        <!-- 4 Thẻ KPI Vận Hành -->
        <div class="row g-3 mb-4">
          <div class="col-md-3">
            <div class="card kpi-card p-3 bg-white">
              <span class="text-secondary small">Tổng Số Mặt Hàng</span>
              <h4 class="text-primary font-weight-bold my-1" id="kpi-total-items">0</h4>
              <small class="text-muted">Đang quản lý trong kho</small>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card kpi-card p-3 bg-white">
              <span class="text-secondary small">Tổng Lượng Tồn Kho</span>
              <h4 class="text-dark font-weight-bold my-1" id="kpi-stock">0</h4>
              <small class="text-muted">Sản phẩm sẵn sàng bán</small>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card kpi-card p-3 bg-white">
              <span class="text-secondary small">Cảnh Báo Hết Hàng</span>
              <h4 class="text-danger font-weight-bold my-1" id="kpi-low-stock">0</h4>
              <small class="text-danger">Tồn kho dưới 20 đơn vị</small>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card kpi-card p-3 bg-white">
              <span class="text-secondary small">Tổng Hóa Đơn Xuất</span>
              <h4 class="text-success font-weight-bold my-1" id="kpi-orders-count">0</h4>
              <small class="text-muted">Giao dịch đã hoàn tất</small>
            </div>
          </div>
        </div>

        <!-- TAB 1: THU NGÂN / POS -->
        <div id="pos-tab" class="tab-content-area active">
          <div class="row g-4">
            <div class="col-md-8">
              <div class="card p-3 border-0 shadow-sm bg-white mb-4">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h5 class="m-0 font-weight-bold">Danh Mục Hàng Hóa (Bấm chọn sản phẩm)</h5>
                  <span class="badge bg-primary">MySQL 8.0</span>
                </div>
                <div class="row g-3" id="product-grid"></div>
              </div>

              <div class="card p-3 border-0 shadow-sm bg-white">
                <h5 class="font-weight-bold mb-3">Lịch Sử 10 Giao Dịch Gần Nhất</h5>
                <div class="table-responsive">
                  <table class="table table-hover align-middle">
                    <thead class="table-light">
                      <tr>
                        <th>Mã Đơn Hàng</th><th>Số Tiền</th><th>Phương Thức</th><th>Trạng Thái</th><th>Thời Gian</th>
                      </tr>
                    </thead>
                    <tbody id="order-history-short"></tbody>
                  </table>
                </div>
              </div>
            </div>

            <div class="col-md-4">
              <div class="card cart-box p-3 border-0 sticky-top" style="top: 20px;">
                <h5 class="font-weight-bold mb-3">Hóa Đơn Hiện Tại</h5>
                <div id="cart-items" style="min-height: 220px; max-height: 350px; overflow-y: auto;" class="border rounded p-2 mb-3 bg-light">
                  <p class="text-center text-muted mt-5">Chưa có sản phẩm nào trong hóa đơn</p>
                </div>

                <div class="border-top pt-3">
                  <div class="d-flex justify-content-between align-items-center mb-3">
                    <span class="text-secondary">Hình thức:</span>
                    <select id="payment-method" class="form-select form-select-sm w-50">
                      <option value="CASH">Tiền mặt (CASH)</option>
                      <option value="MOMO">Ví MoMo (QR Code)</option>
                      <option value="BANKING">Ngân hàng (VietQR)</option>
                    </select>
                  </div>
                  <div class="d-flex justify-content-between align-items-center mb-3">
                    <h6 class="m-0 font-weight-bold">Tổng Thanh Toán:</h6>
                    <h4 class="m-0 text-primary font-weight-bold" id="cart-total">0 đ</h4>
                  </div>
                  <button onclick="handleCheckoutClick()" class="btn btn-primary w-100 py-2 font-weight-bold shadow-sm">
                    XUẤT HÓA ĐƠN
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 2: QUẢN LÝ KHO (THÊM / XÓA) -->
        <div id="inventory-tab" class="tab-content-area">
          <div class="card p-4 border-0 shadow-sm bg-white mb-4 admin-only">
            <h5 class="font-weight-bold mb-3 text-primary">+ Thêm Sản Phẩm Mới Vào Kho</h5>
            <form id="add-product-form" onsubmit="handleCreateProduct(event)">
              <div class="row g-3">
                <div class="col-md-2">
                  <label class="form-label small fw-bold">Mã sản phẩm *</label>
                  <input type="text" id="new-code" class="form-control form-control-sm" placeholder="VD: SP006" required>
                </div>
                <div class="col-md-3">
                  <label class="form-label small fw-bold">Tên hàng hóa *</label>
                  <input type="text" id="new-name" class="form-control form-control-sm" placeholder="VD: Trà Đào Cam Sả" required>
                </div>
                <div class="col-md-2">
                  <label class="form-label small fw-bold">Phân loại</label>
                  <input type="text" id="new-category" class="form-control form-control-sm" placeholder="Đồ uống / Thức ăn">
                </div>
                <div class="col-md-2">
                  <label class="form-label small fw-bold">Đơn giá bán *</label>
                  <input type="number" id="new-price" class="form-control form-control-sm" placeholder="30000" min="1000" step="500" required>
                </div>
                <div class="col-md-2">
                  <label class="form-label small fw-bold">Số lượng tồn *</label>
                  <input type="number" id="new-stock" class="form-control form-control-sm" placeholder="100" min="0" required>
                </div>
                <div class="col-md-1 d-flex align-items-end">
                  <button type="submit" class="btn btn-success btn-sm w-100 fw-bold">Thêm</button>
                </div>
              </div>
            </form>
          </div>

          <div class="card p-4 border-0 shadow-sm bg-white">
            <div class="d-flex justify-content-between align-items-center mb-3">
              <h5 class="font-weight-bold m-0">Danh Sách Mặt Hàng Trong Kho</h5>
              <span id="inventory-role-badge" class="badge bg-danger">Quyền: ADMIN</span>
            </div>
            <table class="table table-bordered table-hover align-middle">
              <thead class="table-dark">
                <tr>
                  <th>ID</th><th>Mã SP</th><th>Tên Hàng Hóa</th><th>Phân Loại</th><th>Đơn Giá</th><th>Số Lượng Tồn</th><th>Trạng Thái</th><th class="admin-only">Thao Tác</th>
                </tr>
              </thead>
              <tbody id="inventory-table-body"></tbody>
            </table>
          </div>
        </div>

        <!-- TAB 3: TẤT CẢ HÓA ĐƠN BÁN -->
        <div id="orders-tab" class="tab-content-area">
          <div class="card p-4 border-0 shadow-sm bg-white">
            <h5 class="font-weight-bold mb-3">Nhật Ký Hóa Đơn Bán Hàng</h5>
            <table class="table table-striped table-hover align-middle">
              <thead class="table-primary">
                <tr>
                  <th>Mã Hóa Đơn</th><th>Số Tiền</th><th>Phương Thức</th><th>Trạng Thái</th><th>Thời Gian Lập</th>
                </tr>
              </thead>
              <tbody id="orders-table-body"></tbody>
            </table>
          </div>
        </div>

        <!-- TAB 4: BÁO CÁO DOANH THU THEO CHU KỲ (CHỈ ADMIN) -->
        <div id="reports-tab" class="tab-content-area admin-only">
          <div class="row g-4">
            <div class="col-md-6">
              <div class="card p-4 border-0 shadow-sm bg-white h-100">
                <h5 class="font-weight-bold mb-3 text-primary">1. Tra Cứu Doanh Thu Theo Ngày</h5>
                <div class="input-group mb-3">
                  <input type="date" id="filter-date" class="form-control">
                  <button class="btn btn-primary fw-bold" onclick="searchDailyRevenue()">Tra Cứu Ngày</button>
                </div>

                <div id="daily-result-box" class="border rounded p-3 bg-light" style="display: none;">
                  <div class="d-flex justify-content-between align-items-center mb-2">
                    <span class="text-secondary fw-bold" id="daily-label">Ngày: --/--/----</span>
                    <span class="badge bg-primary" id="daily-orders-count">0 hóa đơn</span>
                  </div>
                  <h3 class="text-primary font-weight-bold m-0" id="daily-revenue-val">0 đ</h3>
                  <hr>
                  <h6 class="small fw-bold text-secondary mb-2">Danh sách đơn hàng trong ngày:</h6>
                  <div style="max-height: 200px; overflow-y: auto;">
                    <table class="table table-sm table-bordered bg-white">
                      <thead>
                        <tr><th>Mã HĐ</th><th>Số Tiền</th><th>Hình thức</th><th>Giờ lập</th></tr>
                      </thead>
                      <tbody id="daily-orders-table"></tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>

            <div class="col-md-6">
              <div class="card p-4 border-0 shadow-sm bg-white h-100">
                <h5 class="font-weight-bold mb-3 text-success">2. Tổng Hợp Doanh Thu Theo Tháng</h5>
                <div class="input-group mb-3">
                  <input type="month" id="filter-month" class="form-control">
                  <button class="btn btn-success fw-bold" onclick="searchMonthlyRevenue()">Tổng Hợp Tháng</button>
                </div>

                <div id="monthly-result-box" class="border rounded p-3 bg-light" style="display: none;">
                  <div class="d-flex justify-content-between align-items-center mb-2">
                    <span class="text-secondary fw-bold" id="monthly-label">Tháng: --/----</span>
                    <span class="badge bg-success" id="monthly-orders-count">0 hóa đơn</span>
                  </div>
                  <h3 class="text-success font-weight-bold m-0" id="monthly-revenue-val">0 đ</h3>
                  <hr>
                  <h6 class="small fw-bold text-secondary mb-2">Chi tiết doanh thu từng ngày trong tháng:</h6>
                  <div style="max-height: 200px; overflow-y: auto;">
                    <table class="table table-sm table-striped bg-white">
                      <thead>
                        <tr><th>Ngày</th><th>Số Đơn</th><th>Doanh Thu Ngày</th></tr>
                      </thead>
                      <tbody id="monthly-days-table"></tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>

  <!-- MODAL QUÉT MÃ QR THANH TOÁN (MOMO & VIETQR) -->
  <div class="modal fade" id="qrModal" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content">
        <div class="modal-header bg-dark text-white">
          <h5 class="modal-title" id="qrModalTitle">Quét Mã QR Thanh Toán</h5>
          <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body text-center p-4">
          <p class="text-secondary mb-2" id="qrMethodDesc">Mở ứng dụng quét mã QR để chuyển tiền</p>
          <div id="qrContainer" class="d-flex justify-content-center my-3"></div>
          <h3 class="text-danger font-weight-bold" id="qrAmount">0 đ</h3>
          <p class="small text-muted" id="qrNote">Nội dung: POS Don Hang</p>
        </div>
        <div class="modal-footer justify-content-between">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy bỏ</button>
          <button type="button" class="btn btn-success font-weight-bold" onclick="confirmPaymentSuccess()">Đã Nhận Đủ Tiền (Hoàn tất)</button>
        </div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    let products = [];
    let allOrders = [];
    let cart = [];
    let qrModalInstance = null;
    let currentUser = null;

    document.addEventListener('DOMContentLoaded', () => {
      qrModalInstance = new bootstrap.Modal(document.getElementById('qrModal'));

      const today = new Date().toISOString().split('T')[0];
      const curMonth = today.slice(0, 7);
      document.getElementById('filter-date').value = today;
      document.getElementById('filter-month').value = curMonth;

      // Kiểm tra xem đã đăng nhập trước đó chưa
      const savedUser = localStorage.getItem('pos_user_session');
      if (savedUser) {
        currentUser = JSON.parse(savedUser);
        applyUserSession();
      }
    });
    function switchTab(tabId, el) {
      document.querySelectorAll('.tab-content-area').forEach(tab => {
        tab.classList.remove('active');
        tab.style.setProperty('display', 'none', 'important');
      });
      document.querySelectorAll('.sidebar .nav-link').forEach(link => link.classList.remove('active'));
      
      const targetTab = document.getElementById(tabId);
      if (targetTab) {
        targetTab.classList.add('active');
        targetTab.style.setProperty('display', 'block', 'important');
      }
      if (el) el.classList.add('active');
    }

    // Xử lý nộp form đăng nhập
    async function handleLoginSubmit(e) {
      e.preventDefault();
      const username = document.getElementById('login-username').value.trim();
      const password = document.getElementById('login-password').value.trim();
      const errorAlert = document.getElementById('login-error-alert');

      errorAlert.style.display = 'none';

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          currentUser = data.user;
          localStorage.setItem('pos_user_session', JSON.stringify(currentUser));
          applyUserSession();
        } else {
          errorAlert.innerText = data.error || 'Đăng nhập không thành công!';
          errorAlert.style.display = 'block';
        }
      } catch (err) {
        errorAlert.innerText = 'Lỗi kết nối máy chủ!';
        errorAlert.style.display = 'block';
      }
    }

    // Áp dụng vai trò và giao diện theo tài khoản đăng nhập
    function applyUserSession() {
      document.getElementById('login-overlay').style.display = 'none';
      document.getElementById('main-app').style.display = 'block';

      document.getElementById('current-user-name').innerText = currentUser.fullname;
      const badge = document.getElementById('current-user-badge');
      const invBadge = document.getElementById('inventory-role-badge');

      if (currentUser.role === 'STAFF') {
        document.body.classList.add('role-staff');
        badge.className = 'badge bg-secondary';
        badge.innerText = 'NHÂN VIÊN';
        invBadge.className = 'badge bg-secondary';
        invBadge.innerText = 'Quyền: NHÂN VIÊN';
      } else {
        document.body.classList.remove('role-staff');
        badge.className = 'badge bg-danger';
        badge.innerText = 'ADMIN';
        invBadge.className = 'badge bg-danger';
        invBadge.innerText = 'Quyền: ADMIN';
      }

      fetchData();
    }

    // Đăng xuất
    function handleLogout() {
      localStorage.removeItem('pos_user_session');
      currentUser = null;
      document.getElementById('main-app').style.display = 'none';
      document.getElementById('login-overlay').style.display = 'flex';
      document.getElementById('login-username').value = '';
      document.getElementById('login-password').value = '';
      document.getElementById('login-error-alert').style.display = 'none';
    }

    function switchTab(tabId, el) {
      document.querySelectorAll('.tab-content-area').forEach(tab => tab.classList.remove('active'));
      document.querySelectorAll('.sidebar .nav-link').forEach(link => link.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
      if (el) el.classList.add('active');
    }

    async function fetchData() {
      const pRes = await fetch('/api/products');
      products = await pRes.json();
      renderProducts();
      renderInventoryTable();

      const oRes = await fetch('/api/orders');
      allOrders = await oRes.json();
      renderOrders();

      const sRes = await fetch('/api/stats');
      const stats = await sRes.json();
      document.getElementById('kpi-total-items').innerText = stats.totalItems;
      document.getElementById('kpi-stock').innerText = stats.totalStock;
      document.getElementById('kpi-low-stock').innerText = stats.lowStock;
      document.getElementById('kpi-orders-count').innerText = stats.totalOrders;
    }

    function renderProducts() {
      let html = '';
      products.forEach(p => {
        let stockBadge = p.stock > 20 ? 'bg-success' : 'bg-danger';
        html += '<div class="col-md-4">' +
          '<div class="card product-card p-3 h-100" onclick="addToCart(' + p.id + ')">' +
            '<div class="d-flex justify-content-between align-items-start mb-2">' +
              '<span class="badge bg-secondary">' + p.product_code + '</span>' +
              '<span class="badge ' + stockBadge + '">Kho: ' + p.stock + '</span>' +
            '</div>' +
            '<h6 class="font-weight-bold my-1 text-truncate">' + p.name + '</h6>' +
            '<small class="text-muted mb-2">' + (p.category || 'Hàng hóa') + '</small>' +
            '<div class="d-flex justify-content-between align-items-center mt-auto">' +
              '<span class="text-primary font-weight-bold">' + Number(p.price).toLocaleString() + ' đ</span>' +
              '<button class="btn btn-sm btn-outline-primary rounded-circle">+</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      });
      document.getElementById('product-grid').innerHTML = html;
    }

    function renderInventoryTable() {
      let html = '';
      const isAdmin = currentUser && currentUser.role === 'ADMIN';

      products.forEach(p => {
        let badge = p.stock > 20 ? '<span class="badge bg-success">Còn hàng</span>' : '<span class="badge bg-warning text-dark">Sắp hết</span>';
        let deleteBtn = isAdmin
          ? '<td class="admin-only"><button onclick="deleteProduct(' + p.id + ')" class="btn btn-danger btn-sm py-0 px-2">Xóa</button></td>'
          : '<td class="admin-only"></td>';

        html += '<tr>' +
          '<td>' + p.id + '</td>' +
          '<td><b>' + p.product_code + '</b></td>' +
          '<td>' + p.name + '</td>' +
          '<td>' + (p.category || 'Hàng hóa') + '</td>' +
          '<td>' + Number(p.price).toLocaleString() + ' đ</td>' +
          '<td><b class="fs-6">' + p.stock + '</b></td>' +
          '<td>' + badge + '</td>' +
          deleteBtn +
        '</tr>';
      });
      document.getElementById('inventory-table-body').innerHTML = html;
    }

    function renderOrders() {
      let shortHtml = '';
      allOrders.slice(0, 10).forEach(o => {
        shortHtml += '<tr>' +
          '<td><b>' + o.order_code + '</b></td>' +
          '<td class="text-primary font-weight-bold">' + Number(o.total_amount).toLocaleString() + ' đ</td>' +
          '<td><span class="badge bg-light text-dark border">' + o.payment_method + '</span></td>' +
          '<td><span class="badge bg-success">Đã Thanh Toán</span></td>' +
          '<td class="small text-muted">' + new Date(o.created_at).toLocaleTimeString() + '</td>' +
        '</tr>';
      });
      document.getElementById('order-history-short').innerHTML = shortHtml;

      let fullHtml = '';
      allOrders.forEach(o => {
        fullHtml += '<tr>' +
          '<td><b>' + o.order_code + '</b></td>' +
          '<td class="text-primary font-weight-bold">' + Number(o.total_amount).toLocaleString() + ' đ</td>' +
          '<td><span class="badge bg-secondary">' + o.payment_method + '</span></td>' +
          '<td><span class="badge bg-success">Hoàn Tất</span></td>' +
          '<td>' + new Date(o.created_at).toLocaleString() + '</td>' +
        '</tr>';
      });
      document.getElementById('orders-table-body').innerHTML = fullHtml;
    }

    async function searchDailyRevenue() {
      const selectedDate = document.getElementById('filter-date').value;
      if (!selectedDate) { alert('Vui lòng chọn ngày!'); return; }

      const res = await fetch('/api/reports/daily?date=' + selectedDate);
      const data = await res.json();

      document.getElementById('daily-label').innerText = 'Ngày: ' + new Date(data.date).toLocaleDateString('vi-VN');
      document.getElementById('daily-orders-count').innerText = data.summary.orders + ' hóa đơn';
      document.getElementById('daily-revenue-val').innerText = Number(data.summary.revenue).toLocaleString() + ' đ';

      let ordersHtml = '';
      if (data.orders && data.orders.length) {
        data.orders.forEach(o => {
          ordersHtml += '<tr>' +
            '<td><b>' + o.order_code + '</b></td>' +
            '<td class="text-primary">' + Number(o.total_amount).toLocaleString() + ' đ</td>' +
            '<td>' + o.payment_method + '</td>' +
            '<td>' + new Date(o.created_at).toLocaleTimeString() + '</td>' +
          '</tr>';
        });
      } else {
        ordersHtml = '<tr><td colspan="4" class="text-center text-muted">Không có đơn hàng nào trong ngày này</td></tr>';
      }
      document.getElementById('daily-orders-table').innerHTML = ordersHtml;
      document.getElementById('daily-result-box').style.display = 'block';
    }

    async function searchMonthlyRevenue() {
      const selectedMonth = document.getElementById('filter-month').value;
      if (!selectedMonth) { alert('Vui lòng chọn tháng!'); return; }

      const res = await fetch('/api/reports/monthly?month=' + selectedMonth);
      const data = await res.json();

      document.getElementById('monthly-label').innerText = 'Tháng: ' + data.month;
      document.getElementById('monthly-orders-count').innerText = data.summary.orders + ' hóa đơn';
      document.getElementById('monthly-revenue-val').innerText = Number(data.summary.revenue).toLocaleString() + ' đ';

      let daysHtml = '';
      if (data.dailyBreakdown && data.dailyBreakdown.length) {
        data.dailyBreakdown.forEach(d => {
          daysHtml += '<tr>' +
            '<td><b>' + new Date(d.order_date).toLocaleDateString('vi-VN') + '</b></td>' +
            '<td>' + d.daily_orders + ' đơn</td>' +
            '<td class="text-success font-weight-bold">' + Number(d.daily_revenue).toLocaleString() + ' đ</td>' +
          '</tr>';
        });
      } else {
        daysHtml = '<tr><td colspan="3" class="text-center text-muted">Không có giao dịch nào trong tháng này</td></tr>';
      }
      document.getElementById('monthly-days-table').innerHTML = daysHtml;
      document.getElementById('monthly-result-box').style.display = 'block';
    }

    async function handleCreateProduct(e) {
      e.preventDefault();
      if (!currentUser || currentUser.role !== 'ADMIN') { alert('Chỉ Quản trị viên mới được thêm hàng!'); return; }
      const product_code = document.getElementById('new-code').value.trim();
      const name = document.getElementById('new-name').value.trim();
      const category = document.getElementById('new-category').value.trim();
      const price = document.getElementById('new-price').value;
      const stock = document.getElementById('new-stock').value;

      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_code, name, category, price, stock })
      });
      const data = await res.json();
      if (res.ok) {
        alert('Đã thêm sản phẩm mới thành công!');
        document.getElementById('add-product-form').reset();
        fetchData();
      } else {
        alert('Lỗi: ' + (data.error || 'Không thể thêm sản phẩm'));
      }
    }

    async function deleteProduct(id) {
      if (!currentUser || currentUser.role !== 'ADMIN') { alert('Chỉ Quản trị viên mới được xóa hàng!'); return; }
      if (!confirm('Bạn có chắc chắn muốn xóa sản phẩm này khỏi hệ thống?')) return;
      const res = await fetch('/api/products/' + id, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        alert('Đã xóa sản phẩm thành công!');
        fetchData();
      } else {
        alert('Lỗi: ' + (data.error || 'Không thể xóa'));
      }
    }

    function addToCart(productId) {
      const prod = products.find(p => p.id === productId);
      if (!prod || prod.stock <= 0) { alert('Sản phẩm đã hết hàng!'); return; }

      const item = cart.find(c => c.id === productId);
      if (item) {
        if (item.quantity >= prod.stock) { alert('Số lượng vượt quá tồn kho hiện có!'); return; }
        item.quantity++;
      } else {
        cart.push({ id: prod.id, name: prod.name, price: prod.price, quantity: 1 });
      }
      renderCart();
    }

    function changeQuantity(id, delta) {
      const item = cart.find(c => c.id === id);
      if (!item) return;
      item.quantity += delta;
      if (item.quantity <= 0) cart = cart.filter(c => c.id !== id);
      renderCart();
    }

    function getCartTotal() {
      return cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    }

    function renderCart() {
      const container = document.getElementById('cart-items');
      if (!cart.length) {
        container.innerHTML = '<p class="text-center text-muted mt-5">Chưa có sản phẩm nào trong hóa đơn</p>';
        document.getElementById('cart-total').innerText = '0 đ';
        return;
      }

      let total = 0;
      let html = '';
      cart.forEach(item => {
        total += item.price * item.quantity;
        html += '<div class="d-flex justify-content-between align-items-center mb-2 p-2 bg-white rounded border">' +
          '<div style="max-width: 55%;">' +
            '<b class="small d-block text-truncate">' + item.name + '</b>' +
            '<small class="text-primary">' + Number(item.price).toLocaleString() + ' đ</small>' +
          '</div>' +
          '<div class="d-flex align-items-center">' +
            '<button onclick="changeQuantity(' + item.id + ', -1)" class="btn btn-sm btn-light border py-0 px-2">-</button>' +
            '<span class="mx-2 small font-weight-bold">' + item.quantity + '</span>' +
            '<button onclick="changeQuantity(' + item.id + ', 1)" class="btn btn-sm btn-light border py-0 px-2">+</button>' +
          '</div>' +
        '</div>';
      });
      container.innerHTML = html;
      document.getElementById('cart-total').innerText = total.toLocaleString() + ' đ';
    }

    function handleCheckoutClick() {
      if (!cart.length) { alert('Giỏ hàng đang trống!'); return; }
      const method = document.getElementById('payment-method').value;
      const total = getCartTotal();

      if (method === 'MOMO' || method === 'BANKING') {
        document.getElementById('qrModalTitle').innerText = method === 'MOMO' ? 'Thanh Toán Ví MoMo' : 'Chuyển Khoản Ngân Hàng (VietQR)';
        document.getElementById('qrMethodDesc').innerText = method === 'MOMO' ? 'Mở App MoMo quét mã QR thanh toán' : 'Mở App Ngân hàng quét mã VietQR';
        document.getElementById('qrAmount').innerText = Number(total).toLocaleString() + ' đ';
        document.getElementById('qrNote').innerText = 'Nội dung: POS-THANHTOAN-' + total;

        const qrColor = method === 'MOMO' ? '#a50064' : '#0054a6';
        const brandName = method === 'MOMO' ? 'MOMO PAY' : 'VIETQR';
    document.getElementById('qrContainer').innerHTML = 
          '<svg width="220" height="220" viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg" class="border rounded p-2 shadow-sm bg-white">' +
            '<rect width="220" height="220" fill="white"/>' +
            '<rect x="20" y="20" width="60" height="60" fill="' + qrColor + '"/>' +
            '<rect x="30" y="30" width="40" height="40" fill="white"/>' +
            '<rect x="40" y="40" width="20" height="20" fill="' + qrColor + '"/>' +
            '<rect x="140" y="20" width="60" height="60" fill="' + qrColor + '"/>' +
            '<rect x="150" y="30" width="40" height="40" fill="white"/>' +
            '<rect x="160" y="40" width="20" height="20" fill="' + qrColor + '"/>' +
            '<rect x="20" y="140" width="60" height="60" fill="' + qrColor + '"/>' +
            '<rect x="30" y="150" width="40" height="40" fill="white"/>' +
            '<rect x="40" y="160" width="20" height="20" fill="' + qrColor + '"/>' +
            '<rect x="100" y="30" width="20" height="20" fill="' + qrColor + '"/>' +
            '<rect x="100" y="80" width="20" height="20" fill="' + qrColor + '"/>' +
            '<rect x="100" y="140" width="20" height="20" fill="' + qrColor + '"/>' +
            '<rect x="140" y="100" width="20" height="20" fill="' + qrColor + '"/>' +
            '<rect x="160" y="140" width="40" height="40" fill="' + qrColor + '"/>' +
            '<rect x="75" y="95" width="70" height="30" rx="6" fill="' + qrColor + '"/>' +
            '<text x="110" y="115" font-size="11" font-weight="bold" fill="white" text-anchor="middle">' + brandName + '</text>' +
          '</svg>';

        qrModalInstance.show();
      } else {
        processOrder();
      }
    }

    function confirmPaymentSuccess() {
      qrModalInstance.hide();
      processOrder();
    }

    async function processOrder() {
      const paymentMethod = document.getElementById('payment-method').value;
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cart, paymentMethod })
      });
      const data = await res.json();
      if (res.ok) {
        alert('Xuất hóa đơn thành công! Mã đơn: ' + data.orderCode);
        cart = [];
        renderCart();
        fetchData();
      } else {
        alert('Lỗi: ' + (data.error || 'Không thể tạo đơn'));
      }
    }

    async function triggerError() {
      const res = await fetch('/api/trigger-error');
      alert('Đã sinh lỗi 500 thành công để kiểm thử log Loki!');
    }
  </script>
</body>
</html>
  `);
});

app.listen(port, () => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'pos-app',
    level: 'info',
    message: `Server đang chạy trên cổng ${port}`
  }));
});