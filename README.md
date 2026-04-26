# NVIDIA NIM MCP & Playground (Premium Edition)

Bộ công cụ chuyên nghiệp để sử dụng các mô hình AI đỉnh cao từ NVIDIA NIM (DeepSeek, Llama 3.1, Kimi, GLM...) tích hợp trực tiếp vào Antigravity IDE.

## 🌟 Tính năng nổi bật

1. **Interactive CLI Chat**: Giao diện dòng lệnh tương tác, chọn model bằng phím số, chat liên tục có màu sắc.
2. **Glassmorphism Playground**: Giao diện web hiện đại, hỗ trợ đầy đủ các model mới nhất.
3. **MCP Server**: Tích hợp Agent AI (Antigravity) để điều khiển máy tính bằng mô hình NVIDIA.

## 🚀 Cách Setup trên máy tính mới

### 1. Cài đặt môi trường

- Cài đặt [Node.js](https://nodejs.org/) (phiên bản 18+).
- Clone project và cài đặt thư viện:

  ```bash
  git clone https://github.com/Nakazasen/nvidia-server
  cd nvidia-server
  npm install
  ```

### 2. Cấu hình API Key (Quan trọng)

Tạo file `.env` trong thư mục gốc và dán Key của bạn vào:

```env
NVIDIA_API_KEY=nvapi-YOUR_KEY_HERE
```

*(Lưu ý: File `.env` đã được cấu hình để không bị đẩy lên GitHub).*

### 3. Cách sử dụng

#### A. Interactive CLI Chat (Khuyên dùng)

Đây là cách nhanh nhất để chat với AI ngay trong Terminal:

```bash
node tools/nvidia-cli.mjs
```

- Bấm số (1, 2, 3...) để chọn Model.
- Bấm `0` để thoát.
- Chat liên tục như ChatGPT.

#### B. Giao diện Playground UI

Giao diện web đẹp mắt để trải nghiệm:

```bash
npm start
```

Truy cập: `http://localhost:3000`

#### C. AI Agent CLI (Quyền lực nhất)

Đây là chế độ Agent thực thụ, có khả năng tự động thực hiện các tác vụ trên máy tính:

```bash
npm run agent
```

- **Khả năng**: Liệt kê thư mục, đọc file, ghi file, sửa code, chạy lệnh terminal.
- **Mô hình khuyên dùng**: DeepSeek V4 Flash (Số 2) hoặc Llama 3.1 405B (Số 4).
- **Bảo mật**: Agent luôn hỏi xác nhận `(y/n)` trước khi thực hiện các thay đổi (ghi file/chạy lệnh).

#### D. Tích hợp vào Antigravity IDE

Mở cấu hình MCP của IDE và thêm đoạn này:

```json
"nvidia-nim": {
  "command": "node",
  "args": ["D:/ĐƯỜNG/DẪN/ĐẾN/tools/nvidia_mcp.mjs"]
}
```

## 📜 Quy tắc Agent (.antigravityrules)

Project này đi kèm file cấu hình bắt buộc Agent phải luôn sử dụng MCP của NVIDIA khi người dùng yêu cầu, đảm bảo tính minh bạch 100%.

---

*Phát triển bởi Antigravity AI Coding Assistant.*
