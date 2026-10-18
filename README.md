# 溫序 BBT｜PWA-BBT-GD V1.0.0

女性每日體溫與月經週期記錄 PWA。原生 HTML / CSS / JavaScript，不需 npm install、不需編譯、不需後端，可直接放上 GitHub Pages。

## 先完成這三件事

1. 把解壓縮後資料夾內的程式檔案，上傳到 GitHub Repository 根目錄並啟用 Pages。
2. 在 Google Cloud 建立 Drive API Key 與 Web 類型 OAuth Client ID。
3. 在 PWA「設定 → 帳戶與雲端」貼上 API Key、Client ID、Drive 資料夾連結，再按「登入並同步」。

本 ZIP 不包含真實 Google 憑證或個人資料，也尚未代為建立或部署 GitHub Repository。API Key 與 Client ID 不相同，兩者都需要；不要輸入 Client Secret 或服務帳戶金鑰。

## GitHub Pages 部署

1. 建立 Repository，例如 `PWA-BBT-GD`。請勿把個人健康記錄或 Google 私鑰放進 Repository。
2. 解壓縮 `PWA-BBT-GD-V1_0_0.zip`，進入同名資料夾。
3. 將資料夾內檔案平鋪上傳至 Repository 根目錄，確認根目錄直接看得到 `index.html`、`app.js`、`sw.js`、`version.json` 等檔案。
4. 到 Repository → **Settings → Pages**：Source 選 **Deploy from a branch**，Branch 選 **main**，Folder 選 **/(root)**，按 Save。
5. 等待 GitHub 顯示發佈網址，通常為 `https://你的帳號.github.io/PWA-BBT-GD/`。
6. 用此 HTTPS 網址使用。不要直接在檔案管理員雙擊 `index.html`；`file://` 不適用 ES Modules、OAuth 或 Service Worker。
7. iPhone / iPad：Safari 開啟網址 → 分享 → 加入主畫面。Windows：Chrome / Edge 使用網址列的安裝功能。

若 Repository 不叫 `PWA-BBT-GD` 也可使用，所有應用程式路徑皆為相對路徑。更改網址來源網域時，需要更新 Google 的網站授權設定。

## Google Cloud 設定

以下是 Web 類型 Google Identity Services token model，配合 Google Drive REST v3。

### 1. 啟用 API

開啟 [Google Cloud Console](https://console.cloud.google.com/)，選取或建立專案，在 **APIs & Services → Library** 啟用 **Google Drive API**。

### 2. 建立 API Key

在 Credentials 建立 API Key。建議限制：

- Application restrictions：**Websites / HTTP referrers**。
- 允許網站：`https://你的帳號.github.io/*`；若用自訂網域，另加自訂網域。
- API restrictions：**Restrict key → Google Drive API**。

此程式沒有使用 Google Picker API，不需要啟用 Picker。若在本機以 localhost 開發，另加入該 localhost 的網站限制；完成開發後移除不需要的來源。

### 3. 設定 OAuth 同意畫面

在 **Google Auth platform** 設定 Branding / Audience / Data Access。填寫應用程式名稱與支援信箱。若使用個人 Google 帳號，選適用的外部使用者類型；測試狀態下將所有實際要使用的帳號加入 Test users。

此版本使用以下 scopes：

```text
https://www.googleapis.com/auth/drive
openid
email
profile
```

為支援直接指定資料夾、不同帳號共同同步新資料及新備份，使用 Drive 的較廣讀寫範圍。應用程式所有 Drive 查詢與新增檔案都限制在使用者指定的資料夾，但 OAuth 授權本身不是資料夾級的強制限制。正式公開提供多人使用時，須依 Google 的應用程式類型、發布狀態與權限範圍處理驗證要求；不能把測試名單當成公開發佈。

### 4. 建立 Web Client ID

Clients → Create client → Application type：**Web application**。

已授權的 JavaScript 來源填來源網域，例如：

```text
https://lihe-source.github.io
```

這裡**不含 Repository 路徑，不加 `/PWA-BBT-GD/`**。本程式使用彈出式 token flow，不需要填寫程式的 redirect endpoint，也不使用 Client Secret。API Key 與 Client ID 建議來自同一個 Google Cloud 專案。

### 5. 準備 Drive 資料夾

在 Google Drive 建立專用資料夾，例如「BBT-Rex」。將資料夾完整網址貼到 PWA 設定即可，不需要自行擷取 ID。

若要不同 Google 帳號共同記錄同一位女性，將該資料夾共用給指定帳號並給予「編輯者」權限；其他人也必須取得應用程式的 OAuth 授權。不同女性請使用不同資料夾。

此版主要針對 My Drive 中的專用資料夾與共用資料夾。REST 請求包含 shared-drive 支援參數，但公司 Workspace 管理政策、共用雲端硬碟的角色、檔案擁有權與儲存配額，仍由 Google 管理；未完成實際企業帳號驗證。

## 每日使用

### 體溫曲線

- 左上角日／週切換；日模式每天一個主要量測值，週模式為週一至週日的每日主要值平均。
- Y 軸固定 **35.0～40.0°C**；每個資料點上方直接顯示小數第一位的體溫。
- 點擊日期、資料點或相應直向區域，上方立即顯示日期、時間與體溫。日模式也可點編輯圖示修改該筆資料。
- 同日多筆時，可查看當天全部記錄。週模式點擊後顯示週日期範圍、平均體溫及有效記錄天數，不虛構單次量測時間。
- 預設最近 30 天，可選本月、本次週期與自訂日期；一次最多 366 天。圖表可左右捲動，頁面本身不橫向溢出。
- 缺測日不補零，日曲線斷開。週平均只用範圍內有記錄的日，不把漏記日當零，也不因一天量比較多次而加權。
- 新增／編輯體溫可指定每日主要值；沒有指定時，優先使用最早的未受干擾基礎體溫，否則使用最早量測。
- 超過圖表上下限的數值保留原值，透過上下箭頭標示，不截成 35 或 40。為攔截明顯輸入錯誤，儲存支援範圍為 20.0～50.0°C。

### 體溫記錄

日期時間預設為個人設定時區的當下時間，可手動修改；體溫不預填。勾選「起床活動前量測的基礎體溫」才能參與基礎體溫分析，可另勾選干擾因素與填備註。同日可新增多筆，按鈕連點不會重複提交。

每筆儲存實際輸入的日期、時間及量測時區；更換顯示時區或在不同地點使用，不會把既有量測移到前一天／後一天。

月經記錄在同頁另一個分頁。結束日未填代表進行中，曲線的月經色帶會延續至今天；結束後請補填結束日。

### 排卵與高溫期參考

這是記錄與趨勢工具，並非經臨床驗證的醫療器材、避孕方法或排卵診斷工具。

- 排卵日期推估：需要至少一筆月經開始日，初期參考自填平均週期；累積至少三個完整週期後取最近最多六個週期的中位數估計下次經期，參考經期前約 10～16 天，並按週期變動擴大日期範圍。
- 近期週期出現小於 21 天／大於 35 天，或至少三個週期相差超過 7 天時，停止日期推估。超過推估經期 7 天且未補登時，提示補登，不持續顯示過期日期。
- 高溫期簡化趨勢：最近 9 個連續日都需有有效的每日主要基礎體溫。前 6 天作參考，後 3 天均高於前 6 天的最高值，且第 3 天至少比前 6 天中位數高 0.2°C，顯示「可能進入高溫期」。只作趨勢提示，不由此宣稱精確排卵日。
- 受干擾、非基礎體溫、有資料差異、超出 35～40°C、或缺測的資料不納入高溫期判讀。週平均不拿來判定排卵。
- 生病、藥物、輪班、產後、哺乳、荷爾蒙用藥及其他身體狀況可能讓週期推估不適用；此程式沒有建立這些特殊狀況的臨床模型。
- 依需求採用 0.1°C；細微升溫變化可能不易呈現。

## 同步、備份與還原

### 自動同步

儲存先以 IndexedDB 本機交易完成，連線有效時約 1.8 秒後同步。開啟期間每 60 秒檢查遠端；網路恢復或回前景時立即排程同步。OAuth token 僅保存在記憶體，不放進 JSON 備份或 GitHub。

Google token 有效期有限；重新開啟 PWA、token 過期或 Google 要求驗證時，需要按「重新連線並同步」。本機快取與尚未上傳資料會保留。這個純 GitHub Pages 版本不保證永久免操作登入，也不保證關閉後的背景同步。

資料以不可變的異動 JSON 檔保存，不直接以本機整份檔案覆寫雲端。每個操作有唯一識別碼，並預先保存 Drive 檔案 ID，處理逾時重試、重複上傳與兩台裝置並行修改。

- 修改不同記錄：自動合併。
- 同筆記錄／每日主要值／個人設定同時被改：保留多個版本，透過「處理差異」選擇。
- 刪除：同步刪除標記，舊資料不直接復活。
- 同步不根據記錄筆數、記錄天數或裝置時間挑選整份資料覆蓋另一份。
- 帳號與資料夾使用不同本機區域；切換不會自動把 A 的記錄傳給 B。第一次把未連線區加入指定資料夾時會先提示，原本未連線資料保留。

Google Drive 內的 `bbt-event-*.json` 是異動來源，`bbt-backup-*.json` 是完整快照。請勿自行編輯、搬走或刪除這些檔案；備份清單只顯示 5 份不會自動刪除較舊檔案。檔案數量會隨使用增加，第一版不自動清理異動歷史，以免破壞離線裝置同步。

### 備份與還原

有實際異動且同步成功、沒有未處理差異時，會建立完整快照；重複同步同一狀態不重複自動備份。可手動建立新快照。

預設最新 5 份，依 Drive 伺服器建立時間排序並預選最新。每份顯示有記錄天數、記錄筆數、涵蓋日期、備份時間與顯示時區。較早備份可展開。

還原時先下載並檢查格式、顯示差異、取得使用者確認，再儲存本機安全備份與雲端還原前備份。任一必要備份失敗時不執行雲端還原。還原會建立新版本，影響同一資料夾全部共同使用者；舊裝置補傳會另列為待處理資料，不直接加回。兩台裝置同時做不同還原時，也需明確選擇。

本機安全備份最多保留 10 份，可匯出成 JSON；再使用 JSON 匯入操作恢復。JSON 匯入是取代目前資料，而不是無提示合併。CSV 供閱讀與其他軟體分析，不作完整還原用途。

### 資料保管

API Key／Client ID／資料夾設定保存在該瀏覽器的本機資料庫，不隨健康資料備份。API Key 是網站應用程式識別設定，仍應設定網站與 API 限制。Drive JSON 與匯出 JSON 沒有額外的應用程式端加密；存取控制由 Google Drive 與使用裝置的保護提供。

共用裝置上的瀏覽器本機快取不是密碼保護的帳戶保險箱。登出會離開雲端資料畫面，但不刪除本機快取與待上傳記錄。撤銷 Drive 共用權限不能遠端移除其他裝置已下載的副本。

不要在未確認同步／匯出成功前清除 Safari 網站資料、重置瀏覽器或移除儲存區，這可能刪掉尚未上傳資料。離線記錄依賴瀏覽器保留本機儲存，仍建議定期同步或匯出。

## 版本更新

啟動自動讀取 `version.json`。新版 Service Worker 完整快取程式後，會等儲存、同步、登入及對話視窗結束，再保存草稿並切換版本；其他分頁也先保存草稿。失敗則繼續使用原版本，不清除 IndexedDB。

設定顯示當前／最新版本、最後檢查時間及「檢查更新」。Service Worker 只管理目前 Repository 路徑的應用程式快取，不攔截 Google API 或其他 PWA，不快取 token、備份及 `version.json`。

未來發版可在電腦上執行：

```bash
node release.mjs 1.0.1
npm test
```

再將所有程式檔案一起更新上傳。`release.mjs` 會同步修改 `core.js`、`sw.js`、`version.json`、`package.json` 與 HTML 顯示版本。不改版本卻只覆寫 `app.js`，既有安裝可能持續使用快取。新版涉及資料格式時，也需另做相容性／遷移設計，不能只升版本號。

## 常見排除方式

| 情況 | 檢查方式 |
|---|---|
| Google 登入被拒絕／origin_mismatch | Client 類型必須是 Web；來源填 `https://帳號.github.io`，不要加專案路徑。 |
| access_denied／未驗證應用程式 | 檢查 OAuth 測試使用者、發布狀態、同意畫面與使用的 scopes。 |
| API Key 無效／網站限制不符 | Key 限制需允許實際 Pages 網址，且啟用 Google Drive API。 |
| 找不到資料夾 | 確認是資料夾連結；登入帳號須有權限，且資料夾不在垃圾桶。 |
| 沒有寫入權限 | 請資料夾擁有者設為「編輯者」，並檢查 Workspace 政策。 |
| 公司網路阻擋 Google | 換用可正常連上 Google Drive 的網路；待傳資料仍保留在本機。 |
| 網站空白／404 | 確認根目錄有 index.html、Pages 發佈成功，並使用 HTTPS 的 Pages 網址。 |
| 每次重新開啟需要連線 | token 僅存記憶體，是本版的純前端授權限制，不代表本機記錄被刪除。 |
| 找不到較舊記錄 | 先取消歷史記錄日期篩選，並檢查登入帳號與資料夾。 |
| 更新狀態顯示檔案尚未完整發佈 | 確認所有新版檔案已上傳，等待 GitHub 發佈完成後重新檢查。 |

## 測試與檔案

使用 Node.js 20 以上執行 `npm test` 或 `node --test tests.mjs`，不需要安裝依賴。測試使用虛構資料與記憶體雲端，沒有連線真實 Google 帳號。

`TEST-REPORT.md` 記錄本次驗證範圍與未驗證項目。Google OAuth、實際 Drive 帳號、iPhone／iPad／Windows 真機畫面與 GitHub Pages 公開網址仍需在填妥設定、實際部署後驗證；本包未宣稱已完成這些真實環境測試。

主要檔案：`index.html`（介面）、`styles.css`（排版）、`app.js`（互動）、`core.js`（資料與分析）、`db.js`（本機儲存）、`drive.js`（Google 與同步）、`sw.js`（離線／更新）、manifest 與 icons、`version.json`、`tests.mjs`、`release.mjs`。所有檔案位於同一層。

## 官方參考資料

- [Google OAuth token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Google Drive API 權限範圍](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google OAuth 同意畫面](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [Google Drive 檔案建立](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create)
- [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [ASRM：Ovulation Detection](https://www.reproductivefacts.org/news-and-publications/fact-sheets-and-infographics/ovulation-detection/)
- [NHS：Periods and fertility](https://www.nhs.uk/conditions/periods/fertility-in-the-menstrual-cycle/)
- [Mayo Clinic：Basal body temperature](https://www.mayoclinic.org/tests-procedures/basal-body-temperature/about/pac-20393026)
