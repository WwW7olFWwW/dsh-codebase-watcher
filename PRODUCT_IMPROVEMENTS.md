# 產品優化記錄

> 更新：2026-10-20（Round 1～Round 4 完成）
> 產品：`dsh-codebase-watcher` — 讓 Codebase Memory（CBM）圖譜自動跟上各專案 git HEAD 的 DSH 外掛。
> 技術棧：純 ESM Node（`lib/`，無建置）＋ React `createElement` 客戶端（`lib/client.js`）＋ `node:test`。

## 驗證基線（2026-10-20 實測）

| 項目 | 指令 | 結果 |
| --- | --- | --- |
| 單元／整合測試 | `node --test test/*.test.js` | **235 / 235 pass，0 fail**（約 46 秒） |
| 客戶端渲染 | `node tools/verify-client.mjs`（需執行中的 `dsh web`） | **293 / 293** |
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

## 待辦（依影響排序）

| 優先 | 項目 | 證據／現況 | 建議 |
| --- | --- | --- | --- |
| P2 | 失敗與「HEAD 沒追上」的統計語意 | head-mismatch 現在會設 `lastError`、寫 warn，且首屏「需注意」看得到；但仍先 `succeeded++` 才比對，統計把「成功但沒追上」算進成功。 | 統計分「成功且追上」或加 `rebuildsHeadMismatch`；先定義產品語意再改。 |
| P2 | 專案上限 64 會靜默丟棄、孤兒不釋放 | `MAX_TRACKED_PROJECTS=64`；`records.size` 含 `selected=false`／orphaned；只寫 warn。 | 上限只計 selected 且非 orphan，或淘汰最久 orphan 並留 `project.evicted`。 |
| P2 | `POST /check` 永遠回 200 `ok:true` | 單 key 直接 `{ok:true}`，不看 `lastCheckedError`；客戶端因此顯示成功。 | 單 key 回 `ok: lastCheckedError===undefined`（unborn HEAD 例外），route 依結果回 502。 |
| P2 | 初次載入的 0 專案與 0 筆統計容易誤讀 | routes 先註冊、keeper 背景 start；無 `scan.running`；CLI 未解析時卡片紅框。 | status 加 `scan{running,startedAt}`；中性「解析中／首次掃描中」；勿把 revision 當掃過。 |
| P2 | 390px 設定頁不可用（跨層） | DSH settings 殼層只給 154px 內容區，plugin 卡片被壓到 106px、高 4400px；隱藏左 nav 也一樣。 | 需 DSH host 修 settings 窄版版面；plugin 端已讓「需注意」在 106px 可讀，不宣稱已修好。 |
| P3 | 側邊欄指示只靠顏色與總數 | 11px 圓點＋數字，無文字；顏色是唯一線索。 | 寬版顯示「落後 N／失敗 N」，窄版用形狀；`aria-label` 已具備。 |
| P3 | 文件與 CI 仍有時間性數字 | `verify-client` 數量隨 live 專案數變動（267 靜態＋per-project），CI 只跑單元測試。 | 加 `--fixture-only` 進 CI；verify-keeper 需可播種 fixture。 |

## 決策與限制

- **未重啟 `dsh-web`**：本 session 由該服務承載，重啟會中斷會話。後端（keeper／routes）變更以單元、
  整合與真 HTTP 測試為證據；客戶端變更已在 live GUI 以 CDP 實測。若允許重啟，再補一次 live server
  的 `enabled`／取消／REST 400/500 驗證。
- 300 行以上的 `lib/client.js` 與 `lib/keeper.js` 仍是主要複雜度來源；本輪只做小步、可回退修改，
  未大規模重構。
- 500 回應的 `error` 仍可能是內部訊息（已去 stack）；本機外掛可接受，對外部署前應改通用訊息。

## 如何重跑

```bash
npm test                      # 235
npm run test:syntax
npm run docs:check            # 文件漂移守門
node tools/verify-client.mjs  # 293，需 dsh web
node tools/verify-keeper.mjs  # 23，需真實 CBM 與已索引專案
```
