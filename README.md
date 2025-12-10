# Beautylatory Smart Bulk Sender

Sistem pengiriman pesan WhatsApp massal dengan fitur anti-ban canggih.

## ⚠️ Disclaimer

Penggunaan tool ini sepenuhnya tanggung jawab pengguna. WhatsApp dapat memblokir akun yang melakukan spam.

## ✨ Fitur

### Kontak Management
- Upload CSV/Excel
- Input manual satu per satu
- Spreadsheet mode (seperti Google Sheets)
- Edit & hapus kontak

### Message Editor
- Format toolbar (Bold, Italic, Strikethrough, Monospace)
- Variable personalisasi: `{nama}`, `{nomor}`
- Kirim gambar/video/PDF dengan caption
- Character counter

### 🛡️ Sistem Anti-Ban (300-500 pesan/hari)
- **Warmup Phase**: 10 pesan pertama delay lebih lama
- **Humanized Delay**: 8-15 detik (random, tidak predictable)
- **Batch Rest**: Istirahat 1-2 menit setiap 25 pesan
- **Random Pause**: 10% chance pause lebih lama (simulasi manusia)
- **Typing Simulation**: Menampilkan "sedang mengetik" sebelum kirim
- **Number Validation**: Cek nomor terdaftar sebelum kirim

### UI Modern
- Design ala iPhone/iOS
- Dark mode
- Real-time progress ring
- Live activity log

## 🚀 Instalasi

```bash
cd whatsapp-bulk
npm install
npm start
```

Buka `http://localhost:3000`

## 📋 Format File Kontak

CSV atau Excel dengan kolom:
- `phone` / `nomor` - Nomor telepon
- `name` / `nama` - Nama (opsional)

## ⚙️ Pengaturan Default

| Setting | Default | Keterangan |
|---------|---------|------------|
| Delay Min | 8 detik | Minimum jeda antar pesan |
| Delay Max | 15 detik | Maximum jeda antar pesan |
| Batch Size | 25 | Jumlah pesan per batch |
| Batch Rest | 90 detik | Istirahat setelah 1 batch |
| Daily Limit | 500 | Maksimal pesan per hari |

## 📝 Format Pesan WhatsApp

- `*text*` → **bold**
- `_text_` → _italic_
- `~text~` → ~~strikethrough~~
- ``` `text` ``` → `monospace`
