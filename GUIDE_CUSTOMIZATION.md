# 🎨 Hướng dẫn Tùy chỉnh Giao diện NVIDIA NIM Agent IDE

File này hướng dẫn bạn cách cá nhân hóa giao diện Web (`nvidia_playground.html`) để biến nó thành của riêng bạn.

## 1. Thay đổi Hệ màu (Theming)
Mở file `nvidia_playground.html`, tìm phần `:root` trong thẻ `<style>`:

| Biến | Ý nghĩa | Gợi ý màu Cyberpunk |
|---|---|---|
| `--primary` | Màu chủ đạo (Nút, Border) | `#00f2ff` (Cyan) |
| `--bg` | Màu nền chính | `#050505` (Deep Black) |
| `--glass` | Màu của các bảng tin nhắn | `rgba(0, 242, 255, 0.05)` |

## 2. Thêm Tab mới vào Sidebar
Nếu bạn muốn thêm một mục "Lịch sử" hoặc "Cài đặt nâng cao" vào bên trái:

1.  **Thêm HTML**:
    ```html
    <div class="sidebar">
        <h2>...</h2>
        <button onclick="showTab('settings')">⚙️ Cài đặt</button>
        <button onclick="showTab('history')">📜 Lịch sử</button>
    </div>
    ```
2.  **Thêm Logic Javascript**:
    ```javascript
    function showTab(tabName) {
        // Ẩn tất cả các panel
        document.querySelectorAll('.panel').forEach(p => p.style.display = 'none');
        // Hiện panel được chọn
        document.getElementById(tabName + '-panel').style.display = 'block';
    }
    ```

## 3. Thay đổi Font chữ
Dự án đang dùng font **Outfit**. Bạn có thể đổi sang font khác từ Google Fonts bằng cách thay link ở dòng 8:
```html
<link href="https://fonts.googleapis.com/css2?family=Roboto+Mono&display=swap" rel="stylesheet">
```
Sau đó cập nhật `font-family: 'Roboto Mono', monospace;` trong CSS.

## 4. Tùy chỉnh "Độ mờ" (Glassmorphism)
Để hiệu ứng kính mờ trông sang trọng hơn, bạn có thể tăng thông số `backdrop-filter` trong các class như `.message` hoặc `.sidebar`:
```css
backdrop-filter: blur(15px) saturate(150%);
```

---
🚀 *Chúc bạn tạo được một giao diện Agent "đỉnh cao" nhất!*
