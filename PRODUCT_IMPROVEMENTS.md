# 產品優化記錄

> 更新：2026-10-21（Round 1～Round 11 完成）
> 產品：`dsh-codebase-watcher` — 讓 Codebase Memory（CBM）圖譜自動跟上各專案 git HEAD 的 DSH 外掛。
> 技術棧：純 ESM Node（`lib/`，無建置）＋ React `createElement` 客戶端（`lib/client.js`）＋ `node:test`。

## 驗證基線（2026-10-21 實測）

| 項目 | 指令 | 結果 |
| --- | --- | --- |
| 單元／整合測試 | `node --test test/*.test.js` | **244 / 244 pass，0 fail**（約 55 秒） |
| 客戶端渲染（CI） | `node tools/verify-client.mjs --fixture-only`（不需 `dsh web`） | **306 / 306**（數字穩定，CI 同指令） |
| 客戶端渲染（完整） | `node tools/verify-client.mjs`（需執行中的 `dsh web`） | **308 / 308**（4 個 live 專案時；數量隨 per-project 檢查變動） |
| Keeper 行為 | `node tools/verify-keeper.mjs`（需真實 CBM 與已索引專案） | **23 / 23** |
| 文件漂移 | `npm run docs:check` | 全綠（CI 同指令） |
| 語法 | `npm run test:syntax` | 通過 |
| 空白錯誤 | `git diff --check` | 通過 |
| 真瀏覽器（CDP） | 登入 → 設定 → CBM 圖譜 | 首屏「需注意」可見；兩段式確認焦點在「確定」、`Esc` 取消後焦點回「強制重建」 |

截圖證據：`docs/assets/cbm-card*.png`（舊）、`~/scratch/ui-audit/desktop-top.png`（1180×900 首屏）、
`desktop-details.png`、`mobile-390-card-top.png`（390 寬）。

## 已完成

### Round 1 — 取消重建的語意、文件漂移守門

- **取消 ≠ 失敗**：`lib/cli.js` 保留 `aborted`；`lib/keeper.js` 取消時清 `lastError`、計
  `rebuildsAborted`、寫 `rebuild.cancelled`，不再掉進「stdout 為空」的失敗分支，狀態落回 `idle`。
- **文件校正**：測試數 204→214→216、verify-client 212→270→293、相容表補到 0.6.x、上游狀態改絕對
  日期；README／README.en／CONTRIBUTING／DEVELOPMENT／ARCHITECTURE／CONFIGURATION／LIMITATIONS／
  PUBLISHING 同步。
- **新增 `tools/check-docs.mjs` + `npm run docs:check`**：比對單元測試數、verify-client 數、相容版本、
  英文介面零 CJK、相對連結；CI 的 syntax job 已跑。

### Round 2 — 總開關、REST 契約、首屏可讀性

- **`enabled: false` 真的只停自動化**：啟動不掃描、不恢復 crash-recovery；自動來源的排入全部拒絕；
  關閉時清掉尚未開始的自動佇列（running 不中止）；重新開啟後補掃描並接回 crash-recovery；手動
  檢查／重建不受影響。`recoverIntent()` 只對真的排入或已被掃描接手的專案計數。
- **REST 契約**：`id` 有出現但非非空字串 → 400 `{error,route,code:'bad-request'}`，不再被當成
  「全部」；未預期例外 → 500 `{error,route,code:'internal'}`（不帶 stack）；`/cancel` 無 id 參數。
- **設定頁首屏**：Stats／CLI 之前新增「需注意」摘要（最多 3 筆：專案名、單句原因、立即檢查），
  專案卡收合時直接顯示原因與 `behindBy`；1180×900 首屏可見（y≈134）。
- **對比與無障礙**：11–12px 次要文字改 `label-secondary`；狀態徽章改「可讀文字＋tone 圓點」；
  兩段式確認補 `role=group`／`aria-live`／自動聚焦／`Esc` 取消／焦點返回；專案動作鈕與 details
  的 `aria-label` 帶專案名；設定未儲存徽章收起仍可見；無效數字以 `aria-describedby` 關聯錯誤；
  沒有落後專案時「重建所有落後」停用。
- **`lib/cbm.js:361-366` 仍濾掉 `aborted`**：keeper 以同一顆 `AbortController` 的訊號補位，行為正確，
  介面契約待後續整理。

### Round 3 — 重建鎖所有權、exec 保證收尾

- **重建鎖有身份也有存活檢查**：鎖檔改寫 `{pid, token, at}`。EEXIST 時用 `kill(pid, 0)` 探活，
  ESRCH 立即接管；活著的 pid 不論 mtime 多舊都回 busy。沒有可解析 pid 的舊格式才看 mtime，
  門檻為 `max(2h, rebuildTimeoutMs + 5min)`，6 小時的合法重建不會在 2 小時被誤接管。
  接管前重讀內容比對、最多重試 3 次；release 只刪自己 token 的鎖，mismatch 只警告。
- **exec 一定 settle**：`terminate()` 另外 arm 一個 `killGraceMs + 1000` 的 fallback timer；
  孫行程持有 stdout/stderr 讓 `close` 永遠不來時，destroy 兩條 pipe 並以
  `signal: 'SIGKILL'` 收尾。新增 timeout／abort 兩條「孫行程持有 pipe」測試，先紅後綠。
- **測試**：226→234（鎖 6 條、exec 2 條）。`npm test` 234/234、`verify-keeper` 23/23。
- **殘留風險**：pid 重用（無 `/proc/<pid>/starttime` 輔助）仍可能誤判活著；fallback 只關 pipe，
  不殺孫行程，孤兒 `sleep` 可活到自己的期限；崩潰在 open 與 write 之間留下的空鎖仍等 mtime。

### Round 4 — 圖譜 HEAD 失敗不再毒化快取

- **失敗不進快取**：`checkProject()` 只有 `graphHead.ok === true` 才寫
  `{indexedAt, head}`；失敗時不寫，並把 `head.error` 放進 `lastCheckedError`。一次暫時失敗
  不會讓同一個 `indexedAt` 的後續掃描永遠停在 `no-evidence`；下一次掃描會重查，恢復後清掉錯誤。
- **代價**：`graphHead` 持續失敗時，每輪掃描會重付一次 `query_graph`（實測約 2.3 秒/專案）；
  若日後要退避，應另做失敗 TTL，而不是改回無條件快取。
- **測試**：234→235（新增 1 條先紅後綠）；`npm test` 235/235、`verify-keeper` 23/23。

### Round 5 — 單一專案的「立即檢查」不再謊報成功

- **`checkProject()` 回傳證據結果**：只有 `indexStatus`／`graphHead` 失敗才是 `ok:false`；
  工作樹 HEAD 讀不到（unborn HEAD／不是 git 工作樹）仍是有效檢查（`stale=null`），維持 `ok:true`。
- **`POST /check {id}` 失敗回 502**：route 既有 `!ok → 502` 因此生效，客戶端 `run()` 會把
  body 的錯誤訊息放進 `role=alert`；成功回饋也不再顯示錯的專案總數（原本「(3)」是全部專案數）。
- **測試**：235→239（4 條 keeper，先紅 2 條）；verify-client 293→295（等於比對＋502 夾具）。
  `npm test` 239/239、`verify-client` 295/295、`verify-keeper` 23/23。

### Round 6 — 專案上限不再被孤兒／被排除的專案佔死

- **上限只計有效專案**：`refresh()` 先掃完整份上游、標完孤兒，再以
  `active = 本輪仍回報 && selected && !orphaned` 判斷 64 上限。孤兒與被 include/exclude
  排除的記錄不再佔名額，新專案可以在同一輪被納管，不必等下一輪。
- **警告說得出現況**：真的滿 64 個有效專案時，`project.limit-reached` 帶 `{limit, skipped, active}`，
  不再只有一句「已達上限」。
- **測試**：239→241（2 條走真實 refresh；先紅 2/2）；`npm test` 241/241、`verify-keeper` 23/23。
- **殘留風險**：孤兒與被排除的記錄保留在記憶體，總數仍可能超過 64；既有 active 超過 64 時
  只擋新專案、不淘汰既有。若需要硬總量上限，另立任務。

### Round 7 — 首次載入不再說謊，「成功但沒追上」不再混進成功

- **掃描空窗變成契約**：`status` 新增 `scan{running,reason,startedAt,finishedAt}` 與
  `cliChecked`；`runRefresh` 拆成 wrapper（保證所有返回路徑都收尾）＋`performRefresh`（原邏輯）。
  卡片第一次載入顯示「掃描中…／正在讀取專案清單與 HEAD」，CLI 欄位顯示「檢查中…」；
  「（未解析）」與紅框只留給真的解析失敗。舊 host 沒有欄位時前端維持原行為。
- **統計語意拆開**：重建成功但圖譜 HEAD 仍與工作樹不同時，改記 `RebuildsUnchanged`
  （與 `RebuildsSucceeded` 互斥），`rebuild.done` 帶 `caughtUp`，dirty-chase 警告的分母
  一併計入；成效列在 `>0` 時附「· 未追上 N」。文件 22 鍵／11 概念同步。
- **測試**：241→244（head mismatch、scan 狀態、cliChecked）；verify-client 295→304
  （首次載入 5、掃描完成空清單 1、未追上 1，另加 2 條隨第 4 個 live 專案自動生成）。
  `npm test` 244/244、`verify-client` 304/304、`verify-keeper` 23/23。
- **踩到並修掉**：`sinceStartRebuildMs > 0` 的假設在同毫秒完成時會紅（改 `Number.isFinite`）；
  字典漏 `label.scanRunning` 讓「掃描中…」顯示成鍵名，verify-client 擋下後補齊。

### Round 8 — 客戶端驗證進 CI，數字不再隨 live 專案漂移

- **`--fixture-only`**：同一組斷言改成餵夾具，不連伺服器。CI 新增
  `npm run verify:client:fixture`（302/302）；文件改引用這個穩定數字，完整模式
  （304/304，含 live 逐值比對）另行註明「隨專案數變動」。在此之前 `verify-client`
  根本沒進 CI，2600 行的客戶端只能靠手跑。
- **抓到一條假綠**：HEAD 逐值斷言只比前 8 碼，而卡片輸出的是完整 40 碼，兩者恰好
  是子字串關係，所以「卡片截斷」永遠測不出來。改成比完整 40 碼，夾具也補上完整
  HEAD，才真的驗到逐值呈現。
- **測試**：`verify-client --fixture-only` 302/302、完整模式 304/304、`verify-keeper`
  23/23、單元測試 244/244；`docs:check` 全綠（verify-client 數字三處一致）。
- **殘留**：`--fixture-only` 不覆蓋「真實 `/state` 的形狀」；live 模式仍是本機手動
  步驟。CI 若要有真資料，得另起可播種的 CBM／GUI。

### Round 9 — 空清單不再把「還不知道」說成「沒有」

- **兩種空清單說實話**：掃描失敗時（有 `lastRefreshError`）改說「掃描失敗，還不知道
  有哪些專案；修正後按重新載入再試」；`enabled=false` 且從未掃描時改說「自動化已停用，
  還沒有掃描過」。優先序：掃描中 → 掃描失敗 → 停用未掃描 → 真的沒有專案。
- **測試**：verify-client 302→304（2 條新夾具）；完整模式 306/306；單元測試 244/244。
- **殘留**：只改文案，不改變「掃描失敗時清單可能停在舊資料」的事實；舊資料仍由
  「資料時間」與錯誤橫幅標示。

### Round 10 — 設定欄位就地看得懂

- **每個設定欄位加一行說明**：展開「設定」後，18 個欄位不再只有 `dirtySettleSeconds`
  這種生鍵。說明由字典提供（zh/en 各 18 條），host 若新增 client 不認識的欄位就不畫，
  不會露出 `config.help.xxx`。
- **驗證**：verify-client `--fixture-only` 304→306（2 條）；完整模式 308/308；
  以 headless Chromium 開設定頁截圖確認實際排版（`~/scratch/ui-audit/r10-config.png`）。
- **殘留**：說明是摘要，完整語意仍在 `docs/CONFIGURATION.md`；兩邊若分岔，文件是權威。

### Round 11 — 空篩選與截斷清單多說一步

- **篩選無結果**：原本只說「沒有符合這個條件的專案。」，現在多一句「改選『全部』看完整清單」，
  把下一步直接寫在卡住的位置。
- **「需注意」超過 3 筆**：原本只說「還有 N 個」，現在補「見下方清單」，避免使用者往上看
  找不到東西。
- **驗證**：verify-client `--fixture-only` 306/306（字串改動，斷言數量不變）；`docs:check` 8 項。
- **殘留**：兩處都只有文字，沒有「一鍵清除篩選」按鈕；chips 就在上方，成本效益不足。

## 待辦（依影響排序）

| 優先 | 項目 | 證據／現況 | 建議 |
| --- | --- | --- | --- |
| P2 | 390px 設定頁不可用（跨層） | DSH settings 殼層只給 154px 內容區，plugin 卡片被壓到 106px、高 4400px；隱藏左 nav 也一樣。 | 需 DSH host 修 settings 窄版版面；plugin 端已讓「需注意」在 106px 可讀，不宣稱已修好。 |
| P3 | 側邊欄指示只靠顏色與總數 | 11px 圓點＋數字，無文字；顏色是唯一線索。 | 寬版顯示「落後 N／失敗 N」，窄版用形狀；`aria-label` 已具備。 |

## 決策與限制

- **已在 2026-10-20 14:20 重啟 `dsh-web` 並做 live 驗證**：`/state` 200、3 個專案、啟動掃描
  `stale=0`；`POST /check`／`/rebuild`／`/watchers` 的錯誤 `id` 都回 400 `code:'bad-request'`；
  單一專案 `/check` 回 200 `ok:true`；把 `cliPath` 暫時指向失敗的假 CLI 後，單一 `/check` 回
  502（`CLI 沒有輸出（stdout 為空）`），恢復設定後再檢查回到 `stale=false`、`lastCheckedError` 清空。
  live GUI 實測單專案成功回饋為「已重新檢查這個專案」，沒有 `(N)` 尾碼。假 CLI 測試期間該專案
  曾短暫顯示「無法判定」，已由恢復後的手動檢查證明可回到已同步；log 無 error 級事件。
- **Round 7 的 live 驗證**：重啟 `dsh-web` 一次以載入 host 改動（`/state` revision 19、
  `scan.reason='timer'`、`cliChecked=true`、4 個專案）；首次載入空窗以 verify-client 的夾具
  驗證，未再重啟。使用者已明確要求：**未經同意不得執行任何可能讓 dsh 重啟的指令**，後續
  host 改動先詢問。
- 300 行以上的 `lib/client.js` 與 `lib/keeper.js` 仍是主要複雜度來源；本輪只做小步、可回退修改，
  未大規模重構。
- 500 回應的 `error` 仍可能是內部訊息（已去 stack）；本機外掛可接受，對外部署前應改通用訊息。

## 如何重跑

```bash
npm test                      # 244
npm run test:syntax
npm run docs:check            # 文件漂移守門
npm run verify:client:fixture # 306，不需要 dsh web（CI 同指令）
node tools/verify-client.mjs  # 308，完整模式需 dsh web（隨 live 專案數變動）
node tools/verify-keeper.mjs  # 23，需真實 CBM 與已索引專案
```
