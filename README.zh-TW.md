<div align="center">
  <img src="docs/assets/logo.svg" alt="Dotmole" width="180" />
  <h1>Dotmole</h1>
  <p><em>🐾 好網域都埋得有點深，Dotmole 幫你挖出來。</em></p>
  <p><a href="https://catwithlover.github.io/dotmole/zh-TW/"><strong>Website</strong></a></p>
  <p><a href="README.md">English</a> · <strong>繁體中文</strong></p>
</div>

**Dotmole** 是一個會從名稱與 TLD 中挖掘靈感、檢查可用性，並挑出好網域的 skill。

## 功能

- 根據命名需求產生精簡、相關的域名候選清單。
- 支援品牌名稱、組合詞、替代 TLD 與 domain hack。
- 只推薦 Spaceship 明確回報為可用的域名。
- 標示 premium pricing、TLD 限制與查詢時間。
- 僅查詢可用性，不會註冊、購買、轉移或修改域名與 DNS。

## 安裝

使用 Skills CLI 安裝：

```bash
npx skills add catwithlover/dotmole
```

手動安裝至你欲使用的 agent 中（以 opencode 為例）：

```bash
git clone https://github.com/catwithlover/dotmole
cd dotmole
mkdir -p ~/.config/opencode/skills
cp -r skills/dotmole ~/.config/opencode/skills/
```

安裝後請重新啟動 OpenCode，讓它載入新的 skill。

## 使用方式

將 [`skills/dotmole`](skills/dotmole) 安裝到支援 Agent Skills 的工具後，直接用自然語言描述需求，例如：

```text
幫我替一個名為 QuietPing 的監控服務找可用域名。
優先考慮 .com 和適合開發工具的 TLD，不要連字號、數字或 premium domain。
```

也可以要求 Dotmole 只提供創意、不連線查詢；此時所有結果都會標示為尚未驗證。

## 環境需求

- Node.js 22 或更新版本
- 具有 `domains:read` 唯讀權限的 Spaceship API credentials

## 環境變數

即時查詢需要在啟動 agent 前設定以下變數：

| 變數                   | 用途                 |
| ---------------------- | -------------------- |
| `SPACESHIP_API_KEY`    | Spaceship API key    |
| `SPACESHIP_API_SECRET` | Spaceship API secret |

Linux 或 macOS：

```bash
export SPACESHIP_API_KEY="your-api-key"
export SPACESHIP_API_SECRET="your-api-secret"
```

## 授權

[MIT](LICENSE)
