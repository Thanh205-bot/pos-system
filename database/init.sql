CREATE DATABASE IF NOT EXISTS pos_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE pos_db;

-- 1. Bảng sản phẩm / tồn kho
CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    product_code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    price DECIMAL(12, 2) NOT NULL,
    stock INT NOT NULL DEFAULT 0,
    category VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Bảng đơn hàng / hóa đơn
CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_code VARCHAR(50) NOT NULL UNIQUE,
    total_amount DECIMAL(12, 2) NOT NULL,
    status ENUM('PAID', 'PENDING', 'CANCELLED') DEFAULT 'PAID',
    payment_method VARCHAR(50) DEFAULT 'CASH',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Bảng chi tiết đơn hàng
CREATE TABLE IF NOT EXISTS order_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    unit_price DECIMAL(12, 2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Dữ liệu mẫu ban đầu để hiển thị lên bảng
INSERT INTO products (product_code, name, price, stock, category) VALUES
('SP001', 'Cà phê Đen Đá', 25000, 150, 'Đồ uống'),
('SP002', 'Trà Sữa Trân Châu', 35000, 80, 'Đồ uống'),
('SP003', 'Bánh Mì Kẹp Thịt', 20000, 45, 'Thức ăn'),
('SP004', 'Nước Ngọt Lon', 15000, 200, 'Đồ uống'),
('SP005', 'Bánh Quy Bơ', 45000, 15, 'Thức ăn');

INSERT INTO orders (order_code, total_amount, status, payment_method) VALUES
('HD-2026-001', 50000, 'PAID', 'CASH'),
('HD-2026-002', 70000, 'PAID', 'MOMO');

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
(1, 1, 2, 25000),
(2, 2, 2, 35000);