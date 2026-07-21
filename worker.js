// 環境変数: OPENAI_API_KEY, MEDI_KV(バインディング), HELP_TEXT(ヘルプタブ用文章), KANI_TIPS(トップのつぶやき用), RESEND_API_KEY(オプション:メール送信API), GAS_URL(スプレッドシート連携用), ASK_FORM_URL(問合せフォームURL), G_FORM_ID(フォームの施設ID項目), STRIPE_PORTAL_URL(StripeカスタマーポータルのURL)

function hiraToKata(str) { return str.replace(/[\u3041-\u3096]/g, m => String.fromCharCode(m.charCodeAt(0) + 0x60)); }
function getBestYJ(key, parts) {
  if (key && key.includes("_")) { const yj = key.split("_").pop(); if (/^[0-9a-zA-Z]{7,12}$/.test(yj)) return yj; }
  for (let p of parts) { const m = String(p).match(/[0-9]{5,7}[a-zA-Z][0-9]{3,4}/); if (m) return m[0]; }
  return String(parts[2] || "").replace(/[^a-zA-Z0-9]/g, "");
}
// ===== 🌟修正: カンマズレを完全に防止して正しい規格・薬価・マークを取得する関数 =====
// ===== 🌟追加: 規格文字列から用量(数字＋単位)を取り出して正規化する関数 =====
// 例:「１０ｍｇ１カプセル」→「10mg」、「10%1g」→「10%」。全角も半角に統一して比較用に使う。
function normalizeDose(spec) {
  if (!spec) return "";
  // 全角英数字・記号を半角に変換
  let s = String(spec).replace(/[Ａ-Ｚａ-ｚ０-９％．]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  ).toLowerCase();
  // 先頭付近の「数字（小数含む）＋単位」を抜き出す
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*(mg|g|%|μg|mcg|ml|万単位|単位|iu)/);
  return m ? (m[1] + m[2]) : "";
}

function extractDrugData(parts, yj) {
  const yjIdx = parts.findIndex(p => p.replace(/[^a-zA-Z0-9]/g, "") === yj);
  let name = (parts[0] || "").trim();
  let spec = "";
  let price = "";
  let type = "";

  if (yjIdx > 1) {
    // 空っぽのデータはあらかじめ消しておく
    let preYjParts = parts.slice(1, yjIdx).map(p => p.trim()).filter(p => p !== "");
    
    // 1. まず数字やハイフンだけの要素（＝薬価）を探して抜き出す
    let priceIdx = preYjParts.findIndex(p => /^[0-9\.\-]+$/.test(p) || p === "-");
    if (priceIdx !== -1) {
      price = preYjParts[priceIdx];
      preYjParts.splice(priceIdx, 1); // 薬価を配列から取り除く
    }
    
    // 2. マーク（先発、麻、劇など）を探して分離する
    let marks = [];
    preYjParts = preYjParts.filter(p => {
      if (p.includes("先発") || p === "麻" || p === "劇" || p === "局" || p.includes("後発")) {
        marks.push(p);
        return false; // マークだったら規格の配列からは消す
      }
      return true; // それ以外（規格）は残す
    });
    
    spec = preYjParts.join("，"); // 残ったものを規格とする
    type = marks.join(" "); // マークを結合
  } else {
    spec = parts[1] || "";
    price = parts[2] || "";
    type = parts[3] || "";
  }
  return { name, spec: spec.trim(), price, type: type.trim() };
}
// ====================================================================
// 環境変数: OPENAI_API_KEY, MEDI_KV(バインディング), HELP_TEXT(ヘルプタブ用文章), KANI_TIPS(トップのつぶやき用), RESEND_API_KEY(オプション:メール送信API), GAS_URL(スプレッドシート連携用), ASK_FORM_URL(問合せフォームURL), G_FORM_ID(フォームの施設ID項目), STRIPE_PORTAL_URL(StripeカスタマーポータルのURL)
// ===== 🌟新規追加: 採用薬の1本化JSONを再構築する強力な関数 =====
async function rebuildAdoptedJson(hId, env) {
  let currentKeys = [];
  let cursorStr = "";
  
  // 1. その施設の採用薬キーを全件取得（システム用のキーは除外）
  do {
    const list = await env.MEDI_KV.list({ prefix: `${hId}_`, limit: 1000, cursor: cursorStr || undefined });
    currentKeys.push(...list.keys.map(k => k.name).filter(n => 
      !n.endsWith("_meta") && !n.endsWith("_pwd") && !n.endsWith("_userpwd") && 
      !n.endsWith("_email") && !n.endsWith("_board") && !n.endsWith("_ranking") && 
      !n.endsWith("_name") && !n.includes("_report_") && !n.includes("COMP_") && 
      !n.endsWith("_adopted_list_json")
    ));
    cursorStr = list.list_complete ? "" : list.cursor;
  } while (cursorStr);

  // 🌟追加: マスターキーの一覧を取得（YJコードで引き当てられるようにする）
  let masterKeys = [];
  for (const c of ["[内]", "[外]", "[注]"]) {
    let mCursor = "";
    do {
      const list = await env.MEDI_KV.list({ prefix: c, limit: 1000, cursor: mCursor || undefined });
      masterKeys.push(...list.keys.map(k => k.name));
      mCursor = list.list_complete ? "" : list.cursor;
    } while (mCursor);
  }

  const allDrugList = [];
  
  // 2. 50件ずつKVから中身（Value）を取得して配列に詰め込む
  for (let i = 0; i < currentKeys.length; i += 50) {
    const chunk = currentKeys.slice(i, i + 50);
    const vals = await Promise.all(chunk.map(k => env.MEDI_KV.get(k)));
    
    // 🌟追加: チャンクごとに必要なマスターのキーを特定し、一括取得する
    const masterKeysToFetch = [];
    chunk.forEach((k, idx) => {
      if (vals[idx]) {
        let parts = String(vals[idx]).split(/[,\uFF0C]/);
        const yj = getBestYJ(k, parts);
        if (yj && yj !== "NONE") {
          const masterKey = masterKeys.find(mk => mk.endsWith(`_${yj}`) || mk.endsWith(yj));
          masterKeysToFetch.push(masterKey || null);
        } else {
          masterKeysToFetch.push(null);
        }
      } else {
        masterKeysToFetch.push(null);
      }
    });

    const masterVals = await Promise.all(masterKeysToFetch.map(mk => mk ? env.MEDI_KV.get(mk) : Promise.resolve(null)));
    // 🌟ここまで
    
    chunk.forEach((k, idx) => {
      if (vals[idx]) {
        let parts = String(vals[idx]).split(/[,\uFF0C]/);
        const yj = getBestYJ(k, parts);

        // 🌟追加: 取得したマスタデータで上書きし、マークや薬価を完全復活させる
        if (masterVals[idx]) {
          const mParts = String(masterVals[idx]).split(/[,\uFF0C]/);
          const mYjIdx = mParts.findIndex(p => p.replace(/[^a-zA-Z0-9]/g, "") === yj);
          if (mYjIdx !== -1) {
            parts = mParts.slice(0, mYjIdx + 1);
          }
        }
        // 🌟ここまで

        const ext = extractDrugData(parts, yj);
        const catMatch = k.match(/\[(内|外|注)\]/);
        
        // 🌟追加: キーから成分名を抽出する
        const keyParts = k.split('_');
        const compName = keyParts.length > 2 ? keyParts[keyParts.length - 2] : "";
        
        allDrugList.push({
          key: k,
          cat: catMatch ? catMatch[0] : "[内]",
          name: ext.name,
          spec: ext.spec,
          type: ext.type.replace(/先発品?/g, ""),
          yj: yj,
          price: ext.price,
          isBrand: parts.some(p => String(p).includes("先発")),
          isAdopted: true,
          component: compName // 🌟追加: JSONに成分名を保存！
        });
      }
    });
  }
  
  // 3. YJコード順（昇順）に綺麗に並び替える
  allDrugList.sort((a, b) => (a.yj || "").localeCompare(b.yj || ""));
  
  // 4. 完成した巨大配列を1つのJSONとして一発保存！
  await env.MEDI_KV.put(`${hId}_adopted_list_json`, JSON.stringify(allDrugList));
}
// ==============================================================

// === 🦀休薬チェッカー: ページ生成関数 (ここから) ===
function kyuyakuAdminPage(hId, isSuper) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦀</text></svg>">
<title>休薬マスタ管理 🦀 メディカニ</title>
<link rel="icon" type="image/png" sizes="512x512" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; background: #f4f7f9; color: #333; padding-bottom: 120px; }
  .header { background: linear-gradient(135deg, #e85a4f, #d94f45); color: #fff; padding: 14px 16px; position: sticky; top: 0; z-index: 50; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
  .header h1 { font-size: 17px; }
  .header .sub { font-size: 11px; opacity: .9; margin-top: 2px; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 12px; }
  .banner { background: #fff3cd; border: 1px solid #ffe69c; color: #7a5c00; border-radius: 10px; padding: 10px 12px; font-size: 12px; line-height: 1.6; margin-bottom: 12px; }
  .banner.red { background: #fde8e8; border-color: #f5b5b5; color: #9b1c1c; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.08); padding: 12px; margin-bottom: 12px; }
  .card h2 { font-size: 14px; color: #d94f45; margin-bottom: 8px; }
  .comp-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
  .comp-name { font-size: 15px; font-weight: bold; }
  .comp-class { font-size: 11px; color: #0056b3; background: #e3f2fd; border: 1px solid #bbdefb; border-radius: 4px; padding: 2px 6px; display: inline-block; margin-top: 4px; }
  .tag { font-size: 10px; padding: 2px 7px; border-radius: 10px; white-space: nowrap; }
  .tag.def { background: #eee; color: #666; }
  .tag.ovr { background: #e85a4f; color: #fff; }
  .tag.ok { background: #d4edda; color: #155724; }
  .tag.ng { background: #f8d7da; color: #721c24; }
  .matrix { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 10px; }
  @media (min-width: 640px) { .matrix { grid-template-columns: repeat(4, 1fr); } }
  .cell { border: 1px solid #e0e6ea; border-radius: 10px; padding: 8px; cursor: pointer; background: #fafcfd; }
  .cell:active { background: #eef4f8; }
  .cell .cat { font-size: 10px; color: #888; margin-bottom: 4px; }
  .cell .act { font-size: 13px; font-weight: bold; }
  .act.continue { color: #1e7e34; } .act.stop { color: #c0392b; } .act.consult { color: #b96b00; }
  .cell .days { font-size: 11px; color: #555; }
  .cell .cmt { font-size: 10px; color: #999; margin-top: 3px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .comp-foot { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .btn { border: none; border-radius: 8px; padding: 8px 12px; font-size: 12px; cursor: pointer; font-weight: bold; }
  .btn.small { padding: 5px 10px; font-size: 11px; }
  .btn.gray { background: #eceff1; color: #555; }
  .btn.blue { background: #0d6efd; color: #fff; }
  .btn.green { background: #28a745; color: #fff; }
  .btn.red { background: #e85a4f; color: #fff; }
  .btn:disabled { opacity: .5; }
  .savebar { position: fixed; bottom: 0; left: 0; right: 0; background: #fff; border-top: 1px solid #ddd; padding: 10px 12px; display: flex; gap: 8px; align-items: center; z-index: 60; box-shadow: 0 -2px 10px rgba(0,0,0,.08); flex-wrap: wrap; }
  .savebar input { flex: 1; min-width: 120px; border: 1px solid #ccc; border-radius: 8px; padding: 8px; font-size: 13px; }
  .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 100; align-items: flex-end; justify-content: center; }
  .modal { background: #fff; border-radius: 16px 16px 0 0; width: 100%; max-width: 640px; max-height: 88vh; overflow-y: auto; padding: 16px; }
  @media (min-width: 640px) { .modal-bg { align-items: center; } .modal { border-radius: 16px; } }
  .modal h3 { font-size: 15px; color: #d94f45; margin-bottom: 10px; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 11px; color: #777; margin-bottom: 4px; font-weight: bold; }
  .field input, .field select, .field textarea { width: 100%; border: 1px solid #ccc; border-radius: 8px; padding: 9px; font-size: 14px; }
  .field textarea { min-height: 64px; }
  .cat-desc { font-size: 11px; color: #666; line-height: 1.6; }
  .match-info { font-size: 11px; margin-top: 6px; color: #555; background: #f0f6ff; border-radius: 6px; padding: 6px 8px; display: none; }
</style></head><body>

<div class="header">
  <h1>🦀 休薬マスタ管理</h1>
  <div class="sub">施設ID: ${hId} ${isSuper ? "／👑 共通デフォルト編集権限あり" : ""}</div>
</div>

<div class="wrap">
  <div class="banner">
    値はすべて「参考情報」です。実際の休薬判断は<b>処方医・薬剤師の確認</b>を前提としてください。編集したセルは施設カスタム値（<span class="tag ovr">施設</span>）として保存され、共通デフォルト（<span class="tag def">既定</span>）より優先されます。
  </div>

  <div class="card">
    <h2>処置分類</h2>
    <div id="catList" class="cat-desc">読み込み中…🦀</div>
  </div>

  <div class="card" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
    <button class="btn blue" onclick="checkAllMatches()">🔍 採用薬とYJコード照合（全成分）</button>
    <button class="btn green" onclick="openCompEdit(null)">＋ 成分を追加</button>
    <span id="matchSummary" style="font-size:11px; color:#666;"></span>
  </div>

  <div id="compList"></div>
</div>

<div class="savebar">
  <input type="password" id="adminPwd" placeholder="管理パスワード">
  <button class="btn red" onclick="saveMaster('facility')">💾 施設マスタとして保存</button>
  ${isSuper ? '<button class="btn gray" onclick="saveMaster(&quot;default&quot;)">👑 共通デフォルトとして保存</button>' : ''}
</div>

<!-- セル編集モーダル -->
<div class="modal-bg" id="cellModalBg">
  <div class="modal">
    <h3 id="cellModalTitle">セル編集</h3>
    <div class="field"><label>アクション</label>
      <select id="cellAction">
        <option value="continue">継続可</option>
        <option value="stop">休薬</option>
        <option value="consult">処方元に照会</option>
      </select>
    </div>
    <div class="field"><label>休薬日数（「休薬」のとき。0=当日から）</label>
      <input type="number" id="cellDays" min="0" max="60" placeholder="例: 7">
    </div>
    <div class="field"><label>コメント（画面・PDFに表示されます）</label>
      <textarea id="cellComment"></textarea>
    </div>
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button class="btn gray" onclick="closeModal('cellModalBg')">キャンセル</button>
      <button class="btn red" onclick="saveCell()">反映</button>
    </div>
  </div>
</div>

<!-- YJコード照合モーダル -->
<div class="modal-bg" id="yjModalBg">
  <div class="modal">
    <h3 id="yjModalTitle">YJコード照合</h3>
    <div style="font-size:11px; color:#777; margin-bottom:8px;">この成分の判定に使うYJコード（先頭7桁）の一覧です。ここに登録された番号の薬が休薬判定でヒットします。</div>
    <div id="yjList"></div>
    <div style="display:flex; gap:6px; margin:10px 0; flex-wrap:wrap;">
      <input id="yjAddCode" placeholder="YJ先頭7桁" maxlength="7" style="width:110px; border:1px solid #ccc; border-radius:8px; padding:8px; font-size:13px;">
      <input id="yjAddName" placeholder="成分名（任意）" style="flex:1; min-width:130px; border:1px solid #ccc; border-radius:8px; padding:8px; font-size:13px;">
      <button class="btn small green" onclick="addYjManual()">＋追加</button>
    </div>
    <div style="display:flex; gap:8px; justify-content:space-between; flex-wrap:wrap;">
      <button class="btn small blue" onclick="autoAddFromAdopted()">🔍 採用薬から自動追加</button>
      <button class="btn gray" onclick="closeModal('yjModalBg')">閉じる</button>
    </div>
  </div>
</div>

<!-- 成分編集モーダル -->
<div class="modal-bg" id="compModalBg">
  <div class="modal">
    <h3 id="compModalTitle">成分編集</h3>
    <div class="field"><label>成分名（表示用）</label><input id="compName"></div>
    <div class="field"><label>薬効分類（表示用）</label><input id="compClass" placeholder="例: 抗血小板薬"></div>
    <div class="field"><label>照合キーワード（カンマ区切り。成分名の部分一致に使用）</label><input id="compKeys" placeholder="例: クロピドグレル"></div>
    <div class="field"><label>再開の目安</label><input id="compResume"></div>
    <div class="field"><label>メモ（出典・根拠・監修記録など）</label><textarea id="compMemo" placeholder="例: ○○学会ガイドライン20XX年版／7/20 薬局長確認済み"></textarea></div>
    <div style="display:flex; gap:8px; justify-content:space-between; flex-wrap:wrap;">
      <button class="btn gray small" id="btnResetComp" onclick="resetCompToDefault()">↩ デフォルト値に戻す</button>
      <div style="display:flex; gap:8px;">
        <button class="btn gray" onclick="closeModal('compModalBg')">キャンセル</button>
        <button class="btn red" onclick="saveCompMeta()">反映</button>
      </div>
    </div>
  </div>
</div>

<script>
const HID = "${hId}";
let DEF = null;      // 共通デフォルト
let OVR = null;      // 施設オーバーライド { components: [...] }
let ovrMap = {};     // id -> 施設カスタム成分
let adoptedCache = null;
let editingCompId = null, editingCatId = null;

const ACT_LABEL = { continue: "継続可", stop: "休薬", consult: "処方元に照会" };

// --- 起動：マスタ読み込み ---
async function loadMaster() {
  const res = await fetch('/api/kyuyaku/master?h=' + HID);
  const data = await res.json();
  DEF = data.def || { version: 1, status: "DRAFT_UNREVIEWED", categories: [], components: [] };
  OVR = data.ovr || { components: [] };
  ovrMap = {};
  (OVR.components || []).forEach(c => ovrMap[c.id] = c);
  render();
}

// --- マージ済み一覧を返す（施設カスタム優先、施設追加分も含む） ---
function mergedComponents() {
  const defIds = new Set((DEF.components || []).map(c => c.id));
  const list = (DEF.components || []).map(c => ovrMap[c.id] ? { ...ovrMap[c.id], _ovr: true } : { ...c, _ovr: false });
  Object.values(ovrMap).forEach(c => { if (!defIds.has(c.id)) list.push({ ...c, _ovr: true, _facilityOnly: true }); });
  return list;
}

function esc(s) { return String(s == null ? "" : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// --- 描画 ---
function render() {

  const cats = DEF.categories || [];
  document.getElementById('catList').innerHTML = cats.map(c =>
    '<div style="margin-bottom:4px;"><b>' + esc(c.label) + '</b>：' + esc(c.desc) + '</div>'
  ).join('') || '分類が未設定です';

  const comps = mergedComponents();
  const byClass = {};
  comps.forEach(c => { (byClass[c.class] = byClass[c.class] || []).push(c); });

  let html = '';
  for (const cls of Object.keys(byClass)) {
    html += '<div style="font-size:12px; color:#888; font-weight:bold; margin:14px 4px 6px;">▍ ' + esc(cls) + '</div>';
    html += byClass[cls].map(c => compCard(c, cats)).join('');
  }
  document.getElementById('compList').innerHTML = html || '<div class="card">成分がありません。「＋成分を追加」から登録してください🦀</div>';
}

function compCard(c, cats) {
  const cells = cats.map(cat => {
    const r = (c.rules || {})[cat.id] || { action: "consult", days: null, comment: "" };
    const daysTxt = (r.action === "stop") ? ((r.days === 0) ? "当日から" : (r.days != null ? r.days + "日前から" : "日数未設定")) : "";
    return '<div class="cell" onclick="openCellEdit(\\'' + esc(c.id) + '\\',\\'' + esc(cat.id) + '\\')">' +
      '<div class="cat">' + esc(cat.label) + '</div>' +
      '<div class="act ' + esc(r.action) + '">' + (ACT_LABEL[r.action] || r.action) + '</div>' +
      '<div class="days">' + esc(daysTxt) + '</div>' +
      (r.comment ? '<div class="cmt">' + esc(r.comment) + '</div>' : '') +
      '</div>';
  }).join('');

  const badges =
    (c._ovr ? '<span class="tag ovr">施設</span>' : '<span class="tag def">既定</span>') +
    (c.verified ? '<span class="tag ok">YJ照合済(' + (c.yj7List || []).length + ')</span>' : '<span class="tag ng">YJ未照合</span>');

  return '<div class="card">' +
    '<div class="comp-head"><div>' +
      '<div class="comp-name">' + esc(c.component) + '</div>' +
      '<span class="comp-class">' + esc(c.class) + '</span>' +
    '</div><div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end;">' + badges + '</div></div>' +
    '<div class="matrix">' + cells + '</div>' +
    '<div class="match-info" id="match_' + esc(c.id) + '"></div>' +
    '<div class="comp-foot">' +
      '<button class="btn small blue" onclick="openYjModal(\\'' + esc(c.id) + '\\')">🔍 YJコード照合</button>' +
      '<button class="btn small gray" onclick="openCompEdit(\\'' + esc(c.id) + '\\')">✏️ 成分情報</button>' +
      '<span style="font-size:10px; color:#aaa; align-self:center;">再開: ' + esc(c.resume || '—') + ' ／ メモ: ' + esc(c.source || '—') + '</span>' +
    '</div></div>';
}

// --- 編集時：対象成分を施設カスタムへ昇格させて返す ---
function ensureOvr(id) {
  if (ovrMap[id]) return ovrMap[id];
  const base = (DEF.components || []).find(c => c.id === id);
  ovrMap[id] = JSON.parse(JSON.stringify(base));
  return ovrMap[id];
}
function getComp(id) { return ovrMap[id] || (DEF.components || []).find(c => c.id === id); }

// --- セル編集 ---
function openCellEdit(compId, catId) {
  editingCompId = compId; editingCatId = catId;
  const c = getComp(compId);
  const cat = (DEF.categories || []).find(x => x.id === catId);
  const r = (c.rules || {})[catId] || { action: "consult", days: null, comment: "" };
  document.getElementById('cellModalTitle').textContent = c.component + ' × ' + (cat ? cat.label : catId);
  document.getElementById('cellAction').value = r.action || "consult";
  document.getElementById('cellDays').value = (r.days == null) ? '' : r.days;
  document.getElementById('cellComment').value = r.comment || '';
  document.getElementById('cellModalBg').style.display = 'flex';
}
function saveCell() {
  const c = ensureOvr(editingCompId);
  if (!c.rules) c.rules = {};
  const action = document.getElementById('cellAction').value;
  const daysRaw = document.getElementById('cellDays').value;
  c.rules[editingCatId] = {
    action,
    days: (action === "stop" && daysRaw !== '') ? Number(daysRaw) : (action === "stop" ? null : null),
    comment: document.getElementById('cellComment').value.trim()
  };
  closeModal('cellModalBg'); render();
}

// --- 成分情報編集／追加 ---
function openCompEdit(compId) {
  editingCompId = compId;
  const isNew = !compId;
  const c = isNew ? { component: '', class: '', nameKeys: [], resume: '', source: '', reviewedBy: '' } : getComp(compId);
  document.getElementById('compModalTitle').textContent = isNew ? '成分を追加' : '成分情報の編集';
  document.getElementById('compName').value = c.component || '';
  document.getElementById('compClass').value = c.class || '';
  document.getElementById('compKeys').value = (c.nameKeys || []).join(', ');
  document.getElementById('compResume').value = c.resume || '';
  document.getElementById('compMemo').value = c.source || '';
  document.getElementById('btnResetComp').style.display = (!isNew && ovrMap[compId]) ? 'inline-block' : 'none';
  document.getElementById('compModalBg').style.display = 'flex';
}
function saveCompMeta() {
  const name = document.getElementById('compName').value.trim();
  if (!name) { alert('成分名を入力してくださいカニ🦀'); return; }
  let c;
  if (!editingCompId) {
    const id = 'custom_' + Date.now();
    c = ovrMap[id] = { id, rules: {}, yj7List: [], verified: false };
    (DEF.categories || []).forEach(cat => c.rules[cat.id] = { action: "consult", days: null, comment: "" });
  } else {
    c = ensureOvr(editingCompId);
  }
  c.component = name;
  c.class = document.getElementById('compClass').value.trim() || 'その他';
  c.nameKeys = document.getElementById('compKeys').value.split(/[,、，]/).map(s => s.trim()).filter(Boolean);
  c.resume = document.getElementById('compResume').value.trim();
  c.source = document.getElementById('compMemo').value.trim();
  closeModal('compModalBg'); render();
}
function resetCompToDefault() {
  if (!confirm('この成分の施設カスタムを削除して共通デフォルト値に戻しますか？')) return;
  delete ovrMap[editingCompId];
  closeModal('compModalBg'); render();
}

// --- KV照合：採用薬JSONと成分キーワードを突き合わせ、YJ7を収集 ---
async function getAdopted() {
  if (adoptedCache) return adoptedCache;
  const res = await fetch('/api/adopted-list?h=' + HID);
  adoptedCache = await res.json();
  return adoptedCache;
}
function matchDrugs(adopted, c) {
  const keys = c.nameKeys || [];
  return adopted.filter(d => {
    const target = (d.component || '') + ' ' + (d.name || '');
    return keys.some(k => k && target.includes(k));
  });
}
async function checkMatch(compId) {
  const c = getComp(compId);
  const adopted = await getAdopted();
  const hits = matchDrugs(adopted, c);
  const yj7s = [...new Set(hits.map(d => String(d.yj || '').substring(0, 7)).filter(s => s.length === 7))];
  const box = document.getElementById('match_' + compId);
  box.style.display = 'block';
  if (!hits.length) {
    box.innerHTML = '⚠️ 採用薬に該当なし。キーワード「' + esc((c.nameKeys||[]).join(', ')) + '」を見直すか、他院処方専用の成分ならこのままでOK（照合はマスタ全体でも行われます）';
    return;
  }
  box.innerHTML = '✅ 採用薬 ' + hits.length + '件ヒット（YJ7: ' + yj7s.map(esc).join(', ') + '）<br>' +
    hits.slice(0, 5).map(d => '・' + esc(d.name)).join('<br>') + (hits.length > 5 ? '<br>…他' + (hits.length - 5) + '件' : '') +
    '<br><button class="btn small green" style="margin-top:6px;" onclick="applyYj(\\'' + esc(compId) + '\\', \\'' + yj7s.join('|') + '\\')">このYJ7を反映して照合済にする</button>';
}
function applyYj(compId, yjJoined) {
  const c = ensureOvr(compId);
  const newList = yjJoined ? yjJoined.split('|') : [];
  c.yj7List = [...new Set([...(c.yj7List || []), ...newList])];
  c.yjNames = c.yjNames || {};
  if (adoptedCache) {
    newList.forEach(yj => {
      if (!c.yjNames[yj]) {
        const hit = adoptedCache.find(d => String(d.yj || '').startsWith(yj));
        if (hit) c.yjNames[yj] = hit.component || hit.name || '';
      }
    });
  }
  c.verified = c.yj7List.length > 0;
  render();
  alert('YJ7を反映しましたカニ！🦀 保存を忘れずに！');
}

// --- YJコード照合モーダル ---
function openYjModal(compId) {
  editingCompId = compId;
  renderYjModal();
  document.getElementById('yjModalBg').style.display = 'flex';
}
function nameOfYj(c, yj) {
  if (c.yjNames && c.yjNames[yj]) return c.yjNames[yj];
  if (adoptedCache) {
    const hit = adoptedCache.find(d => String(d.yj || '').startsWith(yj));
    if (hit) return hit.component || hit.name || '—';
  }
  return '—';
}
function renderYjModal() {
  const c = getComp(editingCompId);
  document.getElementById('yjModalTitle').textContent = 'YJコード照合: ' + c.component;
  const list = (c.yj7List || []);
  document.getElementById('yjList').innerHTML = list.length ? list.map(yj =>
    '<div style="display:flex; align-items:center; gap:8px; padding:8px; border:1px solid #e0e6ea; border-radius:8px; margin-bottom:6px;">' +
      '<b style="font-family:monospace; font-size:14px;">' + esc(yj) + '</b>' +
      '<span style="flex:1; font-size:12px; color:#555;">' + esc(nameOfYj(c, yj)) + '</span>' +
      '<button class="btn small red" onclick="removeYj(\\'' + esc(yj) + '\\')">削除</button>' +
    '</div>').join('') : '<div style="font-size:12px; color:#999; margin-bottom:8px;">YJコード未登録</div>';
}
function removeYj(yj) {
  if (!confirm('YJ7「' + yj + '」を削除しますか？')) return;
  const c = ensureOvr(editingCompId);
  c.yj7List = (c.yj7List || []).filter(x => x !== yj);
  if (c.yjNames) delete c.yjNames[yj];
  c.verified = c.yj7List.length > 0;
  renderYjModal(); render();
}
function addYjManual() {
  const code = document.getElementById('yjAddCode').value.trim();
  const name = document.getElementById('yjAddName').value.trim();
  if (!/^[0-9]{7}$/.test(code)) { alert('YJコードは先頭7桁の数字で入力してくださいカニ🦀'); return; }
  const c = ensureOvr(editingCompId);
  c.yj7List = c.yj7List || [];
  if (c.yj7List.includes(code)) { alert('既に登録済みですカニ🦀'); return; }
  c.yj7List.push(code);
  if (name) { c.yjNames = c.yjNames || {}; c.yjNames[code] = name; }
  c.verified = true;
  document.getElementById('yjAddCode').value = '';
  document.getElementById('yjAddName').value = '';
  renderYjModal(); render();
}
async function autoAddFromAdopted() {
  const c = ensureOvr(editingCompId);
  const adopted = await getAdopted();
  const hits = matchDrugs(adopted, c);
  if (!hits.length) {
    alert('採用薬に該当がありませんでしたカニ🦀（他院処方専用の成分ならこのままでOK）');
    renderYjModal(); return;
  }
  c.yj7List = c.yj7List || []; c.yjNames = c.yjNames || {};
  let added = 0;
  hits.forEach(d => {
    const yj7 = String(d.yj || '').substring(0, 7);
    if (yj7.length === 7 && !c.yj7List.includes(yj7)) {
      c.yj7List.push(yj7);
      c.yjNames[yj7] = d.component || d.name || '';
      added++;
    }
  });
  c.verified = c.yj7List.length > 0;
  alert('採用薬 ' + hits.length + '件ヒット、YJ7を ' + added + '件追加しましたカニ🦀');
  renderYjModal(); render();
}
async function checkAllMatches() {
  const comps = mergedComponents();
  let zero = 0;
  for (const c of comps) { await checkMatch(c.id); }
  const adopted = await getAdopted();
  comps.forEach(c => { if (!matchDrugs(adopted, c).length) zero++; });
  document.getElementById('matchSummary').textContent = '照合完了：全' + comps.length + '成分中、採用薬ヒットなし ' + zero + '成分（他院処方薬は判定時にマスタKV全体と照合されます）';
}

// --- 保存 ---
async function saveMaster(scope) {
  const pwd = document.getElementById('adminPwd').value;
  if (!pwd) { alert('管理パスワードを入力してくださいカニ🦀'); return; }
  let data;
  if (scope === 'default') {
    if (!confirm('【共通デフォルト】を上書きします。全施設の既定値に影響しますが、よろしいですか？')) return;
    // デフォルト保存＝現在のマージ結果をそのまま新デフォルトにする
    const comps = mergedComponents().map(c => { const x = { ...c }; delete x._ovr; delete x._facilityOnly; return x; });
    data = { ...DEF, components: comps };
  } else {
    data = { version: 1, components: Object.values(ovrMap) };
  }
  const res = await fetch('/api/admin/kyuyaku?h=' + HID, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pwd, scope, data })
  });
  const j = await res.json();
  if (j.success) { alert('保存しましたカニ！🦀'); if (scope === 'default') loadMaster(); }
  else if (j.error === 'auth') alert('パスワードが違いますカニ🦀💦');
  else alert('保存に失敗しましたカニ🦀💦 ' + (j.error || ''));
}

function closeModal(id) { document.getElementById(id).style.display = 'none'; }
document.querySelectorAll('.modal-bg').forEach(bg => bg.addEventListener('click', e => { if (e.target === bg) bg.style.display = 'none'; }));

loadMaster();
</script></body></html>`;
}
// === 🦀休薬チェッカー: ページ生成関数 (ここまで) ===

// === 🦀休薬チェッカー: 判定画面 生成関数 (ここから) ===
function kyuyakuCheckerPage(hId) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>休薬チェッカー 🦀 メディカニ</title>
<link rel="icon" type="image/png" sizes="512x512" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; background: #f4f7f9; color: #333; padding-bottom: 40px; }
  .header { background: linear-gradient(135deg, #0d3b8f, #0a2e70); color: #fff; padding: 14px 16px; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
  .header h1 { font-size: 17px; }
  .header .sub { font-size: 11px; opacity: .85; margin-top: 2px; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 12px; }
  .banner { background: #fff3cd; border: 1px solid #ffe69c; color: #7a5c00; border-radius: 10px; padding: 10px 12px; font-size: 12px; line-height: 1.6; margin-bottom: 12px; }
  .banner.red { background: #fde8e8; border-color: #f5b5b5; color: #9b1c1c; display: none; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.08); padding: 14px; margin-bottom: 12px; }
  .card h2 { font-size: 14px; color: #0d3b8f; margin-bottom: 10px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
  .tab { border: 1px solid #cfd8e3; background: #f7fafc; color: #888; border-radius: 8px; padding: 7px 10px; font-size: 12px; font-weight: bold; }
  .tab.active { background: #0d3b8f; color: #fff; border-color: #0d3b8f; }
  .tab .soon { font-size: 9px; background: #eee; color: #999; border-radius: 6px; padding: 1px 5px; margin-left: 3px; }
  .srow { display: flex; gap: 6px; }
  .srow input { flex: 1; border: 1px solid #ccc; border-radius: 10px; padding: 11px; font-size: 15px; }
  .btn { border: none; border-radius: 10px; padding: 11px 16px; font-size: 14px; font-weight: bold; cursor: pointer; }
  .btn.navy { background: #0d3b8f; color: #fff; }
  .btn.red { background: #e85a4f; color: #fff; width: 100%; padding: 14px; font-size: 16px; }
  .btn.gray { background: #eceff1; color: #555; }
  .sr { border: 1px solid #e0e6ea; border-radius: 10px; padding: 9px 10px; margin-top: 6px; cursor: pointer; background: #fafcfd; font-size: 13px; }
  .sr:active { background: #eef4f8; }
  .sr .sub { font-size: 11px; color: #888; }
  .hint { font-size: 12px; color: #999; padding: 8px 2px; }
  .drug { display: flex; align-items: center; gap: 8px; border: 1px solid #dbe4ee; background: #f6f9ff; border-radius: 10px; padding: 9px 10px; margin-top: 6px; }
  .drug .nm { flex: 1; font-size: 13px; font-weight: bold; }
  .drug .nm .sub { font-size: 11px; color: #778; font-weight: normal; }
  .drug button { border: none; background: #ffd6d1; color: #b23a2f; border-radius: 8px; padding: 5px 9px; font-size: 12px; font-weight: bold; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 11px; color: #777; margin-bottom: 4px; font-weight: bold; }
  .field select, .field input { width: 100%; border: 1px solid #ccc; border-radius: 10px; padding: 11px; font-size: 15px; background: #fff; }
  .catdesc { font-size: 11px; color: #888; margin-top: 4px; }
  .summary { border-radius: 12px; padding: 14px; font-size: 15px; font-weight: bold; margin-bottom: 12px; }
  .summary.s-red { background: #fde8e8; color: #9b1c1c; border: 1px solid #f5b5b5; }
  .summary.s-amber { background: #fff3cd; color: #7a5c00; border: 1px solid #ffe69c; }
  .summary.s-green { background: #d4edda; color: #155724; border: 1px solid #b8dfc2; }
  .rcard { background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.08); padding: 13px; margin-bottom: 10px; border-left: 6px solid #ccc; }
  .rcard.a-stop { border-left-color: #c0392b; }
  .rcard.a-consult { border-left-color: #b96b00; }
  .rcard.a-continue { border-left-color: #1e7e34; }
  .rcard .dname { font-weight: bold; font-size: 15px; }
  .rcard .comp { font-size: 11px; color: #0056b3; background: #e3f2fd; border: 1px solid #bbdefb; border-radius: 4px; padding: 1px 6px; display: inline-block; margin: 4px 0; }
  .abadge { display: inline-block; font-size: 13px; font-weight: bold; border-radius: 8px; padding: 3px 10px; margin: 4px 0; }
  .abadge.a-stop { background: #c0392b; color: #fff; }
  .abadge.a-consult { background: #b96b00; color: #fff; }
  .abadge.a-continue { background: #1e7e34; color: #fff; }
  .stopdate { font-size: 16px; font-weight: bold; color: #c0392b; margin: 4px 0; }
  .rl { font-size: 12px; color: #555; line-height: 1.7; }
  .srcbadge { font-size: 10px; border-radius: 8px; padding: 2px 7px; }
  .srcbadge.fac { background: #e85a4f; color: #fff; }
  .srcbadge.def { background: #eee; color: #666; }
  .notes { background: #fff; border: 1px dashed #cbb; border-radius: 12px; padding: 12px; font-size: 11px; color: #86482c; line-height: 1.8; margin-bottom: 12px; }
  .misslist { font-size: 12px; color: #667; line-height: 1.8; }
  @media print {
    .no-print { display: none !important; }
    body { background: #fff; padding: 0; }
    .rcard, .card, .summary, .notes { box-shadow: none; border: 1px solid #ccc; page-break-inside: avoid; }
    .header { background: #fff; color: #000; box-shadow: none; border-bottom: 2px solid #000; }
  }
</style></head><body>

<div class="header">
  <h1>💊 メディカニ 休薬チェッカー</h1>
  <div class="sub">施設ID: ${hId} ／ 術前・検査前 持参薬スクリーニング</div>
</div>

<div class="wrap">

  <!-- STEP1: 薬の入力 -->
  <div class="card no-print">
    <h2>① お薬の入力</h2>
    <div class="tabs">
      <div class="tab active">🔍 検索して追加</div>
      <div class="tab">📷 QR読み取り<span class="soon">準備中</span></div>
      <div class="tab">🖼 OCR読み取り<span class="soon">準備中</span></div>
    </div>
    <div class="srow">
      <input id="searchBox" placeholder="薬品名で検索（2文字以上）" onkeydown="if(event.key==='Enter'){doSearch();}">
      <button class="btn navy" onclick="doSearch()">検索</button>
    </div>
    <div id="searchResults"></div>
    <div id="drugList" style="margin-top:10px;"></div>
  </div>

  <!-- STEP2: 処置の選択 -->
  <div class="card no-print">
    <h2>② 処置と予定日</h2>
    <div class="field">
      <label>処置の分類</label>
      <select id="catSelect" onchange="updateCatDesc()"></select>
      <div class="catdesc" id="catDesc"></div>
    </div>
    <div class="field">
      <label>手術・検査の予定日（入れると休薬開始日を日付で表示します）</label>
      <input type="date" id="opDate">
    </div>
    <button class="btn red" onclick="judge()">🦀 休薬判定する</button>
  </div>

  <!-- 結果 -->
  <div id="resultArea" style="display:none;">
    <div class="card" style="border-left:6px solid #0d3b8f;">
      <h2>判定結果</h2>
      <div class="rl" id="resultMeta"></div>
    </div>
    <div id="resultSummary"></div>
    <div id="resultCards"></div>
    <div class="card" id="missCard" style="display:none;">
      <h2>休薬マスタに該当のなかったお薬</h2>
      <div class="misslist" id="missList"></div>
      <div class="hint">※「該当なし」はこのマスタに登録がないという意味で、休薬不要を保証するものではありません。</div>
    </div>
    <div class="notes">
      ⚠️ 本結果は<b>参考情報</b>です。休薬の最終判断は必ず<b>医師・薬剤師（処方元）</b>にご確認ください。<br>
      ⚠️ お薬手帳に記載のないお薬・市販薬・サプリメント（EPA、イチョウ葉など）は検出できません。<br>
      🔒 入力された内容はこの端末内で判定され、サーバーには保存されません。
    </div>
    <div class="no-print" style="display:flex; gap:8px;">
      <button class="btn navy" style="flex:1;" onclick="window.print()">🖨 印刷 / PDF保存</button>
      <button class="btn gray" onclick="resetAll()">はじめから</button>
    </div>
  </div>
</div>

<script>
const HID = "${hId}";
let DEF = null, OVR = null, comps = [];
let searchResults = [], drugs = [];

function esc(s) { return String(s == null ? "" : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function init() {
  try {
    const res = await fetch('/api/kyuyaku/master?h=' + HID);
    const data = await res.json();
    DEF = data.def || { categories: [], components: [] };
    OVR = data.ovr || { components: [] };
    const ovrMap = {};
    (OVR.components || []).forEach(function(c){ ovrMap[c.id] = c; });
    const defIds = new Set((DEF.components || []).map(function(c){ return c.id; }));
    comps = (DEF.components || []).map(function(c){
      return ovrMap[c.id] ? Object.assign({}, ovrMap[c.id], { _ovr: true }) : Object.assign({}, c, { _ovr: false });
    });
    Object.values(ovrMap).forEach(function(c){ if (!defIds.has(c.id)) comps.push(Object.assign({}, c, { _ovr: true })); });
    const sel = document.getElementById('catSelect');
    sel.innerHTML = (DEF.categories || []).map(function(c){
      return '<option value="' + esc(c.id) + '">' + esc(c.label) + '</option>';
    }).join('');
    updateCatDesc();
  } catch (e) {
    alert('休薬マスタの読み込みに失敗しましたカニ🦀💦 通信環境を確認してください');
  }
}
function updateCatDesc() {
  const id = document.getElementById('catSelect').value;
  const c = (DEF && DEF.categories || []).find(function(x){ return x.id === id; });
  document.getElementById('catDesc').textContent = c ? (c.desc || '') : '';
}

// --- 検索して追加 ---
async function doSearch() {
  const q = document.getElementById('searchBox').value.trim();
  if (q.length < 2) { alert('2文字以上で入力してくださいカニ🦀'); return; }
  const box = document.getElementById('searchResults');
  box.innerHTML = '<div class="hint">検索中…🦀</div>';
  try {
    const res = await fetch('/api/search?c=all&q=' + encodeURIComponent(q) + '&h=' + HID);
    const data = await res.json();
    searchResults = Array.isArray(data) ? data.slice(0, 20) : [];
    if (!searchResults.length) { box.innerHTML = '<div class="hint">見つかりませんでしたカニ🦀💦 名前を変えて試してみてください</div>'; return; }
    box.innerHTML = searchResults.map(function(d, i) {
      return '<div class="sr" onclick="addDrug(' + i + ')"><b>' + esc(d.name || '') + '</b> <span class="sub">' + esc(d.spec || '') + '</span><div class="sub">成分: ' + esc(d.component || '—') + '</div></div>';
    }).join('');
  } catch (e) { box.innerHTML = '<div class="hint">検索エラーですカニ🦀💦</div>'; }
}
function addDrug(i) {
  const d = searchResults[i];
  if (!d) return;
  if (drugs.some(function(x){ return x.key === d.key; })) { alert('すでに追加済みですカニ🦀'); return; }
  drugs.push(d);
  document.getElementById('searchBox').value = '';
  document.getElementById('searchResults').innerHTML = '';
  renderDrugs();
}
function removeDrug(i) { drugs.splice(i, 1); renderDrugs(); }
function renderDrugs() {
  const el = document.getElementById('drugList');
  el.innerHTML = drugs.length
    ? '<div class="hint">追加したお薬（' + drugs.length + '件）— タップで削除できます</div>' + drugs.map(function(d, i) {
        return '<div class="drug"><div class="nm">' + esc(d.name || '') + ' <span class="sub">' + esc(d.spec || '') + '</span><br><span class="sub">' + esc(d.component || '') + '</span></div><button onclick="removeDrug(' + i + ')">削除</button></div>';
      }).join('')
    : '<div class="hint">まだお薬が追加されていません</div>';
}

// --- 判定（すべてこの端末内で実行。サーバーには送信しません） ---
function fmtDate(dt) {
  const w = ['日','月','火','水','木','金','土'];
  return (dt.getMonth() + 1) + '月' + dt.getDate() + '日(' + w[dt.getDay()] + ')';
}
function judge() {
  if (!comps.length) { alert('休薬マスタが読み込めていませんカニ🦀 再読み込みしてください'); return; }
  if (!drugs.length) { alert('お薬を1件以上追加してくださいカニ🦀'); return; }
  const catId = document.getElementById('catSelect').value;
  const cat = (DEF.categories || []).find(function(x){ return x.id === catId; });
  const opStr = document.getElementById('opDate').value;
  const opDate = opStr ? new Date(opStr + 'T00:00:00') : null;

  const hits = [], misses = [];
  drugs.forEach(function(d) {
    const yj7 = String(d.yj || '').substring(0, 7);
    let c = comps.find(function(x){ return (x.yj7List || []).includes(yj7); });
    if (!c) {
      const t = (d.component || '') + ' ' + (d.name || '');
      c = comps.find(function(x){ return (x.nameKeys || []).some(function(k){ return k && t.includes(k); }); });
    }
    if (c) hits.push({ d: d, c: c }); else misses.push(d);
  });

  // メタ情報
  const now = new Date();
  document.getElementById('resultMeta').innerHTML =
    '処置分類: <b>' + esc(cat ? cat.label : catId) + '</b><br>' +
    '予定日: <b>' + (opDate ? esc(opStr) + '（' + fmtDate(opDate) + '）' : '未入力') + '</b><br>' +
    '判定日時: ' + now.toLocaleString('ja-JP') + ' ／ 入力薬 ' + drugs.length + '件';

  // サマリー
  let nStop = 0, nConsult = 0;
  hits.forEach(function(h) {
    const r = (h.c.rules || {})[catId] || { action: 'consult' };
    if (r.action === 'stop') nStop++;
    else if (r.action === 'consult') nConsult++;
  });
  const sm = document.getElementById('resultSummary');
  if (nStop) sm.innerHTML = '<div class="summary s-red">🔴 休薬が必要なお薬が ' + nStop + '件あります' + (nConsult ? '（照会 ' + nConsult + '件）' : '') + '</div>';
  else if (nConsult) sm.innerHTML = '<div class="summary s-amber">🟡 処方元への照会が必要なお薬が ' + nConsult + '件あります</div>';
  else sm.innerHTML = '<div class="summary s-green">🟢 休薬・照会に該当するお薬はありませんでした</div>';

  // 各カード
  document.getElementById('resultCards').innerHTML = hits.map(function(h) {
    const r = (h.c.rules || {})[catId] || { action: 'consult', days: null, comment: '分類未設定のため処方元へ照会してください' };
    const actLabel = { continue: '継続可', stop: '休薬', consult: '処方元に照会' }[r.action] || r.action;
    let dateLine = '';
    if (r.action === 'stop') {
      if (r.days == null) dateLine = '<div class="stopdate">休薬日数未設定（処方元に確認）</div>';
      else if (opDate) {
        const st = new Date(opDate); st.setDate(st.getDate() - r.days);
        dateLine = '<div class="stopdate">' + fmtDate(st) + (r.days === 0 ? '（当日）' : '') + ' から休薬</div>';
      } else {
        dateLine = '<div class="stopdate">' + (r.days === 0 ? '当日から休薬' : r.days + '日前から休薬') + '</div>';
      }
    }
    return '<div class="rcard a-' + esc(r.action) + '">' +
      '<div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">' +
        '<div class="dname">' + esc(h.d.name || '') + '</div>' +
        '<span class="srcbadge ' + (h.c._ovr ? 'fac' : 'def') + '">' + (h.c._ovr ? '施設プロトコル' : '共通デフォルト') + '</span>' +
      '</div>' +
      '<span class="comp">' + esc(h.c.component || '') + '（' + esc(h.c.class || '') + '）</span><br>' +
      '<span class="abadge a-' + esc(r.action) + '">' + esc(actLabel) + '</span>' +
      dateLine +
      (r.comment ? '<div class="rl">💬 ' + esc(r.comment) + '</div>' : '') +
      (h.c.resume ? '<div class="rl">🔄 再開の目安: ' + esc(h.c.resume) + '</div>' : '') +
    '</div>';
  }).join('');

  // 非該当
  const mc = document.getElementById('missCard');
  if (misses.length) {
    mc.style.display = 'block';
    document.getElementById('missList').innerHTML = misses.map(function(d) {
      return '・' + esc(d.name || '') + '（' + esc(d.component || '—') + '）';
    }).join('<br>');
  } else { mc.style.display = 'none'; }

  document.getElementById('resultArea').style.display = 'block';
  document.getElementById('resultArea').scrollIntoView({ behavior: 'smooth' });
}
function resetAll() {
  drugs = []; searchResults = [];
  renderDrugs();
  document.getElementById('searchResults').innerHTML = '';
  document.getElementById('resultArea').style.display = 'none';
  document.getElementById('opDate').value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

renderDrugs();
init();
</script></body></html>`;
}
// === 🦀休薬チェッカー: 判定画面 生成関数 (ここまで) ===

// === 🦀メディカニ鑑別（持参薬サポート）: ページ生成関数 (ここから) ===
function jisanPage(hId, hospitalName) {
  const facilityBadge = hospitalName
    ? '<div style="display:inline-block; background:#fff; color:#d63384; font-size:12px; font-weight:bold; padding:4px 14px; border-radius:20px; border:1.5px solid #ffb6c1; margin-top:8px;">🏥 ' + hospitalName + '</div>'
    : '';
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦀</text></svg>">
<title>メディカニ鑑別 | 刻印から探す</title>
<style>
  :root { --pink:#d63384; --bg:#fffaf5; }
  * { box-sizing:border-box; }
  body { font-family:'Hiragino Kaku Gothic ProN','Meiryo',sans-serif; background:var(--bg); margin:0; padding:0; color:#333; }
  .header { background:#ffe4e1; text-align:center; padding:22px 15px 18px; border-bottom:2px solid #ffd1dc; }
  .header h1 { margin:0; font-size:20px; color:var(--pink); }
  .header .sub { font-size:12px; color:#a58; margin-top:4px; }
  .container { max-width:600px; margin:0 auto; padding:15px; }
  .search-box { background:#fff; border:1.5px solid #ffd1dc; border-radius:15px; padding:15px; margin-top:10px; box-shadow:0 2px 8px rgba(214,51,132,0.06); }
  .search-row { display:flex; gap:8px; }
  #kokuin { flex:1; min-width:0; padding:13px 14px; font-size:16px; border:1.5px solid #ddd; border-radius:12px; outline:none; }
  #kokuin:focus { border-color:var(--pink); }
  #btnSearch { padding:13px 20px; background:var(--pink); color:#fff; border:none; border-radius:12px; font-weight:bold; font-size:14px; cursor:pointer; white-space:nowrap; }
  #btnSearch:active { transform:scale(0.97); }
  .hint { font-size:11px; color:#999; margin-top:8px; line-height:1.6; }
  .notice { background:#fff8e1; border:1px solid #ffe082; border-radius:10px; padding:10px 12px; font-size:11px; color:#8a6d3b; line-height:1.6; margin-top:12px; }
  #status { text-align:center; font-size:13px; color:#888; margin:18px 0 8px; }
  /* ▼ メイン検索と同じカード・タグの見た目 */
  .card { background: #fff; border-radius: 15px; padding: 16px; margin-bottom: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.03); border-left: 6px solid #ccc; transition: transform 0.1s; }
  .card[data-key] { cursor: pointer; }
  .card[data-key]:active { transform: scale(0.98); }
  .card.adopted { border-left-color: #28a745; }
  .tag { font-size: 11px; padding: 4px 10px; border-radius: 20px; background: #eee; font-weight: bold; white-space: nowrap; display: inline-block; }
  .tag.green { background: #d1ffd1; color: #155724; }
  .tag.red { background: #ffebeb; color: #dc3545; border: 1px solid #ffcdd2; }
  .tag.blue { background: #e3f2fd; color: #0d47a1; border: 1px solid #bbdefb; }
  /* ▼ 刻印行と画像検索ボタン */
  .code-row { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:10px; }
  .code-chip { background:#fdf2f7; color:var(--pink); border:1px dashed #f3a9c9; border-radius:8px; padding:3px 10px; font-size:13px; font-weight:bold; letter-spacing:0.5px; word-break:break-all; }
  .btn-img { flex-shrink:0; background:#e8f5e9; color:#1b5e20; border:1px solid #a5d6a7; border-radius:10px; padding:6px 12px; font-size:12px; font-weight:bold; cursor:pointer; white-space:nowrap; }
  .btn-img:active { transform:scale(0.96); }
  .tap-hint { font-size:11px; color:#bbb; margin-top:8px; }
  .pmda-link { display:inline-block; margin-top:8px; font-size:12px; color:#0056b3; text-decoration:none; border-bottom:1px dotted #0056b3; }
  .no-results { text-align: center; padding: 40px 20px; color: #777; font-size: 15px; line-height: 1.6; }
  .footer { text-align:center; font-size:10px; color:#c9a9b8; padding:25px 15px 30px; line-height:1.8; }
  /* ▼ 詳細モーダル（メインのお薬詳細と同じ雰囲気） */
  #modalOverlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); backdrop-filter: blur(3px); display: none; z-index: 1000; justify-content: center; align-items: center; }
  .modal { background: #fff; width: 92%; max-width: 400px; border-radius: 24px; padding: 25px; position: relative; overflow-y: auto; max-height: 85vh; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
  .modal-close { position: absolute; top: 12px; right: 16px; font-size: 22px; color: #bbb; cursor: pointer; background: none; border: none; line-height: 1; }
  .alt-item { display: block; padding: 10px 12px; margin-bottom: 8px; border-radius: 10px; font-size: 13px; background: #f8f9fa; text-decoration: none; color: #444; border: 1px solid #eee; cursor: pointer; transition: background 0.2s; }
  .alt-item:active { background: #e9ecef; }
  .alt-item.adopted { background: #f2fff2; border-color: #d1ffd1; }
  .alt-item.adopted:active { background: #e2ffe2; }
</style></head>
<body>
  <div class="header">
    <h1>🔍 メディカニ鑑別</h1>
    <div class="sub">錠剤の刻印から候補を絞る、持参薬サポートツールですカニ🦀</div>
    ${facilityBadge}
  </div>
  <div class="container">
    <div class="search-box">
      <div class="search-row">
        <input type="text" id="kokuin" placeholder="刻印を入力（例：HP211、TA 111）" autocomplete="off">
        <button id="btnSearch" onclick="doSearch()">🔍 検索</button>
      </div>
      <div class="hint">💡 英数字2文字以上で検索できます。大文字小文字・全角半角・スペースの違いは気にしなくてOKカニ🦀 一部だけでも検索できます（例:「211」）。</div>
    </div>
    <div class="notice">
      ⚠️ 本ツールはPMDA添付文書の識別コード情報をもとに候補を絞り込む<b>補助ツール</b>です。同じ刻印が複数の製品に該当する場合や、刻印情報が登録されていない製剤もあります。<b>最終的な同定は必ず現物・添付文書でご確認ください。</b>
    </div>
    <div id="status"></div>
    <div id="results"></div>
  </div>
  <div class="footer">
    🦀 メディカニ鑑別（β）<br>© 2026 🐔トリの巣ワークス メディカニ運営事務局
  </div>

  <div id="modalOverlay"><div class="modal" onclick="event.stopPropagation()">
    <button class="modal-close" onclick="closeModal()">×</button>
    <div id="modalBody"></div>
  </div></div>

  <script>
    const HID = "${hId}";
    const inp = document.getElementById('kokuin');
    inp.addEventListener('keydown', function(e){ if (e.key === 'Enter') doSearch(); });
    // 🖼️画像検索は委譲、カードタップは詳細モーダルを開く（ボタン優先）
    document.getElementById('results').addEventListener('click', function(e){
      const b = e.target.closest('.btn-img');
      if (b) { openImageSearch(b.getAttribute('data-name') || ''); return; }
      const c = e.target.closest('.card[data-key]');
      if (c) openDetail(c.getAttribute('data-key'));
    });
    document.getElementById('modalOverlay').addEventListener('click', closeModal);

    function closeModal() { document.getElementById('modalOverlay').style.display = 'none'; }

    // カテゴリ絵文字（キーの[内][外][注]から判定）
    function formEmoji(key) {
      if (!key) return '💊';
      if (key.indexOf('[注]') !== -1) return '💉';
      if (key.indexOf('[外]') !== -1) return '🧴';
      return '💊';
    }

    // 🖼️ 画像検索: Googleイメージ検索を小窓ポップアップで開く（画面遷移しない）
    // ※Googleはiframe埋め込みを禁止しているため、モーダル内表示は技術的に不可。
    function openImageSearch(name) {
      const url = 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(name + ' 錠剤');
      window.open(url, 'kanbetsu_img', 'width=900,height=700,scrollbars=yes');
    }

    async function doSearch() {
      const q = inp.value.trim();
      const st = document.getElementById('status');
      const res = document.getElementById('results');
      res.innerHTML = '';
      if (q.replace(/\s/g,'').length < 2) {
        st.textContent = '2文字以上入力してくださいカニ🦀';
        return;
      }
      st.textContent = '検索中...🦀';
      try {
        const r = await fetch('/api/jisan-search?h=' + encodeURIComponent(HID) + '&q=' + encodeURIComponent(q));
        const data = await r.json();
        if (data.error === 'index_not_found') { st.textContent = '刻印データが未登録です。管理者にお問い合わせください。'; return; }
        if (data.error) { st.textContent = 'エラーが発生しました（' + data.error + '）'; return; }
        if (!data.results || data.results.length === 0) {
          st.textContent = '';
          res.innerHTML = '<div class="no-results">📭 「' + escHtml(q) + '」に一致する刻印は見つかりませんでしたカニ🦀💦<br><span style="font-size:12px;color:#aaa;">刻印の一部だけで再検索してみてね！</span></div>';
          return;
        }
        st.textContent = data.count + '件の候補が見つかりました' + (data.count >= 50 ? '（上位50件を表示。文字を足して絞り込めます）' : '') + 'カニ🦀';
        let html = '';
        for (const i of data.results) {
          const nameForImg = String(i.name || '');
          html += '<div class="card ' + (i.isAdopted ? 'adopted' : '') + '"' + (i.key ? ' data-key="' + escHtml(i.key) + '"' : '') + '>'
            + '<div style="display:flex; justify-content:space-between; align-items:flex-start; font-weight:bold; font-size:15px; gap:8px;">'
              + '<div style="flex:1; line-height:1.4;">' + formEmoji(i.key) + ' ' + escHtml(i.name) + '</div>'
              + '<div style="flex-shrink:0; display:flex; gap:4px; margin-top:2px;">'
                + (i.isBrand ? '<span class="tag blue">先</span>' : '')
                + (i.price && i.price !== '-' ? '<span class="tag" style="background:#fff3cd;color:#333;border:1px solid #ffe69c;"><span style="color:#e65100;">￥</span>' + escHtml(i.price) + '</span>' : '')
                + (i.yj && i.yj.indexOf('8') === 0 ? '<span class="tag red">麻</span>' : '')
                + (i.isAdopted ? '<span class="tag green">🏥 採用</span>' : '<span class="tag">未採用</span>')
              + '</div>'
            + '</div>'
            + (i.spec ? '<div style="font-size:12px; color:#888; margin-top:8px;">📦 ' + escHtml(i.spec) + ' ' + (i.type ? '/ ' + escHtml(i.type) : '') + '</div>' : '')
            + '<div class="code-row">'
              + '<span class="code-chip">刻印: ' + escHtml(i.code) + '</span>'
              + '<button class="btn-img" data-name="' + escHtml(nameForImg) + '">🖼️ 画像検索</button>'
            + '</div>'
            + (i.key
                ? '<div class="tap-hint">👆 タップでお薬詳細・切替候補を表示カニ🦀</div>'
                : '<a class="pmda-link" href="https://www.pmda.go.jp/PmdaSearch/rdSearch/02/' + escHtml(i.yj) + '?user=1" target="_blank" onclick="event.stopPropagation()">📄 添付文書等のお薬詳細を見る（PMDA公式）</a>')
            + '</div>';
        }
        res.innerHTML = html;
      } catch (e) {
        st.textContent = '通信エラーが発生したカニ🦀💦 少し待ってからもう一度お試しください。';
      }
    }

    // ===== お薬詳細モーダル（メインのメディカニと同じ内容構成） =====
    async function openDetail(key) {
      const ov = document.getElementById('modalOverlay');
      const body = document.getElementById('modalBody');
      body.innerHTML = '<div style="text-align:center; padding:30px; color:#888;">読み込み中...🦀</div>';
      ov.style.display = 'flex';
      try {
        const r = await fetch('/api/detail?key=' + encodeURIComponent(key) + '&h=' + encodeURIComponent(HID));
        const d = await r.json();
        if (!d || d.error) { body.innerHTML = '<div style="text-align:center; padding:30px; color:#888;">詳細を取得できませんでしたカニ🦀💦</div>'; return; }

        let html = '';
        // ヘッダー（薬品名・タグ）
        html += '<div style="font-weight:bold; font-size:17px; color:#0056b3; line-height:1.4; margin-bottom:8px; padding-right:20px;">' + formEmoji(d.label || d.key) + ' ' + escHtml(d.fullName || '') + '</div>';
        html += '<div style="display:flex; gap:5px; flex-wrap:wrap; margin-bottom:12px;">'
          + (d.isBrand ? '<span class="tag blue">先</span>' : '')
          + (d.price && d.price !== '-' ? '<span class="tag" style="background:#fff3cd;color:#333;border:1px solid #ffe69c;"><span style="color:#e65100;">￥</span>' + escHtml(d.price) + '</span>' : '')
          + (d.yj && d.yj.indexOf('8') === 0 ? '<span class="tag red">麻</span>' : '')
          + (d.isAdopted ? '<span class="tag green">🏥 採用</span>' : '<span class="tag">🏠 未採用のお薬ですカニ🦀</span>')
          + '</div>';

        // 施設メモ（あれば）
        if (d.comment) {
          html += '<div style="background:#fff5f7; border-left:5px solid #ff8da1; border-radius:8px; padding:10px 12px; font-size:13px; margin-bottom:12px; white-space:pre-wrap;">📝 ' + escHtml(d.comment) + '</div>';
        }

        // PMDA要約（効能・用法・禁忌）… メインと同じレイアウト
        if (d.pmdaEfficacy || d.pmdaUsage || d.pmdaContra) {
          html += '<div style="background:#f8f9fa; border:1px solid #dee2e6; border-radius:12px; padding:15px; margin-bottom:12px; font-size:13px; line-height:1.6; color:#333;">';
          if (d.pmdaEfficacy) {
            html += '<div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:4px;">'
              + '<div style="color:#0056b3; font-weight:bold;">💊 効能・効果</div>'
              + (d.pmdaLastUpdated ? '<div style="font-size:11px; color:#888;">🗒️最終更新日：' + escHtml(d.pmdaLastUpdated) + '</div>' : '')
              + '</div><div style="margin-bottom:12px;">' + d.pmdaEfficacy + '</div>';
          }
          if (d.pmdaUsage) html += '<div style="color:#28a745; font-weight:bold; margin-bottom:4px;">🕒 用法・用量</div><div style="margin-bottom:12px;">' + d.pmdaUsage + '</div>';
          if (d.pmdaContra) html += '<div style="color:#d63384; font-weight:bold; margin-bottom:4px;">🚫 禁忌</div><div>' + d.pmdaContra + '</div>';
          html += '</div>';
          html += '<div style="background:#fff8e1; border:1px solid #ffe082; border-radius:8px; padding:10px 12px; margin-bottom:12px; font-size:11px; line-height:1.5; color:#8a6d3b;">⚠️ 本要約はAIが生成した参考情報であり、正確性を保証するものではありません。実際の使用にあたっては、必ず最新の添付文書をご確認ください。</div>';
        }

        // ボタン: 画像検索 & PMDA公式
        html += '<button class="btn-img" data-name="' + escHtml(d.fullName || '') + '" style="width:100%; padding:12px; margin-bottom:8px; font-size:13px;">🖼️ この薬の画像を検索する</button>';
        if (d.yj && d.yj !== 'NONE') {
          html += '<a href="https://www.pmda.go.jp/PmdaSearch/rdSearch/02/' + escHtml(d.yj) + '?user=1" target="_blank" style="display:flex; align-items:center; justify-content:center; gap:6px; width:100%; padding:14px; background:#fff0f5; border:2px solid #d63384; color:#d63384; border-radius:12px; text-decoration:none; font-weight:bold; font-size:14px; box-sizing:border-box; margin-bottom:15px; box-shadow:0 2px 4px rgba(214,51,132,0.1);">📄 添付文書等のお薬詳細を見る 🔍</a>';
        }

        // 切替候補（採用薬が一番上＝APIのソート済み）
        html += '<hr style="border:none; border-top:1px dashed #ccc; margin:15px 0;">';
        html += '<p style="font-weight:bold; font-size:14px; margin-bottom:12px; color:#555;">🔄 同成分・切替候補カニ🦀</p>';
        if (d.alts && d.alts.length) {
          for (const a of d.alts) {
            html += '<div class="alt-item ' + (a.isAdopted ? 'adopted' : '') + '" data-altkey="' + escHtml(a.key) + '">'
              + '<div style="display:flex; flex-direction:column; gap:6px;">'
                + '<div style="display:flex; justify-content:space-between; align-items:flex-start;">'
                  + '<span style="font-weight:bold; line-height:1.3;">' + formEmoji(a.key) + ' ' + escHtml(a.name) + ' <span style="font-weight:normal;color:#666;font-size:11px;">' + escHtml(a.spec || '') + '</span></span>'
                  + '<span style="font-weight:bold;color:' + (a.isAdopted ? '#28a745' : '#aaa') + '; white-space:nowrap; margin-left:8px;">' + (a.isAdopted ? '🏥 採用' : '') + ' ❯</span>'
                + '</div>'
                + '<div style="display:flex; gap:4px; align-items:center;">'
                  + (a.isBrand ? '<span class="tag blue" style="font-size:10px; padding:2px 6px;">先</span>' : '')
                  + (a.yj && a.yj.indexOf('8') === 0 ? '<span class="tag red" style="font-size:10px; padding:2px 6px;">麻</span>' : '')
                  + (a.price && a.price !== '-' ? '<span class="tag" style="background:#fff3cd;color:#333;border:1px solid #ffe69c;font-size:10px; padding:2px 6px;"><span style="color:#e65100;">￥</span>' + escHtml(a.price) + '</span>' : '')
                + '</div>'
              + '</div></div>';
          }
        } else {
          html += '<div style="font-size:12px; color:#999; text-align:center; padding:10px;">切替候補が見つかりませんでしたカニ🦀</div>';
        }

        body.innerHTML = html;
      } catch (e) {
        body.innerHTML = '<div style="text-align:center; padding:30px; color:#888;">通信エラーが発生したカニ🦀💦</div>';
      }
    }

    // モーダル内のクリック委譲（切替候補タップ→その薬の詳細へ、画像検索ボタン）
    document.getElementById('modalBody').addEventListener('click', function(e){
      const b = e.target.closest('.btn-img');
      if (b) { openImageSearch(b.getAttribute('data-name') || ''); return; }
      const a = e.target.closest('.alt-item[data-altkey]');
      if (a) openDetail(a.getAttribute('data-altkey'));
    });

    function escHtml(s) {
      return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
  </script>
</body></html>`;
}
// === 🦀メディカニ鑑別: ページ生成関数 (ここまで) ===


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const pathParts = url.pathname.split('/').filter(p => p);
    
    // パスの1番目を施設IDとして取得（apiパスは除外）
    const hospitalId = (pathParts[0] && !pathParts[0].startsWith('api')) ? pathParts[0] : "";

    // === 新規追加: 門番機能（適当なIDならノーマルへリダイレクト） ===
    if (hospitalId && env.MEDI_KV) {
      let isValidFacility = false;
      if (hospitalId === "HPTEST1") {
        isValidFacility = true;
      } else {
        try {
          const list = await env.MEDI_KV.list({ prefix: `${hospitalId}_`, limit: 1 });
          if (list.keys.length > 0) isValidFacility = true;
        } catch(e) {}
      }
      if (!isValidFacility) {
        return Response.redirect(`${url.origin}/`, 302);
      }
    }
    // =========================================================

    // === 🦀休薬チェッカー: 管理画面ルート (ここから) ===
    // === 🦀新規追加: 休薬マスタ管理画面 /{hId}/kyu-admin（オプション施設のみ） ===
    if (hospitalId && pathParts[1] === "kyu-admin") {
      const isSuper = hospitalId === (env.SUPER_ADMIN_HID || "HPTEST1");
      // プランゲート: {hId}_plan の末尾が "_KY" の施設だけ利用可（スーパー管理は常に可）
      // 例: PLUS_0_KY, PLUS_H1M_KY ○ ／ PLUS_K1Y（その他・年払い）は × で衝突しない
      if (!isSuper) {
        const plan = await env.MEDI_KV.get(`${hospitalId}_plan`) || "";
        if (!plan.endsWith("_KY")) {
          return new Response("休薬チェッカーオプションが有効ではありませんカニ🦀", {
            status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }
      }
      return new Response(kyuyakuAdminPage(hospitalId, isSuper), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    // === 🦀休薬チェッカー: 管理画面ルート (ここまで) ===

    // === 🦀休薬チェッカー: 判定画面ルート /{hId}/kyuyaku（オプション施設のみ・ここから） ===
    if (hospitalId && pathParts[1] === "kyuyaku") {
      const isSuperK = hospitalId === (env.SUPER_ADMIN_HID || "HPTEST1");
      if (!isSuperK) {
        const planK = await env.MEDI_KV.get(`${hospitalId}_plan`) || "";
        if (!planK.endsWith("_KY")) {
          return new Response("休薬チェッカーオプションが有効ではありませんカニ🦀", {
            status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }
      }
      return new Response(kyuyakuCheckerPage(hospitalId), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    // === 🦀休薬チェッカー: 判定画面ルート (ここまで) ===

    // === 新規追加: ユーザーパスワード機能 (ここから) ===
    const isUserLoginPage = pathParts[1] === "login" && pathParts[0] !== "api";
    const isUserLoginApi = url.pathname.includes("/api/userlogin");

    if (hospitalId && env.MEDI_KV) {
      const userPwd = await env.MEDI_KV.get(`${hospitalId}_userpwd`);
      if (userPwd) {
        let isUserAuth = false;
        const cookieString = request.headers.get("Cookie");
        if (cookieString) {
          const cookies = cookieString.split(';').map(c => c.trim());
          const targetCookie = `medikani_userauth_${hospitalId}=`;
          const authCookie = cookies.find(c => c.startsWith(targetCookie));
          if (authCookie) {
            const cookiePwd = decodeURIComponent(authCookie.substring(targetCookie.length));
            if (cookiePwd === userPwd) isUserAuth = true;
          }
        }
        
        // ログイン画面、ログインAPI、管理画面関連を除き、未認証ならブロック
        const isExempt = isUserLoginPage || isUserLoginApi || pathParts[1] === "admin" || url.pathname.includes("/api/admin/");
        if (!isUserAuth && !isExempt) {
          if (url.pathname.includes("/api/")) {
            return new Response(JSON.stringify({error: "ユーザー認証エラー"}), { status: 401, headers: { "Content-Type": "application/json" } });
          } else {
            return Response.redirect(`${url.origin}/${hospitalId}/login`, 302);
          }
        }
      }
    }
    // === 新規追加: ユーザーパスワード機能 (ここまで) ===

    // === 新規追加: 認証の判定ロジック (ここから) ===
    const isAdminResetPage = pathParts[1] === "admin" && pathParts[2] === "reset" && pathParts[0] !== "api";
    const isLoginPage = pathParts[1] === "admin" && pathParts[2] === "login" && pathParts[0] !== "api";
    const isLogoutPage = pathParts[1] === "admin" && pathParts[2] === "logout" && pathParts[0] !== "api";

    const isAdminResetApi = url.pathname.includes("/api/admin/reset");
    const isLoginApi = url.pathname.includes("/api/admin/login");
    const isAdminApi = url.pathname.includes("/api/admin/") && !isAdminResetApi && !isLoginApi;
    const isAdminPage = pathParts[1] === "admin" && pathParts[0] !== "api" && !isAdminResetPage && !isLoginPage && !isLogoutPage;

    if (isAdminApi || isAdminPage) {
      const targetHId = url.searchParams.get("h") || hospitalId;
      const isAuth = await this.checkAuth(request, env, targetHId);
      if (!isAuth) {
        if (isAdminApi) {
          return new Response(JSON.stringify({error: "認証エラー"}), { status: 401, headers: { "Content-Type": "application/json" } });
        } else {
          // ログイン画面へリダイレクト
          return Response.redirect(`${url.origin}/${targetHId}/admin/login`, 302);
        }
      }
    }
    // === 新規追加: 認証の判定ロジック (ここまで) ===

    // --- 1. Web画面の表示 (GETリクエスト) ---
    if (request.method === "GET") {

      // === 新規追加: 施設名の取得 (HTML描画用) ===
      let hospitalName = "";
      if (hospitalId && env.MEDI_KV && !url.pathname.includes("/api/")) {
        try { hospitalName = await env.MEDI_KV.get(`${hospitalId}_name`) || ""; } catch(e) {}
      }
      if (hospitalId === "HPTEST1" && !hospitalName) {
        hospitalName = "テスト総合病院";
      }

      // === 🦀メディカニ鑑別（持参薬サポート）: ページルート /{hId}/jisan (ここから) ===
      // 顧客マスタZ列「持参薬オプション」に◯がある施設（KV: {hId}_jisan = "1"）だけ利用可。
      // スーパー管理施設(HPTEST1)は常に可（テスト用）。
      if (hospitalId && pathParts[1] === "jisan") {
        const isSuperJisan = hospitalId === (env.SUPER_ADMIN_HID || "HPTEST1");
        if (!isSuperJisan) {
          const jisanFlag = await env.MEDI_KV.get(`${hospitalId}_jisan`) || "";
          if (jisanFlag !== "1") {
            return new Response("持参薬オプションが有効ではありませんカニ🦀", {
              status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
          }
        }
        return new Response(jisanPage(hospitalId, hospitalName), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      // === 🦀メディカニ鑑別: ページルート (ここまで) ===

      // === 新規追加: 掲示板データ取得 API (ここから) ===
      if (url.pathname.includes("/api/board")) {
        try {
          const bHId = url.searchParams.get("h") || "";
          if (!bHId) return new Response("[]", { headers: { "Content-Type": "application/json" } });
          const boardData = await env.MEDI_KV.get(`${bHId}_board`);
          return new Response(boardData || "[]", { headers: { "Content-Type": "application/json" } });
        } catch(e) { return new Response("[]", { status: 500 }); }
      }
      // === 新規追加: 掲示板データ取得 API (ここまで) ===

      // === 新規追加: 報告一覧取得 API (ここから) ===
      if (url.pathname.includes("/api/admin/reports")) {
        try {
          const rHId = url.searchParams.get("h") || "";
          let keys = [];
          let cursor = "";
          do {
            const list = await env.MEDI_KV.list({ prefix: `${rHId}_report_`, limit: 1000, cursor: cursor || undefined });
            keys.push(...list.keys.map(k => k.name));
            cursor = list.list_complete ? "" : list.cursor;
          } while (cursor);
          
          let reports = await Promise.all(keys.map(async k => {
            const val = await env.MEDI_KV.get(k);
            return val ? JSON.parse(val) : null;
          }));
          reports = reports.filter(r => r).sort((a, b) => b.timestamp - a.timestamp);
          return new Response(JSON.stringify(reports), { headers: { "Content-Type": "application/json" } });
        } catch(e) { return new Response("[]", { status: 500 }); }
      }
      // === 新規追加: 報告一覧取得 API (ここまで) ===
      
      // === 新規追加: ランキングデータ取得 API (ここから) ===
      if (url.pathname.includes("/api/admin/ranking")) {
        try {
          const rHId = url.searchParams.get("h") || "";
          const rankStr = await env.MEDI_KV.get(`${rHId}_ranking`);
          const rankData = rankStr ? JSON.parse(rankStr) : { favs: {}, views: {}, names: {} };
          
          // viewsは今月と先月の合算（直近約30〜60日として扱う）
          const aggregatedViews = {};
          Object.values(rankData.views || {}).forEach(monthData => {
            for (const [key, count] of Object.entries(monthData)) {
              aggregatedViews[key] = (aggregatedViews[key] || 0) + count;
            }
          });

          const allKeys = [...new Set([...Object.keys(rankData.favs || {}), ...Object.keys(aggregatedViews)])];
          const results = {};
          
          for (let i = 0; i < allKeys.length; i += 50) {
            const chunk = allKeys.slice(i, i + 50);
            const vals = await Promise.all(chunk.map(k => k.startsWith('[市販]') ? null : env.MEDI_KV.get(k)));
            chunk.forEach((k, idx) => {
              if (k.startsWith('[市販]')) {
                results[k] = rankData.names && rankData.names[k] ? '🛒 ' + rankData.names[k] : '🛒 ' + k.replace('[市販]', '');
              } else if (vals[idx]) {
                const p = String(vals[idx]).split(/[,\uFF0C]/);
                results[k] = p[0] || "名称不明";
              } else {
                results[k] = "名称不明";
              }
            });
          }

          const lastUpdate = rankData.last_update || {};
          const favRank = Object.entries(rankData.favs || {})
            .sort((a, b) => {
              if (b[1] !== a[1]) return b[1] - a[1];
              return (lastUpdate[b[0]] || 0) - (lastUpdate[a[0]] || 0);
            })
            .map(([k, v]) => ({ name: results[k], count: v }))
            .slice(0, 10);
          
          const viewRank = Object.entries(aggregatedViews)
            .sort((a, b) => {
              if (b[1] !== a[1]) return b[1] - a[1];
              return (lastUpdate[b[0]] || 0) - (lastUpdate[a[0]] || 0);
            })
            .map(([k, v]) => ({ name: results[k], count: v }))
            .slice(0, 10);

          return new Response(JSON.stringify({ favRank, viewRank }), { headers: { "Content-Type": "application/json" } });
        } catch(e) { return new Response(JSON.stringify({ favRank: [], viewRank: [] }), { status: 500 }); }
      }
      // === 新規追加: ランキングデータ取得 API (ここまで) ===
      // === 🌟新規追加: 採用薬一覧取得 API （あいうえお順） ===
      if (url.pathname.includes("/api/adopted-list")) {
        try {
          const hId = url.searchParams.get("h") || "";
          const cat = url.searchParams.get("c") || ""; // "[内]", "[外]", "[注]"
          if (!hId || !env.MEDI_KV) return new Response("[]", { headers: { "Content-Type": "application/json" } });
          
          const jsonStr = await env.MEDI_KV.get(`${hId}_adopted_list_json`);
          if (!jsonStr) return new Response("[]", { headers: { "Content-Type": "application/json" } });
          
          let list = JSON.parse(jsonStr);
          // 指定された区分（内服・外用・注射）だけでフィルターをかける
          if (cat) {
            list = list.filter(d => d.cat === cat);
          }
          // 💊 トリさんリクエスト：薬品名を綺麗にあいうえお順（昇順）にソート
          list.sort((a, b) => (a.name || "").localeCompare(b.name || "", 'ja'));
          return new Response(JSON.stringify(list), { headers: { "Content-Type": "application/json" } });
        } catch(e) { return new Response("[]", { status: 500 }); }
      }


      // === 🦀休薬チェッカー: API (ここから) ===
      // === 🦀新規追加: 休薬オプション加入判定（{hId}_plan の末尾 "_KY" ／ スーパー管理は常に可） ===
      async function kyuyakuPlanOk(hId) {
        if (!hId) return false;
        if (hId === (env.SUPER_ADMIN_HID || "HPTEST1")) return true;
        const plan = await env.MEDI_KV.get(`${hId}_plan`) || "";
        return plan.endsWith("_KY");
      }

      // === 🦀メディカニ鑑別: 刻印検索 API /api/jisan-search?h=&q= (ここから) ===
      if (url.pathname.includes("/api/jisan-search")) {
        try {
          const hId = url.searchParams.get("h") || "";
          // オプション判定（スーパー管理は常に可）
          const isSuperJisan = hId === (env.SUPER_ADMIN_HID || "HPTEST1");
          if (!isSuperJisan) {
            const jisanFlag = (hId ? await env.MEDI_KV.get(`${hId}_jisan`) : "") || "";
            if (jisanFlag !== "1") {
              return new Response(JSON.stringify({ error: "option_disabled" }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
          }
          const q = url.searchParams.get("q") || "";
          // 正規化（idx2kv.py と同じルール: 全角→半角(NFKC)・大文字化・空白除去）
          const qn = q.normalize("NFKC").toUpperCase().replace(/\s+/g, "");
          if (qn.length < 2) {
            return new Response(JSON.stringify({ error: "too_short" }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          if (!env.PMDA_DB) {
            return new Response(JSON.stringify({ error: "PMDA_DB未設定" }), { status: 500, headers: { "Content-Type": "application/json" } });
          }
          // 索引（1キー）を読み込む。cacheTtlで1時間キャッシュして読み取りを節約
          const idxStr = await env.PMDA_DB.get("_IDCODE_INDEX", { cacheTtl: 3600 });
          if (!idxStr) {
            return new Response(JSON.stringify({ error: "index_not_found" }), { status: 500, headers: { "Content-Type": "application/json" } });
          }
          const idx = JSON.parse(idxStr);
          // 刻印の部分一致でヒットしたYJコードを集める（YJ→刻印表示/PMDA名のマップ）
          const yjHit = new Map();
          for (const e of idx) {
            // e = [正規化刻印, 表示用刻印, 薬品名, YJコード]
            if (e[0].includes(qn) && !yjHit.has(e[3])) {
              yjHit.set(e[3], { code: e[1], pmdaName: e[2] });
              if (yjHit.size >= 50) break;
            }
          }
          if (yjHit.size === 0) {
            return new Response(JSON.stringify({ results: [], count: 0 }), { headers: { "Content-Type": "application/json" } });
          }

          // ===== 🌟通常検索と同じ見た目にするため、MEDI_KVからマスタ・採用情報を突き合わせる =====
          let masterKeys = [];
          let adoptedKeys = [];
          for (const c of ["[内]", "[外]", "[注]"]) {
            let mCursor = "";
            do {
              const list = await env.MEDI_KV.list({ prefix: c, limit: 1000, cursor: mCursor || undefined });
              masterKeys.push(...list.keys.map(k => k.name));
              mCursor = list.list_complete ? "" : list.cursor;
            } while (mCursor);
            if (hId) {
              let aCursor = "";
              do {
                const list = await env.MEDI_KV.list({ prefix: `${hId}_${c}`, limit: 1000, cursor: aCursor || undefined });
                adoptedKeys.push(...list.keys.map(k => k.name));
                aCursor = list.list_complete ? "" : list.cursor;
              } while (aCursor);
            }
          }

          // キー末尾のYJがヒット集合に含まれるものを拾う
          const keyYj = (k) => { const t = k.split("_").pop(); return /^[0-9a-zA-Z]{7,12}$/.test(t) ? t : ""; };
          const matchedAdopted = adoptedKeys.filter(k => yjHit.has(keyYj(k)));
          const adoptedYJs = new Set(matchedAdopted.map(k => keyYj(k)));
          const matchedMaster = masterKeys.filter(k => yjHit.has(keyYj(k)) && !adoptedYJs.has(keyYj(k)));
          const finalKeys = [...matchedAdopted, ...matchedMaster];

          const results = await Promise.all(finalKeys.map(async (key) => {
            const val = await env.MEDI_KV.get(key);
            if (!val) return null;
            let parts = String(val).split(/[,\uFF0C]/);
            const yj = getBestYJ(key, parts);
            const isAdopted = hId ? key.startsWith(`${hId}_`) : false;
            if (isAdopted) {
              // 表示時のみマスタの情報で丸ごと上書きしてマーク・薬価を復活（通常検索と同じ処理）
              const yjIndex = parts.findIndex(p => p.replace(/[^a-zA-Z0-9]/g, "") === yj);
              if (yjIndex !== -1 && yjIndex < parts.length - 1) {
                parts = parts.slice(0, yjIndex + 1);
              }
              if (yj && yj !== "NONE") {
                const masterKey = masterKeys.find(k => k.endsWith(`_${yj}`) || k.endsWith(yj));
                if (masterKey) {
                  const mVal = await env.MEDI_KV.get(masterKey);
                  if (mVal) {
                    const mParts = String(mVal).split(/[,\uFF0C]/);
                    const mYjIdx = mParts.findIndex(p => p.replace(/[^a-zA-Z0-9]/g, "") === yj);
                    if (mYjIdx !== -1) parts = mParts.slice(0, mYjIdx + 1);
                  }
                }
              }
            }
            const extracted = extractDrugData(parts, yj);
            const isBrand = parts.some(p => String(p).includes("先発"));
            const cleanType = extracted.type.replace(/先発品?/g, "");
            const hit = yjHit.get(keyYj(key)) || {};
            return { key, name: extracted.name, spec: extracted.spec, type: cleanType, yj: yj, isAdopted: isAdopted, isBrand: isBrand, price: extracted.price, code: hit.code || "" };
          }));

          let finalResults = results.filter(r => r !== null);

          // マスタに存在しないYJ（経過措置切れ等）はPMDA名でフォールバック表示
          const foundYJs = new Set(finalResults.map(r => r.yj));
          for (const [yj, info] of yjHit) {
            if (!foundYJs.has(yj)) {
              finalResults.push({ key: "", name: info.pmdaName, spec: "", type: "", yj: yj, isAdopted: false, isBrand: false, price: "", code: info.code });
            }
          }

          // 採用薬を一番上に（通常検索と同じ並び）
          finalResults.sort((a, b) => b.isAdopted - a.isAdopted);

          return new Response(JSON.stringify({ results: finalResults, count: finalResults.length }), {
            headers: { "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
      }
      // === 🦀メディカニ鑑別: 刻印検索 API (ここまで) ===

      // === 🦀新規追加: 休薬マスタ取得 API（デフォルト＋施設オーバーライドを返す） ===
      if (url.pathname.includes("/api/kyuyaku/master")) {
        try {
          const hId = url.searchParams.get("h") || "";
          if (!(await kyuyakuPlanOk(hId))) {
            return new Response(JSON.stringify({ error: "option_disabled" }), { status: 403 });
          }
          const [defStr, ovrStr] = await Promise.all([
            env.MEDI_KV.get("KYUYAKU_DEFAULT_json"),
            env.MEDI_KV.get(`${hId}_kyuyaku_json`)
          ]);
          return new Response(JSON.stringify({
            def: defStr ? JSON.parse(defStr) : null,
            ovr: ovrStr ? JSON.parse(ovrStr) : null,
            isSuper: hId === (env.SUPER_ADMIN_HID || "HPTEST1")
          }), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
        }
      }

      // === 🦀新規追加: 休薬マスタ保存 API（パスワード必須） ===
      if (url.pathname.includes("/api/admin/kyuyaku") && request.method === "POST") {
        try {
          const hId = url.searchParams.get("h") || "";
          if (!(await kyuyakuPlanOk(hId))) {
            return new Response(JSON.stringify({ success: false, error: "option_disabled" }), { status: 403 });
          }
          const body = await request.json();
          // 施設管理パスワードで認証（既存の {hId}_pwd を流用）
          const pwd = await env.MEDI_KV.get(`${hId}_pwd`);
          if (!hId || !pwd || body.pwd !== pwd) {
            return new Response(JSON.stringify({ success: false, error: "auth" }), { status: 403 });
          }
          const data = body.data || {};
          data.updatedAt = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });

          if (body.scope === "default") {
            // 共通デフォルトの更新はスーパー管理施設のみ
            if (hId !== (env.SUPER_ADMIN_HID || "HPTEST1")) {
              return new Response(JSON.stringify({ success: false, error: "forbidden" }), { status: 403 });
            }
            await env.MEDI_KV.put("KYUYAKU_DEFAULT_json", JSON.stringify(data));
          } else {
            await env.MEDI_KV.put(`${hId}_kyuyaku_json`, JSON.stringify(data));
          }
          return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: String(e) }), { status: 500 });
        }
      }
      // === 🦀休薬チェッカー: API (ここまで) ===
      // 検索API (Web用)
      if (url.pathname.includes("/api/search")) {
        try {
          const query = url.searchParams.get("q") || "";
          const cat = url.searchParams.get("c") || "[内]";
          const hId = url.searchParams.get("h") || "";
          
          if (!env.MEDI_KV) return new Response(JSON.stringify({ error: "KV未設定" }), { status: 500 });
          
          if (cat === "[市販]") {
            // ひらがな入力をカタカナに変換してAIとGoogle検索に渡す
            const kataQuery = hiraToKata(query);
            const aiInfo = await this.askAI(kataQuery, env.OPENAI_API_KEY);
            return new Response(JSON.stringify({ isOtc: true, aiInfo: aiInfo, kataQuery: kataQuery }), { headers: { "Content-Type": "application/json" } });
          }
          
          const results = await this.handleWebSearch(query, cat, hId, env);
          return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
      }
      
      // === 新規追加: 詳細画面用AI API (ここから) ===
      // ※吸い込みバグ防止のため、必ず /api/detail より上に配置します
      if (url.pathname.includes("/api/detail-ai")) {
        try {
          const query = url.searchParams.get("q") || "";
          if (!query) return new Response(JSON.stringify({ error: "薬品名がありません" }), { status: 400 });
          const aiInfo = await this.askDetailAI(query, env.OPENAI_API_KEY);
          return new Response(JSON.stringify({ info: aiInfo }), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
      }
      // === 新規追加: 詳細画面用AI API (ここまで) ===

      // 詳細API (Web用)
      if (url.pathname.includes("/api/detail")) {
        try {
          const key = url.searchParams.get("key") || "";
          const hId = url.searchParams.get("h") || "";
          const result = await this.handleWebDetail(key, hId, env);
          return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
      }

      // === 新規追加: 認証とリセット関連画面 (ここから) ===
      if (isLoginPage) {
        return new Response(this.getLoginHTML(env, hospitalId, hospitalName), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }
      if (isLogoutPage) {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": `/${hospitalId}/admin/login`,
            "Set-Cookie": `medikani_auth_${hospitalId}=; Path=/; HttpOnly; Secure; Max-Age=0`
          }
        });
      }
      if (isAdminResetPage) {
        return new Response(this.getResetHTML(env, hospitalId, hospitalName), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }
      if (isUserLoginPage) {
        return new Response(this.getUserLoginHTML(hospitalId, hospitalName), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }
      // === 新規追加: 認証とリセット関連画面 (ここまで) ===

      // === 新規追加: 管理画面と管理用API (ここから) ===
      if (url.pathname.includes("/api/admin/meta")) {
        try {
          const metaHId = url.searchParams.get("h") || "";
          const metaStr = await env.MEDI_KV.get(`${metaHId}_meta`);
          let currentEmail = await env.MEDI_KV.get(`${metaHId}_email`);
          if (!currentEmail && metaHId === "HPTEST1") currentEmail = "toriweb+medi@gmail.com";
          const meta = metaStr ? JSON.parse(metaStr) : { count: 0, lastUpdated: null };

          // === 修正: メタデータの数字を信じず、毎回リアルタイムで数え直す ===
          let realCount = 0;
          let cursor = "";
          do {
            const list = await env.MEDI_KV.list({ prefix: `${metaHId}_`, limit: 1000, cursor: cursor || undefined });
            realCount += list.keys.filter(k => !k.name.endsWith("_meta") && !k.name.endsWith("_pwd") && !k.name.endsWith("_userpwd") && !k.name.endsWith("_email") && !k.name.endsWith("_board") && !k.name.endsWith("_ranking") && !k.name.endsWith("_name") && !k.name.includes("_report_") && !k.name.includes("COMP_")).length;
            cursor = list.list_complete ? "" : list.cursor;
          } while (cursor);
          meta.count = realCount;
          // ==============================================================

          meta.email = currentEmail || "未登録"; // 画面表示用にメアドも含めて返す
          let userPwd = await env.MEDI_KV.get(`${metaHId}_userpwd`);
          meta.userPwd = userPwd || "";
          return new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } });
        } catch(e) { return new Response("{}", { status: 500 }); }
      }

      // 管理用API: 既存キーの取得 (差分分析用)
      // ※ここでは意図的に COMP_ も取得させ、フル同期時にゴミデータを削除できるようにします
      if (url.pathname.includes("/api/admin/keys")) {
        try {
          const listHId = url.searchParams.get("h") || "";
          let keys = [];
          let cursor = "";
          do {
            const list = await env.MEDI_KV.list({ prefix: `${listHId}_`, limit: 1000, cursor: cursor || undefined });
            keys.push(...list.keys.map(k => k.name).filter(n => !n.endsWith("_meta") && !n.endsWith("_pwd") && !n.endsWith("_userpwd") && !n.endsWith("_email") && !n.endsWith("_board") && !n.includes("_report_") && !n.endsWith("_ranking")));
            cursor = list.list_complete ? "" : list.cursor;
          } while (cursor);
          return new Response(JSON.stringify({ keys: keys }), { headers: { "Content-Type": "application/json" } });
        } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
      }

      // === 新規追加: CSVダウンロード API (ここから) ===
      if (url.pathname.includes("/api/admin/download")) {
        try {
          const dHId = url.searchParams.get("h") || "";
          if (!dHId) return new Response("Error", { status: 400 });

          let keys = [];
          let cursor = "";
          do {
            const list = await env.MEDI_KV.list({ prefix: `${dHId}_`, limit: 1000, cursor: cursor || undefined });
            // ダウンロード時は絶対に COMP_ ゴミデータを排除する
            keys.push(...list.keys.map(k => k.name).filter(n => !n.endsWith("_meta") && !n.endsWith("_pwd") && !n.endsWith("_userpwd") && !n.endsWith("_email") && !n.endsWith("_board") && !n.includes("_report_") && !n.includes("COMP_") && !n.endsWith("_ranking")));
            cursor = list.list_complete ? "" : list.cursor;
          } while (cursor);
          keys.sort();

          let csv = "\uFEFFYJコード,薬品名,規格,メモ\n"; // BOMを追加してExcelで文字化けしないようにする
          for (let i = 0; i < keys.length; i += 50) {
            const chunk = keys.slice(i, i + 50);
            const vals = await Promise.all(chunk.map(k => env.MEDI_KV.get(k)));
            chunk.forEach((k, idx) => {
              if (vals[idx]) {
                let valStr = String(vals[idx]);
                // 古いCOMPデータ（配列文字）が万が一混ざっていたらスキップ
                if (valStr.trim().startsWith("[")) return;
                
                let p = valStr.split(/[,\uFF0C]/);
                const yj = getBestYJ(k, p);
                
                // ===== 🌟修正: マスタの名前を優先して取得する =====
                const extracted = extractDrugData(p, yj);
                
                // YJコードをもとに辞書からマスタの正確な名前を取得（なければ抽出した名前）
                const realName = extracted.name;
                
                // 🌟規格はくっつけず、マスタの薬品名だけをそのまま使う！
                const name = realName.replace(/"/g, '""');
                
                // 規格の列にはそのまま規格を入れる
                const spec = extracted.spec.replace(/"/g, '""');
                // ==========================================================

                let comment = "";
                const yjIndex = p.findIndex(x => x.replace(/[^a-zA-Z0-9]/g, "") === yj);
                if (yjIndex !== -1 && yjIndex < p.length - 1) {
                  comment = p.slice(yjIndex + 1).join(",").trim().replace(/"/g, '""');
                }
                csv += `"${yj}","${name}","${spec}","${comment}"\n`;
              }
            });
          }
          return new Response(csv, { 
            headers: { 
              "Content-Type": "text/csv; charset=utf-8", 
              "Content-Disposition": `attachment; filename="adopted_${dHId}.csv"` 
            } 
          });
        } catch(e) { 
          return new Response(JSON.stringify({ error: e.message }), { status: 500 }); 
        }
      }
      
      // === 新規追加: 報告CSVダウンロード API ===
      if (url.pathname.includes("/api/admin/download-reports")) {
        try {
          const dHId = url.searchParams.get("h") || "";
          if (!dHId) return new Response("Error", { status: 400 });

          let keys = [];
          let cursor = "";
          do {
            const list = await env.MEDI_KV.list({ prefix: `${dHId}_report_`, limit: 1000, cursor: cursor || undefined });
            keys.push(...list.keys.map(k => k.name));
            cursor = list.list_complete ? "" : list.cursor;
          } while (cursor);

          let csv = "\uFEFF日時,状態,報告者,種類,薬品名,YJコード,コメント\n";
          const reports = await Promise.all(keys.map(async k => {
            const val = await env.MEDI_KV.get(k);
            return val ? JSON.parse(val) : null;
          }));
          
          reports.filter(r => r).sort((a,b) => b.timestamp - a.timestamp).forEach(r => {
            const date = new Date(r.timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
            const status = r.isDone ? "済" : "未";
            const type = r.type.replace(/"/g, '""');
            const name = r.name.replace(/"/g, '""');
            const drugName = r.drugName.replace(/"/g, '""');
            const comment = r.comment.replace(/"/g, '""');
            csv += `"${date}","${status}","${name}","${type}","${drugName}","${r.yj || ''}","${comment}"\n`;
          });

          return new Response(csv, { 
            headers: { 
              "Content-Type": "text/csv; charset=utf-8", 
              "Content-Disposition": `attachment; filename="reports_${dHId}.csv"` 
            } 
          });
        } catch(e) { return new Response("Error", { status: 500 }); }
      }
      // === 新規追加: CSVダウンロード API (ここまで) ===
      
      if (isAdminPage) {
        // === 新規追加: 古いパス制限クッキーの自動修復（スライディングセッション） ===
        // 管理画面を開いた瞬間に、サイト全体(Path=/)で有効なクッキーを上書き発行してバグを自己修復します
        let currentPwd = await env.MEDI_KV.get(`${hospitalId}_pwd`);
        if (!currentPwd) currentPwd = (hospitalId === 'HPTEST1') ? '12345' : hospitalId;
        
        return new Response(this.getDashboardHTML(env, hospitalId, hospitalName), { 
          headers: { 
            "Content-Type": "text/html;charset=UTF-8",
            "Set-Cookie": `medikani_auth_${hospitalId}=${encodeURIComponent(currentPwd)}; Path=/; HttpOnly; Secure; Max-Age=2592000`
          } 
        });
      }
      // === 新規追加: 管理画面と管理用API (ここまで) ===
      
      // メイン画面の表示
      let globalInfo = "";
      try {
        globalInfo = await env.MEDI_KV.get("GLOBAL_INFO") || "";
      } catch(e) { console.log("KV Get Error", e); }
      
      // メイン画面の表示（第4引数に globalInfo を追加）
      return new Response(this.getAdminHTML(env, hospitalId, hospitalName, globalInfo), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // === 新規追加: 報告投稿API (ユーザー側) ===
    if (request.method === "POST" && url.pathname.includes("/api/report")) {
      try {
        const body = await request.json();
        const rHId = url.searchParams.get("h") || "";
        if (!rHId || !body.comment) return new Response(JSON.stringify({error: "Invalid data"}), { status: 400 });

        const timestamp = Date.now();
        const key = `${rHId}_report_${timestamp}`;
        const reportData = {
          key: key,
          timestamp: timestamp,
          yj: body.yj || "",
          drugName: body.drugName || "",
          type: body.type || "その他",
          comment: body.comment,
          name: body.name || "名無し",
          isDone: false
        };

        // TTLを90日（7776000秒）に設定して保存
        await env.MEDI_KV.put(key, JSON.stringify(reportData), { expirationTtl: 7776000 });
        
        return new Response(JSON.stringify({success: true}), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // === 新規追加: 報告完了(済)API (管理用) ===
    if (request.method === "POST" && url.pathname.includes("/api/admin/report-done")) {
      try {
        const body = await request.json();
        if (!body.key) return new Response(JSON.stringify({error: "Key missing"}), { status: 400 });

        const val = await env.MEDI_KV.get(body.key);
        if (val) {
          const reportData = JSON.parse(val);
          reportData.isDone = true;
          // 済にしてもTTLはリセットせずそのまま上書き（元々のTTLを維持するのはKVでは難しいので、更新時の時間からさらに90日とするか、省略して無期限にするかですが、仕様上90日で消えるのが良いので再度TTLセット）
          await env.MEDI_KV.put(body.key, JSON.stringify(reportData), { expirationTtl: 7776000 });
        }
        return new Response(JSON.stringify({success: true}), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // === 新規追加: 掲示板API (管理用) ===
    if (request.method === "POST" && url.pathname.includes("/api/admin/board")) {
      try {
        const body = await request.json();
        const bHId = url.searchParams.get("h") || "";
        let currentBoard = await env.MEDI_KV.get(`${bHId}_board`);
        let boardArr = currentBoard ? JSON.parse(currentBoard) : [];

        if (body.action === "post") {
          boardArr.unshift({
            id: Date.now(),
            date: new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' ' + new Date().toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit', timeZone: 'Asia/Tokyo' }),
            message: body.message
          });
          if (boardArr.length > 50) boardArr.pop(); // 最大50件保持
        } else if (body.action === "delete") {
          boardArr = boardArr.filter(b => b.id !== body.id);
        } else if (body.action === "edit") {
          // 🌟修正：ここを追加！対象のIDを探してメッセージを上書きする
          const target = boardArr.find(b => b.id === body.id);
          if (target) {
            target.message = body.message;
          }
        }

        await env.MEDI_KV.put(`${bHId}_board`, JSON.stringify(boardArr));
        return new Response(JSON.stringify({success: true}), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // === 新規追加: ログイン API ===
    if (request.method === "POST" && isLoginApi) {
      try {
        const body = await request.json();
        const lHId = body.hId;
        const lPwd = body.pwd;
        
        let pwd = await env.MEDI_KV.get(`${lHId}_pwd`);
        if (!pwd) pwd = (lHId === 'HPTEST1') ? '12345' : lHId;

        if (lPwd === pwd) {
          return new Response(JSON.stringify({success: true}), {
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": `medikani_auth_${lHId}=${encodeURIComponent(lPwd)}; Path=/; HttpOnly; Secure; Max-Age=2592000`
            }
          });
        } else {
          return new Response(JSON.stringify({success: false, error: "パスワードが違いますカニ🦀"}), { headers: { "Content-Type": "application/json" } });
        }
      } catch(e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // === 新規追加: ユーザーログイン API ===
    if (request.method === "POST" && isUserLoginApi) {
      try {
        const body = await request.json();
        const lHId = body.hId;
        const lPwd = body.pwd;
        
        const pwd = await env.MEDI_KV.get(`${lHId}_userpwd`);

        if (lPwd === pwd) {
          return new Response(JSON.stringify({success: true}), {
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": `medikani_userauth_${lHId}=${encodeURIComponent(lPwd)}; Path=/; HttpOnly; Secure; Max-Age=31536000`
            }
          });
        } else {
          return new Response(JSON.stringify({success: false, error: "パスワードが違いますカニ🦀"}), { headers: { "Content-Type": "application/json" } });
        }
      } catch(e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // === 新規追加: ランキング集計API (ここから) ===
    if (request.method === "POST" && url.pathname.includes("/api/track")) {
      try {
        const body = await request.json();
        const tHId = url.searchParams.get("h") || "";
        if (!tHId || !body.key) return new Response("OK", { status: 200 });

        const rKey = `${tHId}_ranking`;
        let rankData = { favs: {}, views: {}, names: {} };
        try { const val = await env.MEDI_KV.get(rKey); if (val) rankData = JSON.parse(val); } catch(e) {}
        if (!rankData.names) rankData.names = {};
        if (!rankData.last_update) rankData.last_update = {};

        // 送信されてきた名前を保存
        if (body.name) {
          rankData.names[body.key] = body.name;
        }
        rankData.last_update[body.key] = Date.now();

        if (body.type === 'fav') {
          rankData.favs[body.key] = (rankData.favs[body.key] || 0) + body.val;
          if (rankData.favs[body.key] <= 0) delete rankData.favs[body.key];
        } else if (body.type === 'view') {
          // 月ごとのキー (例: 2026-04)
          const ym = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).replace('/', '-');
          if (!rankData.views[ym]) rankData.views[ym] = {};
          rankData.views[ym][body.key] = (rankData.views[ym][body.key] || 0) + 1;
          
          // 古い月のデータを削除（今月と先月の2ヶ月分だけ残す）
          const months = Object.keys(rankData.views).sort().reverse();
          if (months.length > 2) {
            months.slice(2).forEach(m => delete rankData.views[m]);
          }
        }
        await env.MEDI_KV.put(rKey, JSON.stringify(rankData));
        return new Response("OK", { status: 200 });
      } catch(e) { return new Response("Error", { status: 500 }); }
    }
    // === 新規追加: ランキング集計API (ここまで) ===

// === 新規追加: CSVアップロード等の POST API (ここから) ===
    if (request.method === "POST" && url.pathname.includes("/api/admin/upload")) {
      try {
        const uploadHId = url.searchParams.get("h") || ""; 
        const body = await request.json();
        const items = body.items || [];
        let deletes = body.deletes || []; // 🌟 const を let に変更
        
       // ===== 🌟ここから追加: YJコードからマスタの薬品名を探して強制上書き =====
        // 1. 全マスタキーを裏側でサクッと取得
        let allMasterKeys = [];
        for (const c of ["[内]", "[外]", "[注]"]) {
          let cursor = "";
          do {
            const list = await env.MEDI_KV.list({ prefix: c, limit: 1000, cursor: cursor || undefined });
            allMasterKeys.push(...list.keys.map(k => k.name));
            cursor = list.list_complete ? "" : list.cursor;
          } while (cursor);
        }

        // 2. 「完全一致用辞書」と「成分（前方7桁）による多数決用辞書」を作る
        const yjToMasterKey = {};
        const prefixStats = {}; // 例: { "1319702": { "[内]": 0, "[外]": 5, "[注]": 0 } }

        for (const mk of allMasterKeys) {
          const yj = mk.split('_').pop();
          const catMatch = mk.match(/^(\[.*?\])/);
          const cat = catMatch ? catMatch[1] : null;

          if (yj && cat) {
            yjToMasterKey[yj] = mk;
            // ③のための準備：前方7桁（成分コード）の分類をカウント
            if (yj.length >= 7) {
              const prefix = yj.substring(0, 7);
              if (!prefixStats[prefix]) prefixStats[prefix] = { "[内]": 0, "[外]": 0, "[注]": 0 };
              prefixStats[prefix][cat]++;
            }
          }
        }

        // 3. マスタの「値（Value）」を取得して、正式な薬品名を取り出す！
        const yjToMasterName = {};
        const fetchPromises = [];
        for (let item of items) {
          let parts = item.val.split(",");
          const yj = getBestYJ(item.key, parts); // 🌟修正: parts[4]決め打ちをやめ、カンマズレ対策関数を使う！
          if (yj && yj !== "NONE" && yjToMasterKey[yj] && !yjToMasterName[yj]) {
            yjToMasterName[yj] = "loading"; // 重複取得を防ぐ
            fetchPromises.push(
              env.MEDI_KV.get(yjToMasterKey[yj]).then(val => {
                if (val) {
                  // ✨ここでKVの値（Value）の1番目からフルネームをバッチリ取得！
                  yjToMasterName[yj] = String(val).split(/[,\uFF0C]/)[0].trim();
                }
              })
            );
          }
        }
        await Promise.all(fetchPromises);

        // 4. CSVから来たアイテムを、3段構えで分類判定し、薬品名を上書き！
        for (let item of items) {
          let parts = item.val.split(",");
          const yj = getBestYJ(item.key, parts);
          
          let cat = "[内]"; // 何も当てはまらなかった時の最終デフォルト
          let masterName = parts[0];
          let updated = false;

          if (yj && yj !== "NONE") {
            // ① 完全一致するマスタがある場合（従来通り）
            if (yjToMasterKey[yj]) {
              const masterKey = yjToMasterKey[yj];
              const catMatch = masterKey.match(/^(\[.*?\])/);
              cat = catMatch ? catMatch[1] : "[内]";
              masterName = yjToMasterName[yj] || parts[0];
              updated = true;
            } else {
              // ==========================================
              // 🌟マスタに完全一致しない場合の推測ロジック（3段構え）🌟
              // ==========================================
              let guessedCat = null;
              
              // ② YJコードの8桁目のアルファベットによる推測（B,C,Fは内服。M,P,Q,R,S等は外用）
              if (yj.length >= 8) {
                const f = yj.charAt(7).toUpperCase();
                if (["B", "C", "F"].includes(f)) {
                  guessedCat = "[内]";
                } else if (["M", "P", "Q", "R", "S", "T", "U", "V", "W", "J"].includes(f)) {
                  guessedCat = "[外]";
                }
              }

              // ③ アルファベットで決まらない場合、同成分（前方7桁）が多い分類を採用（多数決）
              if (!guessedCat && yj.length >= 7) {
                const prefix = yj.substring(0, 7);
                if (prefixStats[prefix]) {
                  const stats = prefixStats[prefix];
                  let maxCount = 0;
                  for (const c of ["[内]", "[外]", "[注]"]) {
                    if (stats[c] > maxCount) {
                      maxCount = stats[c];
                      guessedCat = c;
                    }
                  }
                }
              }

              if (guessedCat) {
                cat = guessedCat;
                updated = true; // 推測で分類が決まったので更新フラグを立てる
              }
            }
          }

          if (updated || item.key !== `${uploadHId}_${cat}${masterName}_${yj}`) {
            const newKey = `${uploadHId}_${cat}${masterName}_${yj}`;
            
            if (item.key !== newKey) {
              deletes.push(item.key);
            }
            // CSVの薬品名で作られたかもしれない間違った分類のキーを全滅させる
            deletes.push(`${uploadHId}_[内]${parts[0]}_${yj}`);
            deletes.push(`${uploadHId}_[外]${parts[0]}_${yj}`);
            deletes.push(`${uploadHId}_[注]${parts[0]}_${yj}`);
            
            // 新しい名前（マスタの名前）で分類だけ間違っているパターンも全滅させる
            deletes.push(`${uploadHId}_[内]${masterName}_${yj}`);
            deletes.push(`${uploadHId}_[外]${masterName}_${yj}`);
            deletes.push(`${uploadHId}_[注]${masterName}_${yj}`);
            
            item.key = newKey; // 裏側のIDを正しい分類とマスタ名に
            parts[0] = masterName; // 画面に出る薬品名もマスタ名に
            item.val = parts.join(",");
          }
        }

        // 5. 名前が変わったことで「削除対象」に間違って入ってしまったキーを救出
        const putKeys = new Set(items.map(i => i.key));
        deletes = deletes.filter(k => !putKeys.has(k));
        // ===== 🌟ここまで追加 =====
        // KVの制限を考慮し、追加分を50件ずつチャンクで保存
        for (let i = 0; i < items.length; i += 50) {
          const chunk = items.slice(i, i + 50);
          await Promise.all(chunk.map(item => env.MEDI_KV.put(item.key, item.val)));
        }
        
        // 削除分（採用落ち）を50件ずつチャンクで削除
        for (let i = 0; i < deletes.length; i += 50) {
          const chunk = deletes.slice(i, i + 50);
          await Promise.all(chunk.map(k => env.MEDI_KV.delete(k)));
        }

        const finalCount = body.finalCount !== undefined ? body.finalCount : items.length;
        
        // 更新メタデータを保存
        const meta = { lastUpdated: new Date().toISOString(), count: finalCount };
        await env.MEDI_KV.put(`${uploadHId}_meta`, JSON.stringify(meta));
        
        // ===== 🌟追加: ここでさっき作った最強関数を呼んでJSONを最新化！ =====
        await rebuildAdoptedJson(uploadHId, env);
        // ==========================================================

        return new Response(JSON.stringify({ success: true, count: finalCount }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // --- 新機能: 個別コメント保存API (管理用) ---
    if (request.method === "POST" && url.pathname.includes("/api/admin/save-comment")) {
      try {
        const body = await request.json();
        const { key, comment } = body;
        if (!key) return new Response(JSON.stringify({error: "Key missing"}), { status: 400 });

        const val = await env.MEDI_KV.get(key);
        if (!val) return new Response(JSON.stringify({error: "Data not found"}), { status: 404 });

        let parts = String(val).split(/[,\uFF0C]/);
        const yj = getBestYJ(key, parts);
        const yjIndex = parts.findIndex(p => p.replace(/[^a-zA-Z0-9]/g, "") === yj);

        if (yjIndex !== -1) {
          const newVal = [...parts.slice(0, yjIndex + 1), comment].join(",");
          await env.MEDI_KV.put(key, newVal);
          return new Response(JSON.stringify({success: true}), { headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({error: "Format error"}), { status: 500 });
      } catch (e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // --- 新機能: 個別削除API (管理用) ---
    if (request.method === "POST" && url.pathname.includes("/api/admin/delete-item")) {
      try {
        const body = await request.json();
        const { key } = body;
        if (!key) return new Response(JSON.stringify({error: "Key missing"}), { status: 400 });
        await env.MEDI_KV.delete(key);
        return new Response(JSON.stringify({success: true}), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // --- 新機能: 個別追加API (管理用) ---
    if (request.method === "POST" && url.pathname.includes("/api/admin/add-item")) {
      try {
        const body = await request.json();
        const { masterKey, comment } = body;
        const addHId = url.searchParams.get("h") || "";
        if (!masterKey || !addHId) return new Response(JSON.stringify({error: "Data missing"}), { status: 400 });

        const mVal = await env.MEDI_KV.get(masterKey);
        if (!mVal) return new Response(JSON.stringify({error: "Master not found"}), { status: 404 });

        let parts = String(mVal).split(/[,\uFF0C]/);
        const yj = getBestYJ(masterKey, parts);
        const yjIndex = parts.findIndex(p => p.replace(/[^a-zA-Z0-9]/g, "") === yj);

        if (yjIndex !== -1) {
          const newVal = [...parts.slice(0, yjIndex + 1), comment || ""].join(",");
          const newKey = `${addHId}_${masterKey}`;
          await env.MEDI_KV.put(newKey, newVal);
          
          // メタデータのカウントも更新しておく
          try {
             let metaStr = await env.MEDI_KV.get(`${addHId}_meta`);
             if (metaStr) {
               let meta = JSON.parse(metaStr);
               meta.count = (meta.count || 0) + 1;
               meta.lastUpdated = new Date().toISOString();
               await env.MEDI_KV.put(`${addHId}_meta`, JSON.stringify(meta));
             }
          } catch(e) {}

          return new Response(JSON.stringify({success: true}), { headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({error: "Format error"}), { status: 500 });
      } catch (e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // パスワード変更 (管理画面内から) 【作戦A仕様に更新】＋【メール通知追加】
    if (request.method === "POST" && url.pathname.includes("/api/admin/changepwd")) {
      try {
        const cpBody = await request.json();
        const cpHId = url.searchParams.get("h") || "";
        
        // 環境変数 GAS_URL が設定されているか確認
        if (!env.GAS_URL) {
          throw new Error("環境変数 GAS_URL が設定されていませんカニ🦀");
        }
        
        // GASへPOSTリクエストを送信
        const gasRes = await fetch(env.GAS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            facilityId: cpHId,
            newPassword: cpBody.newPwd
          })
        });
        
        const gasData = await gasRes.json();
        if (!gasData.success) {
          throw new Error(gasData.message || "スプレッドシートの更新に失敗しました");
        }

        // 登録メールアドレスの取得 (HPTEST1は指定のメアドをデフォルトとする)
        let currentEmail = await env.MEDI_KV.get(`${cpHId}_email`);
        if (cpHId === "HPTEST1" && !currentEmail) {
          currentEmail = "toriweb+medi@gmail.com";
        }

        // メール送信処理
        if (env.RESEND_API_KEY && currentEmail) {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.RESEND_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: "メディカニ管理 <noreply@medikani.com>",
              to: currentEmail,
              subject: "【メディカニ】パスワードが変更されましたカニ🦀",
              html: `
                <p>メディカニ管理画面のパスワードが変更されました。</p>
                <p>施設ID: <b>${cpHId}</b></p>
                <p>もしご自身で行った変更でない場合は、速やかに管理者へお問い合わせください。</p>
              `
            })
          });
        }

        return new Response(JSON.stringify({success: true}), { headers: { "Content-Type": "application/json" } });
      } catch(e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // ===== 🌟新規追加: メディカニレーダー用API (自施設採用薬との照合処理版) =====
    if (request.method === "POST" && url.pathname.includes("/api/admin/radar")) {
      try {
        const radarHId = url.searchParams.get("h") || "";
        
        // 1. GASが保存してくれた最新のPMDA改訂情報をKVから取得する
        const alertStr = await env.MEDI_KV.get("GLOBAL_PMDA_ALERT");
        if (!alertStr) {
          return new Response(JSON.stringify({ success: true, html: "<p style='color:#28a745; font-weight:bold;'>✅ 現在、レーダーが検知した新しい改訂指示情報はありませんカニ！🦀</p>" }), { headers: { "Content-Type": "application/json" } });
        }
        const alertData = JSON.parse(alertStr); // date, url, drugs が入っている
        
        // 2. 自施設の採用薬キーの一覧をKVから全部引っ張ってくる
        let adoptedKeys = [];
        let cursor = "";
        do {
          const list = await env.MEDI_KV.list({ prefix: `${radarHId}_`, limit: 1000, cursor: cursor || undefined });
          adoptedKeys.push(...list.keys.map(k => k.name));
          cursor = list.list_complete ? "" : list.cursor;
        } while (cursor);
        
        // パスワードやメタデータなどのシステム用キーを除外して純粋な採用薬だけにする
        adoptedKeys = adoptedKeys.filter(n => !n.endsWith("_meta") && !n.endsWith("_pwd") && !n.endsWith("_userpwd") && !n.endsWith("_email") && !n.endsWith("_board") && !n.endsWith("_ranking") && !n.endsWith("_name") && !n.includes("_report_") && !n.includes("COMP_"));

        // 🌟【追加】採用薬のYJコードをもとに、PMDA_DBから添付文書データをあらかじめ一括取得する
        const adoptedDrugInfos = [];
        if (env.PMDA_DB) {
          const pmdaPromises = adoptedKeys.map(async (key) => {
            const yj = key.split("_").pop();
            let cleanName = key.replace(`${radarHId}_`, "");
            if (cleanName.includes("]")) cleanName = cleanName.substring(cleanName.indexOf("]") + 1);
            if (cleanName.includes("_")) cleanName = cleanName.split("_")[0];

            let pmdaVal = "";
            if (yj && yj !== "NONE") {
              pmdaVal = await env.PMDA_DB.get(yj) || "";
              // 兄弟薬・親戚薬コードでのフォールバック（前方9桁・7桁）
              if (!pmdaVal && yj.length >= 9) {
                try {
                  const list9 = await env.PMDA_DB.list({ prefix: yj.substring(0, 9), limit: 1 });
                  if (list9.keys.length > 0) pmdaVal = await env.PMDA_DB.get(list9.keys[0].name) || "";
                } catch(e) {}
              }
              if (!pmdaVal && yj.length >= 7) {
                try {
                  const list7 = await env.PMDA_DB.list({ prefix: yj.substring(0, 7), limit: 1 });
                  if (list7.keys.length > 0) pmdaVal = await env.PMDA_DB.get(list7.keys[0].name) || "";
                } catch(e) {}
              }
            }
            return { key, cleanName, pmdaVal: String(pmdaVal) };
          });
          adoptedDrugInfos.push(...await Promise.all(pmdaPromises));
        } else {
          // PMDA_DBが無い環境用の安全対策（従来のキー名のみの判定用）
          adoptedKeys.forEach(key => {
            let cleanName = key.replace(`${radarHId}_`, "");
            if (cleanName.includes("]")) cleanName = cleanName.substring(cleanName.indexOf("]") + 1);
            if (cleanName.includes("_")) cleanName = cleanName.split("_")[0];
            adoptedDrugInfos.push({ key, cleanName, pmdaVal: "" });
          });
        }

        // 3. PMDAの対象薬リストと、自施設の採用薬を1つずつ照合してHTMLを組み立てる
        let radarHtml = `<div style="text-align:left; line-height:1.6; color:#333;">`;
        radarHtml += `<div style="font-weight:bold; margin-bottom:12px; color:#111; font-size:14px;">使用上の注意の改訂指示のお知らせ （${alertData.date || '日付不明'}）</div>`;
        radarHtml += `<div style="margin-bottom:8px; font-weight:bold; color:#555;">（対象医薬品）</div>`;

        // 🌟成分名での照合を可能にするため、マスタから「YJコード ➔ 成分名」の辞書を事前に作成
        const yjToComponentMap = {};
        try {
          for (const c of ["[内]", "[外]", "[注]"]) {
            let cursor = "";
            do {
              const list = await env.MEDI_KV.list({ prefix: c, limit: 1000, cursor: cursor || undefined });
              for (const mk of list.keys) {
                const parts = mk.name.split('_');
                const yj = parts.pop();
                const component = parts[1]; // マスタキー「[内]薬品名_成分名_YJ」の真ん中から成分名を取得
                if (yj && component) {
                  yjToComponentMap[yj] = component;
                }
              }
              cursor = list.list_complete ? "" : list.cursor;
            } while (cursor);
          }
        } catch(e) {}
        
        if (alertData.drugs && alertData.drugs.length > 0) {
          alertData.drugs.forEach((drug, index) => {
            // 例: "1. 炭酸リチウム"
            radarHtml += `<div style="margin-left:5px; margin-bottom:4px; font-weight:bold;">${index + 1}. ${drug}</div>`;
            
            // 🌟【変更】マスタの成分名、またはキー名に該当文字が含まれているものを探す
            const matchedNames = [];
            for (const info of adoptedDrugInfos) {
              // 採用薬のキーから末尾のYJコードを抜き出す
              const targetYj = info.key.split("_").pop();
              // 事前に作った辞書から、そのお薬の正確な成分名を取得する（無ければ空文字）
              const adoptedComponent = yjToComponentMap[targetYj] || "";
              
              // マスタの成分名に含まれているか、あるいは従来通り薬品名（キー）に含まれているか判定
              let isMatch = adoptedComponent.includes(drug) || info.key.includes(drug);
              
              // キー名に入っていない場合は、添付文書のデータ（JSON）を安全にチェックする
              if (!isMatch && info.pmdaVal) {
                try {
                  const pmdaObj = JSON.parse(info.pmdaVal);
                  // ⚠️誤検知の主因である「併用注意（他剤名）」や「副作用」が詰まった長文エリアを一時的に除外する
                  if (pmdaObj.warnings) delete pmdaObj.warnings;
                  
                  // 残った基本情報や効能（summaryなど）の範囲に対象薬名が含まれているかチェック
                  if (JSON.stringify(pmdaObj).includes(drug)) isMatch = true;
                } catch(e) {
                  // 万が一JSONのパースに失敗した場合は、安全のため従来の部分一致に戻す（エラー落ち防止）
                  if (info.pmdaVal.includes(drug)) isMatch = true;
                }
              }
              
              if (isMatch) {
                matchedNames.push(info.cleanName);
              }
            }
            
            // もし採用薬に存在したら、その下に【採用】として緑文字で表示する
            if (matchedNames.length > 0) {
              const uniqueNames = [...new Set(matchedNames)]; // 重複を除去
              uniqueNames.forEach(name => {
                radarHtml += `<div style="margin-left:20px; margin-bottom:8px; color:#28a745; font-weight:bold; background:#e8f5e9; padding:4px 8px; border-radius:6px; display:inline-block;">【採用】${name}</div>`;
              });
            }
          });
        }
        
        // 4. PMDAのリンクとカニのメッセージを最後に添える
        radarHtml += `<div style="margin-top:15px; border-top:1px dashed #ddd; padding-top:10px;"><a href="${alertData.url}" target="_blank" style="color:#0056b3; font-weight:bold; text-decoration:underline; word-break:break-all;">${alertData.url}</a></div>`;
        radarHtml += `<div style="margin-top:6px; font-weight:bold; color:#8e44ad;">詳細はPMDAのURLをご確認ください</div>`;
        radarHtml += `</div>`;
        
        // 組み立てたHTMLを画面に返却！
        return new Response(JSON.stringify({ success: true, html: radarHtml }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }
   
    // === 🔥修正: ユーザーパスワード設定のエラーデバッグ用強化アーマー ===
    if (request.method === "POST" && url.pathname.includes("/api/admin/changeuserpwd")) {
      try {
        const cpBody = await request.json();
        const cpHId = url.searchParams.get("h") || "";
        const newUserPwd = cpBody.newUserPwd || "";
        
        // KVへは必ず保存する
        if (newUserPwd === "") {
            await env.MEDI_KV.delete(`${cpHId}_userpwd`);
        } else {
            await env.MEDI_KV.put(`${cpHId}_userpwd`, newUserPwd);
        }

        if (env.GAS_URL) {
          const gasRes = await fetch(env.GAS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              facilityId: cpHId,
              newUserPassword: newUserPwd
            })
          });
          
          // 🔥 一度テキストとして受け取って、GASが何を返してきたのか暴く
          const rawText = await gasRes.text();
          let gasData;
          try {
            gasData = JSON.parse(rawText);
          } catch(parseErr) {
            // もしGASからHTML（エラー画面）が返ってきていたら、その中身をエラーとして投げる
            throw new Error(`GASがJSON以外を返しました: ${rawText.substring(0, 150)}...`);
          }
          
          if (!gasData.success) {
            throw new Error(gasData.message || "スプレッドシートの更新に失敗しました");
          }
        }

        return new Response(JSON.stringify({success: true}), { headers: { "Content-Type": "application/json" } });
      } catch(e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // メールアドレス変更 (管理画面内から) 【新旧両方へ通知追加】
    if (request.method === "POST" && url.pathname.includes("/api/admin/changemail")) {
      try {
        const cmBody = await request.json();
        const cmHId = url.searchParams.get("h") || "";
        const newEmail = cmBody.newEmail;

        let oldEmail = await env.MEDI_KV.get(`${cmHId}_email`);
        if (cmHId === "HPTEST1" && !oldEmail) oldEmail = "toriweb+medi@gmail.com";

        await env.MEDI_KV.put(`${cmHId}_email`, newEmail);

        // 新旧アドレスへメール通知
        if (env.RESEND_API_KEY) {
          const emailPromises = [];
          const subject = "【メディカニ】登録メールアドレスが変更されましたカニ🦀";
          const htmlContent = `
            <p>メディカニ管理画面の登録メールアドレスが変更されました。</p>
            <p>施設ID: <b>${cmHId}</b><br>
            新しいメールアドレス: <b>${newEmail}</b></p>
            <p>もしご自身で行った変更でない場合は、速やかに管理者へお問い合わせください。</p>
          `;

          // 旧アドレスへ送信
          if (oldEmail) {
            emailPromises.push(fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ from: "メディカニ管理 <noreply@medikani.com>", to: oldEmail, subject: subject, html: htmlContent })
            }));
          }

          // 新アドレスへ送信 (旧アドレスと同じでない場合のみ)
          if (newEmail && newEmail !== oldEmail) {
            emailPromises.push(fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ from: "メディカニ管理 <noreply@medikani.com>", to: newEmail, subject: subject, html: htmlContent })
            }));
          }

          await Promise.all(emailPromises).catch(e => console.log("Mail send error", e));
        }

        return new Response(JSON.stringify({success: true}), { headers: { "Content-Type": "application/json" } });
      } catch(e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // パスワードリセット (メールアドレスで仮パスワード発行に変更)
    if (request.method === "POST" && isAdminResetApi) {
      try {
        const body = await request.json();
        const rHId = body.hId;
        const rEmail = (body.email || "").trim();

        if (!rHId || !rEmail) return new Response(JSON.stringify({success: false, error: "メールアドレスを入力してください"}), { headers: { "Content-Type": "application/json" } });

        // 登録メールアドレスの取得 (HPTEST1は指定のメアドをデフォルトとする)
        let expectedEmail = await env.MEDI_KV.get(`${rHId}_email`);
        if (rHId === "HPTEST1" && !expectedEmail) {
          expectedEmail = "toriweb+medi@gmail.com";
        }

        if (!expectedEmail) {
          return new Response(JSON.stringify({success: false, error: "この施設IDにはメールアドレスが登録されていません"}), { headers: { "Content-Type": "application/json" } });
        }

        if (rEmail !== expectedEmail) {
          return new Response(JSON.stringify({success: false, error: "登録されているメールアドレスと一致しません"}), { headers: { "Content-Type": "application/json" } });
        }

        // 仮パスワードの生成 (8桁のランダムな英数字)
        const tempPwd = Math.random().toString(36).slice(-8);
        await env.MEDI_KV.put(`${rHId}_pwd`, tempPwd);

        // ※実際のメール送信処理 (外部APIを利用)
        if (env.RESEND_API_KEY) {
          const emailRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.RESEND_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: "メディカニ管理 <noreply@medikani.com>", // ※必要に応じてResendで認証したドメインに変更してください
              to: rEmail,
              subject: "【メディカニ】仮パスワードが発行されましたカニ🦀",
              html: `
                <p>メディカニ管理画面のパスワードリセットを受け付けました。</p>
                <p>施設ID: <b>${rHId}</b><br>
                仮パスワード: <b style="font-size:20px; background:#eee; padding:5px 10px; border-radius:5px; letter-spacing:2px;">${tempPwd}</b></p>
                <p>ログイン後、管理画面の「個別編集」の下にある「パスワード変更」から、必ず新しいパスワードに変更してください。</p>
                <hr>
                <p style="font-size:12px; color:#888;">※このメールに心当たりがない場合は破棄してください。</p>
              `
            })
          });

          if (!emailRes.ok) {
            const errData = await emailRes.text();
            throw new Error("メール送信に失敗しました: " + errData);
          }

          return new Response(JSON.stringify({success: true, simulated: false}), { headers: { "Content-Type": "application/json" } });
        } else {
          // テスト用: メール送信APIがない場合は特別に画面に仮パスワードを返す
          return new Response(JSON.stringify({success: true, simulated: true, tempPwd: tempPwd}), { headers: { "Content-Type": "application/json" } });
        }
      } catch(e) {
        return new Response(JSON.stringify({error: e.message}), { status: 500 });
      }
    }
    // === 新規追加: CSVアップロード等の POST API (ここまで) ===

    // GET以外のリクエストは弾く
    return new Response("Not Found", { status: 404 });
  },

  // === 新規追加: 認証ロジックヘルパー (ここから) ===
  async checkAuth(request, env, hId) {
    if (!hId) return false;
    
    // KVからパスワードを取得（未設定なら、HPTEST1は'12345'、その他は施設IDそのものを初期パスワードにする）
    let pwd = await env.MEDI_KV.get(`${hId}_pwd`);
    if (!pwd) pwd = (hId === 'HPTEST1') ? '12345' : hId;

    // Cookieベースの認証チェックを追加
    const cookieString = request.headers.get("Cookie");
    if (cookieString) {
      const cookies = cookieString.split(';').map(c => c.trim());
      const targetCookie = `medikani_auth_${hId}=`;
      const authCookie = cookies.find(c => c.startsWith(targetCookie));
      if (authCookie) {
        const cookiePwd = decodeURIComponent(authCookie.substring(targetCookie.length));
        if (cookiePwd === pwd) return true;
      }
    }

    // Basic認証のチェック (外部API用・後方互換として残す)
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return false;
    const match = authHeader.match(/^Basic\s+(.*)$/i);
    if (!match) return false;
    
    try {
      const decoded = atob(match[1]);
      const index = decoded.indexOf(':');
      if (index === -1) return false;
      const user = decoded.substring(0, index);
      const p = decoded.substring(index + 1);
      return user === hId && p === pwd;
    } catch(e) {
      return false;
    }
  },

  getAuthFailedHTML(hId) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>認証が必要です</title>
    <link rel="icon" type="image/png" sizes="512x512" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
    <link rel="apple-touch-icon" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
    <style>body{font-family:sans-serif;background:#f4f7f6;text-align:center;padding:50px 20px;}
    .box{background:#fff;padding:30px;border-radius:15px;box-shadow:0 4px 15px rgba(0,0,0,0.1);max-width:400px;margin:0 auto;}
    .btn{display:inline-block;margin-top:20px;padding:12px 20px;background:#0056b3;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;transition:transform 0.1s;}
    .btn:active{transform:scale(0.98);}
    </style></head><body>
    <div class="box">
      <h2 style="color:#dc3545;margin-top:0;">🔒 認証に失敗しましたカニ🦀</h2>
      <p style="color:#555;font-size:14px;line-height:1.6;">管理画面にアクセスするには正しいユーザー名とパスワードが必要です。<br><br>ユーザー名: <b style="background:#eee;padding:4px 8px;border-radius:4px;">${hId}</b></p>
      <hr style="border:none;border-top:1px dashed #ccc;margin:25px 0;">
      <p style="font-size:13px;color:#888;">パスワードを忘れてしまった場合は、以下のボタンから再設定（仮パスワード発行）の手続きへ進んでくださいカニ🦀</p>
      <a href="/${hId}/admin/reset" class="btn">🔑 パスワードを再発行する</a>
    </div>
    </body></html>`;
  },

  getLoginHTML(env, hId, hName = "") {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>ログイン - メディカニ</title>
    <link rel="icon" type="image/png" sizes="512x512" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
    <link rel="apple-touch-icon" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
    <style>
      :root { --main-blue: #0056b3; --bg: #f4f7f6; }
      body { font-family: sans-serif; background: var(--bg); margin: 0; padding: 20px; color: #333; display:flex; justify-content:center; }
      .card { background: #fff; border-radius: 12px; padding: 25px; box-shadow: 0 4px 10px rgba(0,0,0,0.05); max-width: 400px; width:100%; }
      h2 { margin-top: 0; color: var(--main-blue); font-size:18px; border-bottom: 2px solid #eee; padding-bottom:10px; }
      label { font-size: 13px; font-weight: bold; color: #555; display:block; margin-top:15px; margin-bottom:5px; }
      input { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 8px; box-sizing: border-box; font-size: 14px; outline:none; }
      input:focus { border-color: var(--main-blue); }
      .btn { width: 100%; padding: 14px; background: var(--main-blue); color: #fff; font-size: 16px; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; margin-top: 25px; transition:transform 0.1s; }
      .btn:active { transform:scale(0.98); }
      #msg { margin-top: 15px; font-size: 14px; font-weight: bold; text-align: center; line-height:1.5; color: #dc3545; }
    </style>
    </head><body>
    <div class="card">
      <h2>🔒 ログイン</h2>
      <p style="font-size:12px; color:#666; line-height:1.6; background:#e3f2fd; padding:10px; border-radius:8px;">
        管理画面にアクセスするためのパスワードを入力してくださいカニ🦀
      </p>
      
      <label>🏥 施設ID</label>
      <input type="text" id="hId" value="${hId}${hName ? ` (${hName})` : ''}" readonly style="background:#f0f0f0; color:#777;">
      
      <label>🔑 パスワード</label>
      <input type="password" id="pwd" placeholder="パスワードを入力" onkeydown="if(event.key==='Enter') document.getElementById('btnLogin').click()">

      <button class="btn" id="btnLogin">🚪 ログインする</button>
      <div id="msg"></div>
      
      <div style="text-align:center; margin-top:20px;">
        <a href="/${hId}/admin/reset" style="font-size:13px; color:#888; text-decoration:none;">パスワードを忘れた場合はこちら</a>
      </div>
      <div style="text-align:center; margin-top:15px;">
        <a href="/${hId}" style="font-size:13px; color:var(--main-blue); text-decoration:none; font-weight:bold;">🔙 検索画面に戻る</a>
      </div>
    </div>
    <script>
      document.getElementById('btnLogin').addEventListener('click', async () => {
        const pwd = document.getElementById('pwd').value.trim();
        const msg = document.getElementById('msg');
        
        if(!pwd) { msg.innerText = "⚠️ パスワードを入力してくださいカニ🦀"; return; }
        
        msg.innerText = "⏳ 認証中...💦"; msg.style.color = "#555";
        
        try {
          const res = await fetch('/api/admin/login', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ hId: "${hId}", pwd: pwd })
          });
          const data = await res.json();
          if(data.success) {
            window.location.href = "/${hId}/admin";
          } else {
            msg.innerText = "❌ " + data.error;
            msg.style.color = "#dc3545";
          }
        } catch(e) {
          msg.innerText = "⚠️ 通信エラーが発生しましたカニ🦀"; msg.style.color = "#dc3545";
        }
      });
    </script>
    </body></html>`;
  },

  getUserLoginHTML(hId, hName = "") {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>スタッフログイン - メディカニ</title>
    <link rel="icon" type="image/png" sizes="512x512" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
    <link rel="apple-touch-icon" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
    <style>
      :root { --main-blue: #6f42c1; --bg: #f4f7f6; }
      body { font-family: sans-serif; background: var(--bg); margin: 0; padding: 20px; color: #333; display:flex; justify-content:center; }
      .card { background: #fff; border-radius: 12px; padding: 25px; box-shadow: 0 4px 10px rgba(0,0,0,0.05); max-width: 400px; width:100%; }
      h2 { margin-top: 0; color: var(--main-blue); font-size:18px; border-bottom: 2px solid #eee; padding-bottom:10px; }
      label { font-size: 13px; font-weight: bold; color: #555; display:block; margin-top:15px; margin-bottom:5px; }
      input { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 8px; box-sizing: border-box; font-size: 14px; outline:none; }
      input:focus { border-color: var(--main-blue); }
      .btn { width: 100%; padding: 14px; background: var(--main-blue); color: #fff; font-size: 16px; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; margin-top: 25px; transition:transform 0.1s; }
      .btn:active { transform:scale(0.98); }
      #msg { margin-top: 15px; font-size: 14px; font-weight: bold; text-align: center; line-height:1.5; color: #dc3545; }
    </style>
    </head><body>
    <div class="card">
      <h2>🔐 スタッフ用ログイン</h2>
      <p style="font-size:12px; color:#666; line-height:1.6; background:#f8f0ff; padding:10px; border-radius:8px;">
        メディカニを利用するためのパスワードを入力してくださいカニ🦀<br>（※初回のみ必要です）
      </p>
      
      <label>🏥 施設</label>
      <input type="text" id="hId" value="${hId}${hName ? ` (${hName})` : ''}" readonly style="background:#f0f0f0; color:#777;">
      
      <label>🔑 パスワード</label>
      <input type="password" id="pwd" placeholder="パスワードを入力" onkeydown="if(event.key==='Enter') document.getElementById('btnLogin').click()">

      <button class="btn" id="btnLogin">🚪 利用を開始する</button>
      <div id="msg"></div>
    </div>
    <script>
      document.getElementById('btnLogin').addEventListener('click', async () => {
        const pwd = document.getElementById('pwd').value.trim();
        const msg = document.getElementById('msg');
        
        if(!pwd) { msg.innerText = "⚠️ パスワードを入力してくださいカニ🦀"; return; }
        
        msg.innerText = "⏳ 確認中...💦"; msg.style.color = "#555";
        
        try {
          const res = await fetch('/api/userlogin', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ hId: "${hId}", pwd: pwd })
          });
          const data = await res.json();
          if(data.success) {
            window.location.href = "/${hId}";
          } else {
            msg.innerText = "❌ " + data.error;
            msg.style.color = "#dc3545";
          }
        } catch(e) {
          msg.innerText = "⚠️ 通信エラーが発生しましたカニ🦀"; msg.style.color = "#dc3545";
        }
      });
    </script>
    </body></html>`;
  },

  getResetHTML(env, hId, hName = "") {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>パスワード再発行 - メディカニ</title>
    <link rel="icon" type="image/png" sizes="512x512" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
    <link rel="apple-touch-icon" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
    <style>
      :root { --main-blue: #0056b3; --bg: #f4f7f6; }
      body { font-family: sans-serif; background: var(--bg); margin: 0; padding: 20px; color: #333; display:flex; justify-content:center; }
      .card { background: #fff; border-radius: 12px; padding: 25px; box-shadow: 0 4px 10px rgba(0,0,0,0.05); max-width: 400px; width:100%; }
      h2 { margin-top: 0; color: var(--main-blue); font-size:18px; border-bottom: 2px solid #eee; padding-bottom:10px; }
      label { font-size: 13px; font-weight: bold; color: #555; display:block; margin-top:15px; margin-bottom:5px; }
      input { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 8px; box-sizing: border-box; font-size: 14px; outline:none; }
      input:focus { border-color: var(--main-blue); }
      .btn { width: 100%; padding: 14px; background: #ff9d00; color: #fff; font-size: 16px; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; margin-top: 25px; transition:transform 0.1s; }
      .btn:active { transform:scale(0.98); }
      #msg { margin-top: 15px; font-size: 14px; font-weight: bold; text-align: center; line-height:1.5; }
    </style>
    </head><body>
    <div class="card">
      <h2>🔑 パスワード再発行</h2>
      <p style="font-size:12px; color:#666; line-height:1.6; background:#e3f2fd; padding:10px; border-radius:8px;">
        登録されているメールアドレスを入力してください。新しい仮パスワードを発行しますカニ🦀
      </p>
      
      <label>🏥 施設ID</label>
      <input type="text" id="hId" value="${hId}${hName ? ` (${hName})` : ''}" readonly style="background:#f0f0f0; color:#777;">
      
      <label>✉️ メールアドレス</label>
      <input type="email" id="email" placeholder="登録メールアドレスを入力">

      <button class="btn" id="btnReset">✉️ 仮パスワードを発行する</button>
      <div id="msg"></div>
      
      <div style="text-align:center; margin-top:20px;">
        <a href="/${hId}/admin" style="font-size:13px; color:var(--main-blue); text-decoration:none; font-weight:bold;">🔙 ログイン画面に戻る</a>
      </div>
    </div>
    <script>
      document.getElementById('btnReset').addEventListener('click', async () => {
        const email = document.getElementById('email').value.trim();
        const msg = document.getElementById('msg');
        
        if(!email) { msg.innerText = "⚠️ メールアドレスを入力してくださいカニ🦀"; msg.style.color = "#dc3545"; return; }
        
        msg.innerText = "⏳ 確認中...💦"; msg.style.color = "#555";
        
        try {
          const res = await fetch('/api/admin/reset', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ hId: "${hId}", email: email })
          });
          const data = await res.json();
          if(data.success) {
            if (data.simulated) {
              msg.innerHTML = \`✅ メールアドレスが確認できましたカニ！🦀<br><span style="color:#d63384;font-size:12px;">※現在メール送信APIが未設定のため、テスト動作として画面上に仮パスワードを表示します。</span><br><br>仮パスワード: <b style="font-size:20px;background:#eee;padding:6px 12px;border-radius:6px;letter-spacing:2px;color:#333;">\${data.tempPwd}</b><br><br><a href='/\${hId}/admin' style='display:inline-block;padding:8px 15px;background:#0056b3;color:#fff;border-radius:6px;text-decoration:none;'>管理画面へ進む</a>\`;
            } else {
              msg.innerHTML = \`✅ 入力されたメールアドレスに仮パスワードを送信しましたカニ！🦀<br>メールを確認してログインしてください。<br><a href='/\${hId}/admin' style='display:inline-block;margin-top:12px;padding:8px 15px;background:#0056b3;color:#fff;border-radius:6px;text-decoration:none;'>管理画面へ進む</a>\`;
            }
            msg.style.color = "#28a745";
          } else {
            msg.innerText = "❌ " + data.error;
            msg.style.color = "#dc3545";
          }
        } catch(e) {
          msg.innerText = "⚠️ 通信エラーが発生しましたカニ🦀"; msg.style.color = "#dc3545";
        }
      });
    </script>
    </body></html>`;
  },
  // === 新規追加: 認証ロジックヘルパー (ここまで) ===

  async askAI(drugName, apiKey) {
    if (!apiKey) return "AIキーが設定されていませんカニ🦀";
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ 
          model: "gpt-4o-mini", 
          messages: [
            { 
              role: "system", 
              content: "あなたは経験20年の凄腕薬剤師『メディカニくん』です。ユーザーの入力（不完全な名称やひらがなを含む）から、最も可能性の高い具体的な市販薬を推測・特定してください。回答の冒頭には必ず『薬品名：確定した製品名（例：アレグラFX）』を記載し、以下の形式で回答してください。\n\n主成分：\n特徴：\n切替候補：\n\n※「切替候補」には、その市販薬の最も主要な『主成分名（成分名、例：フェキソフェナジン塩酸塩）』を1つだけ、括弧や補足なしで記載してください（製品名ではなく成分名を出力してください）成分名は重要なのでプロとして真剣に選んで間違えないで下さい。\n最後に改行して『※AIによる参考情報ですカニ🦀 詳細は最新の添付文書を確認してください。』と必ず記載すること。全体で150文字以内で。"
            }, 
            { role: "user", content: drugName }
          ], 
          max_tokens: 200 
        })
      });
      const d = await res.json();
      return d.choices?.[0]?.message?.content || "情報を取得できませんでしたカニ🦀";
    } catch (e) { return "通信エラーが発生しましたカニ🦀"; }
  },

  async handleWebSearch(query, category, hospitalId, env) {
    let normalizedQuery = query.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).trim();
    
    // 入力が「ツムラ〇〇」や「〇〇(数字のみ)」かどうかをチェック
    let tsumuraMatch = normalizedQuery.match(/^(?:ツムラ|つむら)?\s*([0-9]{1,3})$/);
    
    // 番号検索以外で1文字以下の場合はここで弾く
    if (!tsumuraMatch && (!query || query.length < 2)) return [];
    
    let hiraQuery = hiraToKata(query);

    // トリさんが作ってくれた辞書データ（YJコード直結版）
    const TSUMURA_MAP = {
      "1": "5200013D1123", "2": "5200015D1084", "3": "5200012D1080", "5": "5200001D1066",
      "6": "5200070D1105", "7": "5200121D1045", "8": "5200093D1092", "9": "5200073D1117",
      "10": "5200051D1080", "11": "5200052D1034", "12": "5200050D1094", "14": "5200123D1079",
      "15": "5200011D1078", "16": "5200122D1074", "17": "5200048D1070", "18": "5200034D1044",
      "19": "5200075D1086", "20": "5200129D1076", "21": "5200076D1030", "22": "5200077D1034",
      "23": "5200111D1076", "24": "5200017D1083", "25": "5200038D1093", "26": "5200035D1030",
      "27": "5200132D1035", "28": "5200007D1047", "29": "5200119D1030", "30": "5200083D1030",
      "31": "5200046D1039", "32": "5200116D1060", "33": "5200091D1026", "34": "5200125D1035",
      "35": "5200061D1025", "36": "5200137D1020", "37": "5200124D1022", "38": "5200110D1047",
      "39": "5200145D1059", "40": "5200103D1101", "41": "5200131D1065", "43": "5200141D1034",
      "45": "5200028D1049", "46": "5200064D1045", "47": "5200101D1030", "48": "5200069D1048",
      "50": "5200027D1052", "51": "5200071D1037", "52": "5200138D1059", "53": "5200089D1045",
      "54": "5200139D1037", "55": "5200134D1042", "56": "5200047D1025", "57": "5200006D1042",
      "58": "5200084D1034", "59": "5200099D1022", "60": "5200032D1045", "61": "5200106D1059",
      "62": "5200130D1060", "63": "5200045D1034", "64": "5200066D1036", "65": "5200022D1033",
      "66": "5200081D1030", "67": "5200115D1023", "68": "5200067D1049", "69": "5200126D1021",
      "70": "5200043D1027", "71": "5200065D1031", "72": "5200019D1031", "73": "5200049D1032",
      "74": "5200100D1027", "75": "5200062D1020", "76": "5200142D1047", "77": "5200023D1020",
      "78": "5200135D1047", "79": "5200128D1047", "80": "5200053D1020", "81": "5200114D1029",
      "82": "5200037D1021", "83": "5200140D1021", "84": "5200090D1030", "85": "5200082D1043",
      "86": "5200108D1023", "87": "5200146D1029", "88": "5200113D1024", "89": "5200098D1028",
      "90": "5200087D1020", "91": "5200097D1023", "92": "5200060D1020", "93": "5200059D1036",
      "95": "5200044D1030", "96": "5200054D1033", "97": "5200096D1029", "98": "5200008D1025",
      "99": "5200072D1058", "100": "5200092D1020", "101": "5200078D1020", "102": "5200107D1029",
      "103": "5200056D1032", "104": "5200080D1044", "105": "5200105D1038", "106": "5200005D1030",
      "107": "5200025D1029", "108": "5200117D1030", "109": "5200074D1022", "110": "5200149D1022",
      "111": "5200086D1033", "112": "5200104D1025", "113": "5200057D1070", "114": "5200055D1020",
      "115": "5200002D1036", "116": "5200127D1026", "117": "5200004D1035", "118": "5200144D1020",
      "119": "5200143D1025", "120": "5200010D1030", "121": "5200058D1023", "122": "5200118D1027",
      "123": "5200109D1028", "124": "5200088D1032", "125": "5200039D1039", "126": "5200136D1033",
      "127": "5200133D1021", "128": "5200041D1028", "133": "5200095D1024", "134": "5200033D1023",
      "135": "5200003D1049", "136": "5200085D1020", "137": "5200016D1054", "138": "5200020D1026"
    };

    // 入力された番号が辞書にあれば、検索ワードを「YJコード」にすり替える
    if (tsumuraMatch) {
      const num = tsumuraMatch[1];
      if (TSUMURA_MAP[num]) {
        hiraQuery = TSUMURA_MAP[num];
      }
    }
    // ===== 🌟ここまで追加 =====
    
    // --- ハイブリッド検索 ---
    let masterKeys = [];
    let adoptedKeys = [];

    // 🌟 categoryが"all"や"[一般名]"の場合は全カテゴリを検索
    const cats = (category === "all" || category === "[一般名]") ? ["[内]", "[外]", "[注]"] : [category];

    for (const c of cats) {
      // （※ここのKVからリストを取得する mCursor と aCursor の whileループ処理 はそのまま残してください！）
      let mCursor = "";
      do {
        const list = await env.MEDI_KV.list({ prefix: c, limit: 1000, cursor: mCursor || undefined });
        masterKeys.push(...list.keys.map(k => k.name));
        mCursor = list.list_complete ? "" : list.cursor;
      } while (mCursor);

      if (hospitalId) {
        let aCursor = "";
        do {
          const list = await env.MEDI_KV.list({ prefix: `${hospitalId}_${c}`, limit: 1000, cursor: aCursor || undefined });
          adoptedKeys.push(...list.keys.map(k => k.name));
          aCursor = list.list_complete ? "" : list.cursor;
        } while (aCursor);
      }
    }

    // ===== 🌟修正: 「一般名」タブか「通常」タブかで検索対象を切り替える =====
    // 薬品名部分を取り出す（例: ID_[内]薬品名_成分名_YJ -> [内]薬品名）
    const getDrugNamePart = (key) => key.split('_').find(p => p.includes('[')) || key;
    
    // 成分名部分を取り出す（YJコードの1つ前の要素）
    const getComponentPart = (key) => {
      const parts = key.split('_');
      return parts.length > 2 ? parts[parts.length - 2] : ""; 
    };

    let matchedMaster, matchedAdopted;
    // 🌟追加: ツムラ番号で検索され、ワードがYJコードに置き換わっているか判定
    const isTsumuraYj = tsumuraMatch && TSUMURA_MAP[tsumuraMatch[1]];

    if (category === "[一般名]") {
      // 🧬 一般名タブ：成分名で検索する
      const compPrefixSort = (a, b) => {
        const aIsPrefix = getComponentPart(a).startsWith(hiraQuery) ? 1 : 0;
        const bIsPrefix = getComponentPart(b).startsWith(hiraQuery) ? 1 : 0;
        return bIsPrefix - aIsPrefix;
      };
      // 🌟修正: ツムラYJコードの場合は成分名ではなくキー全体（YJ部分）で検索させる
      matchedMaster = masterKeys.filter(k => isTsumuraYj ? k.includes(hiraQuery) : getComponentPart(k).includes(hiraQuery)).sort(compPrefixSort);
      matchedAdopted = adoptedKeys.filter(k => isTsumuraYj ? k.includes(hiraQuery) : getComponentPart(k).includes(hiraQuery)).sort(compPrefixSort);
    } else {
      // 💊 通常タブ：薬品名で検索する
      const prefixSort = (a, b) => {
        const aIsPrefix = getDrugNamePart(a).includes(']' + hiraQuery) ? 1 : 0;
        const bIsPrefix = getDrugNamePart(b).includes(']' + hiraQuery) ? 1 : 0;
        return bIsPrefix - aIsPrefix;
      };
      // 🌟修正: ツムラYJコードの場合は薬品名ではなくキー全体（YJ部分）で検索させる
      matchedMaster = masterKeys.filter(k => isTsumuraYj ? k.includes(hiraQuery) : getDrugNamePart(k).includes(hiraQuery)).sort(prefixSort);
      matchedAdopted = adoptedKeys.filter(k => isTsumuraYj ? k.includes(hiraQuery) : getDrugNamePart(k).includes(hiraQuery)).sort(prefixSort);
    }
    // ==========================================================

    let finalKeys = [];
    if (hospitalId) {
      const adoptedYJs = new Set(matchedAdopted.map(k => k.split("_").pop()));
      const filteredMaster = matchedMaster.filter(k => !adoptedYJs.has(k.split("_").pop()));
      // "all"や"一般名"の場合は該当が多いので多め（100件）に返す
      finalKeys = [...matchedAdopted, ...filteredMaster].slice(0, (category === "all" || category === "[一般名]") ? 100 : 30);
    } else {
      finalKeys = matchedMaster.slice(0, (category === "all" || category === "[一般名]") ? 100 : 30);
    }

    const results = await Promise.all(finalKeys.map(async (key) => {
      const val = await env.MEDI_KV.get(key);
      if (!val) return null;
      let parts = String(val).split(/[,\uFF0C]/);
      const yj = getBestYJ(key, parts);
      const isAdopted = hospitalId ? key.startsWith(`${hospitalId}_`) : false;
      
      if (isAdopted) {
        const yjIndex = parts.findIndex(p => p.replace(/[^a-zA-Z0-9]/g, "") === yj);
        if (yjIndex !== -1 && yjIndex < parts.length - 1) {
          parts = parts.slice(0, yjIndex + 1);
        }
  
// ===== 🌟修正: 表示時のみマスタの情報で丸ごと上書きしてマークを復活させる =====
        if (yj && yj !== "NONE") {
          const masterKey = masterKeys.find(k => k.endsWith(`_${yj}`) || k.endsWith(yj));
          if (masterKey) {
            const mVal = await env.MEDI_KV.get(masterKey);
            if (mVal) {
              const mParts = String(mVal).split(/[,\uFF0C]/);
              const mYjIdx = mParts.findIndex(p => p.replace(/[^a-zA-Z0-9]/g, "") === yj);
              if (mYjIdx !== -1) {
                // マスタのYJコードまでの全情報（薬価や先発マーク等含む）をコピー
                parts = mParts.slice(0, mYjIdx + 1);
              }
            }
          }
        }
      }

      const extracted = extractDrugData(parts, yj);
      const isBrand = parts.some(p => String(p).includes("先発"));
      const cleanType = extracted.type.replace(/先発品?/g, "");
      // 👇追加: keyから成分名を取り出す（上部で定義済みの getComponentPart を利用）
      const compName = getComponentPart(key);
      
      // 👇修正: component: compName を結果の最後に追加
      return { key, name: extracted.name, spec: extracted.spec, type: cleanType, yj: yj, isAdopted: isAdopted, isBrand: isBrand, price: extracted.price, component: compName };
    }));
    
    // ===== 🌟修正: 採用薬を優先しつつ、前方一致をさらに優先して並び替え =====
    return results.filter(r => r !== null).sort((a, b) => {
      // 1. まずは採用薬かどうかで分ける（採用薬が上）
      if (b.isAdopted !== a.isAdopted) return b.isAdopted - a.isAdopted;
      // 2. 採用状況が同じなら、前方一致を上にする（ここでも薬品名部分だけを見るように統一）
      const aIsPrefix = getDrugNamePart(a.key).includes(']' + hiraQuery) ? 1 : 0;
      const bIsPrefix = getDrugNamePart(b.key).includes(']' + hiraQuery) ? 1 : 0;
      return bIsPrefix - aIsPrefix;
    });
    // ==========================================================
  },

  async handleWebDetail(kvKey, hospitalId, env) {
    const val = await env.MEDI_KV.get(kvKey);
    if (!val) return null;
    let parts = String(val).split(/[,\uFF0C]/);
    const labelMatch = kvKey.match(/\[(内|注|外)\]/);
    const label = labelMatch ? labelMatch[0] : "[内]";
    const yj = getBestYJ(kvKey, parts);
    const isAdopted = hospitalId ? kvKey.startsWith(`${hospitalId}_`) : false;
    let comment = "";

    // ===== 追加: 代替薬検索用のマスタ取得を前倒しして名前取得に利用 =====
    let cursor = "";
    let masterCategoryKeys = [];
    do {
      const list = await env.MEDI_KV.list({ prefix: label, limit: 1000, cursor: cursor || undefined });
      masterCategoryKeys.push(...list.keys.map(k => k.name));
      cursor = list.list_complete ? "" : list.cursor;
    } while (cursor);
    // ==================================================================

    if (isAdopted) {
      const yjIndex = parts.findIndex(p => p.replace(/[^a-zA-Z0-9]/g, "") === yj);
      if (yjIndex !== -1 && yjIndex < parts.length - 1) {
        comment = parts.slice(yjIndex + 1).join(",").trim();
        parts = parts.slice(0, yjIndex + 1);
      }
      // ===== 追加: 表示時のみマスタの薬品名と規格に差し替える =====
      // ===== 🌟修正: 詳細画面でもマスタの情報で丸ごと上書きしてマークを復活させる =====
          if (yj && yj !== "NONE") {
            const masterKey = masterCategoryKeys.find(k => k.endsWith(`_${yj}`) || k.endsWith(yj));
            if (masterKey) {
              const mVal = await env.MEDI_KV.get(masterKey);
              if (mVal) {
                const mParts = String(mVal).split(/[,\uFF0C]/);
                const mYjIdx = mParts.findIndex(p => p.replace(/[^a-zA-Z0-9]/g, "") === yj);
                if (mYjIdx !== -1) {
                  // マスタのYJコードまでの全情報（薬価や先発、麻薬マーク等含む）をコピー
                  parts = mParts.slice(0, mYjIdx + 1);
                }
              }
            }
          }
         // ==============================================================
    }
// ===== 🌟修正: 抽出関数を使ってカンマズレを防止 =====
    const extracted = extractDrugData(parts, yj);
    const price = extracted.price; // これで詳細画面に薬価が渡せるようになります！
    const isBrand = parts.some(p => String(p).includes("先発"));
    const fullName = `${extracted.name} ${extracted.spec} ${extracted.type.replace(/先発品?/g, "")}`.replace(/\s+/g, ' ').trim();
    const yj7 = (yj && yj !== "NONE") ? yj.substring(0, 7) : null;
    let alts = [];
    if (yj7) {
      // 変更: 上で取得済みの masterCategoryKeys をコピーして使い回す（無駄な通信削減）
      let allCategoryKeys = [...masterCategoryKeys];
      
      if (hospitalId) {
        let aCursor = "";
        do {
          const list = await env.MEDI_KV.list({ prefix: `${hospitalId}_${label}`, limit: 1000, cursor: aCursor || undefined });
          allCategoryKeys.push(...list.keys.map(k => k.name));
          aCursor = list.list_complete ? "" : list.cursor;
        } while (aCursor);
      }
 const keysToFetch = allCategoryKeys.filter(k => {
        if (k === kvKey) return false;
        if (yj7 && k.includes(yj7)) return true;
        return false;
      });
      const uniqueKeysToFetch = [];
      const seenYJs = new Set();
      for (const k of keysToFetch.filter(k => hospitalId && k.startsWith(`${hospitalId}_`))) {
        uniqueKeysToFetch.push(k);
        // 変更：末尾のYJコードを登録
        seenYJs.add(k.split("_").pop());
      }
      for (const k of keysToFetch.filter(k => !(hospitalId && k.startsWith(`${hospitalId}_`)))) {
        // 変更：末尾のYJコードで重複チェック
        if (!seenYJs.has(k.split("_").pop())) uniqueKeysToFetch.push(k);
      }
      const altPromises = uniqueKeysToFetch.slice(0, 50).map(async (k) => {
        const v = await env.MEDI_KV.get(k);
        if (!v) return null;
        let p = String(v).split(/[,\uFF0C]/);
        const ayj = getBestYJ(k, p);
        const aIsAdopted = hospitalId ? k.startsWith(`${hospitalId}_`) : false;
if (aIsAdopted) {
  const ayjIndex = p.findIndex(x => x.replace(/[^a-zA-Z0-9]/g, "") === ayj);
  if (ayjIndex !== -1 && ayjIndex < p.length - 1) { p = p.slice(0, ayjIndex + 1); }
  // ===== 🌟追加: 切替候補の採用薬でもマスタの薬品名と規格と薬価に差し替える =====
if (ayj && ayj !== "NONE") {
    const masterKey = masterCategoryKeys.find(mk => mk.endsWith(`_${ayj}`) || mk.endsWith(ayj));
    if (masterKey) {
      const mVal = await env.MEDI_KV.get(masterKey);
      if (mVal) {
        const mP = String(mVal).split(/[,\uFF0C]/);
        const mYjIdx = mP.findIndex(x => x.replace(/[^a-zA-Z0-9]/g, "") === ayj);
        if (mYjIdx !== -1) {
          p = mP.slice(0, mYjIdx + 1); // 先発マークなども全て補完！
        }
      }
    }
  }
  // ==============================================================
}
if (ayj && ayj.substring(0, 7) === yj7) {
          // ===== 🌟修正: 切替候補でも抽出関数を使ってカンマズレを防止 =====
          const extAlt = extractDrugData(p, ayj);
          const aIsBrand = p.some(x => String(x).includes("先発"));
          
          return { key: k, name: extAlt.name, spec: extAlt.spec, yj: ayj, isAdopted: aIsAdopted, isBrand: aIsBrand, price: extAlt.price };
        }
        return null;
      });
      alts = (await Promise.all(altPromises)).filter(a => a !== null);
      const seen = new Set();
      alts = alts.filter(a => {
        const id = `${a.name}-${a.spec}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }).slice(0, 15);
    }

    // ===== 🌟追加: 先ほど作ったPMDA辞書(KV)から、効能と用法をサクッと取得する =====
    let pmdaEfficacy = "";
    let pmdaUsage = "";
    let pmdaContra = ""; // 🌟追加：禁忌の要約を入れるハコ
    let pmdaWarnings = null; // ✨（旧）詳細データ用。後方互換のため残す
    let pmdaLastUpdated = ""; // 🌟追加：最終更新日を入れるためのハコを用意
    if (yj && yj !== "NONE" && env.PMDA_DB) {
      try {
        // ① まずは12桁完全一致で探す
        let pmdaVal = await env.PMDA_DB.get(yj);
        
        // ② 見つからなければ、前方9桁（成分・剤形が同じ兄弟薬）を探す
        if (!pmdaVal && yj.length >= 9) {
          const list9 = await env.PMDA_DB.list({ prefix: yj.substring(0, 9), limit: 1 });
          if (list9.keys.length > 0) pmdaVal = await env.PMDA_DB.get(list9.keys[0].name);
        }
        
        // ③ それでも見つからなければ、前方7桁（成分が同じ親戚）を探す
        if (!pmdaVal && yj.length >= 7) {
          const list7 = await env.PMDA_DB.list({ prefix: yj.substring(0, 7), limit: 1 });
          if (list7.keys.length > 0) pmdaVal = await env.PMDA_DB.get(list7.keys[0].name);
        }

        if (pmdaVal) {
          const pmdaData = JSON.parse(pmdaVal);
          // ✨修正：新しいデータ構造（summary内に効能・用法・禁忌）に対応！
          if (pmdaData.summary) {
            pmdaEfficacy = pmdaData.summary.efficacy || "";
            pmdaUsage = pmdaData.summary.usage || "";
            pmdaContra = pmdaData.summary.contraindications || ""; // 🌟追加：禁忌の要約を拾う
            pmdaWarnings = pmdaData.warnings || null; // 旧データ用（新データでは通常null）
            pmdaLastUpdated = pmdaData.last_updated || "";
          } else {
            // 古いデータが残っていてもエラーにならないように配慮
            pmdaEfficacy = pmdaData.efficacy || "";
            pmdaUsage = pmdaData.usage || "";
          }
        }
      } catch(e) { console.log("PMDA DB Error", e); }
    }
    // =========================================================================

    // ===== 🌟変更: 切替候補の並び順を「採用薬×同mg数」の優先度で並べ替える =====
    // 薬局長のリクエスト: 元の薬と同じmg数を上に。ただし違う規格も消さず下に残す。
    const baseDose = normalizeDose(extracted.spec); // 元の薬の用量（例:「10mg」）
    alts.sort((a, b) => {
      // ① 採用薬を優先（採用が上）
      if (b.isAdopted !== a.isAdopted) return b.isAdopted - a.isAdopted;
      // ② 同じ採用状況なら、元の薬と同mg数のものを優先
      const aSame = normalizeDose(a.spec) === baseDose && baseDose !== "";
      const bSame = normalizeDose(b.spec) === baseDose && baseDose !== "";
      if (aSame !== bSame) return (bSame ? 1 : 0) - (aSame ? 1 : 0);
      return 0; // それ以外は元の順序を維持
    });

    return { key: kvKey, label, fullName, yj, isAdopted, isBrand, comment, price, pmdaEfficacy, pmdaUsage, pmdaContra, pmdaWarnings, pmdaLastUpdated, alts };
  },

  getAdminHTML(env, hospitalId, hospitalName = "", globalInfo = "") {
    const isHospitalMode = hospitalId !== "";
    const bgColor = isHospitalMode ? "#fff0f5" : "var(--bg)";
    const headerBgColor = isHospitalMode ? "#ffe4e1" : "#fff"; 
    const demoBtnLabel = isHospitalMode ? "✅ プラスなう" : "✨ プラス体験";
    const demoBtnStyle = isHospitalMode 
      ? "background: #ff8da1; color: #fff; border: 1px solid #ff7b95;" 
      : "background: #fff0f5; color: #d63384; border: 1px solid #ffcdd2;"; 

    // 環境変数からTipsを取得してランダムに1つ選ぶ
    const tipsStr = env.KANI_TIPS || "メディカニくんですよろしくカニ！🦀";
    const tipsArray = tipsStr.split(';');
    const randomTip = tipsArray[Math.floor(Math.random() * tipsArray.length)];

    const infoManageHTML = globalInfo ? `
      <div class="card" style="border-left: 6px solid #ff8da1; margin-top: 15px; background: #fff5f7;">
        <div style="font-weight: bold; color: #d63384; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
          <span style="background: #ff8da1; color: #fff; font-size: 10px; padding: 2px 6px; border-radius: 4px;">公式</span>
          📢 運営からのお知らせ
        </div>
        <div style="font-size: 14px; line-height: 1.6; white-space: pre-wrap; color: #444;">${globalInfo}</div>
      </div>
    ` : "";

    // 👇ここから追加：トップ画面とハンバーガーメニュー用の表示分岐（ノーマルモード ＋ デモHPTEST1のみ）
    // 🌟修正：プラス体験とモニター申込を1つの枠に統合し、色味を調整
    const combinedPromoHTML = (!isHospitalMode || hospitalId === "HPTEST1") 
      ? `<div style="margin-top: 15px; padding: 15px; background: #fff0f5; border: 1px dashed #ffb6c1; border-radius: 15px; text-align: center;">
           <div style="font-size: 13px; color: #d63384; font-weight: bold; margin-bottom: 12px;">🦀 自施設の採用薬を検索できる機能を先行体験！✨</div>
           ${!isHospitalMode ? `<a href="/HPTEST1" style="display: block; background: #ff8da1; color: #fff; border: 1px solid #ff7b95; padding: 12px; border-radius: 10px; text-decoration: none; font-weight: bold; box-shadow: 0 4px 6px rgba(255,141,161,0.3); margin-bottom: 10px;">✨ プラス体験はこちら</a>` : ""}
           <a href="${env.BETA_FORM_URL || '#'}" target="_blank" style="display: block; background: #ffa755; color: #fff; border: 1px solid #f89634; padding: 12px; border-radius: 10px; text-decoration: none; font-weight: bold; box-shadow: 0 4px 6px rgba(255,167,85,0.3);">📝 ベータ版プラスモニター申込</a>
         </div>`
      : "";

    const officialSiteHTML = (!isHospitalMode || hospitalId === "HPTEST1") 
      ? `<a href="https://medikani.com/info" target="_blank" style="display:block; margin-top:15px; padding:15px; background:#e3f2fd; color:#0056b3; border-radius:15px; text-decoration:none; font-weight:bold; border:1px solid #bbdefb; text-align:center; box-sizing:border-box;">ℹ️ 公式サイトで詳しく見る</a>`
      : "";

    const signMenuItem = (!isHospitalMode || hospitalId === "HPTEST1") 
      ? `<a href="${env.BETA_FORM_URL || '#'}" target="_blank" class="menu-item" style="text-decoration:none; display:flex; background:#e8f5e9; color:#28a745; border:1px solid #c8e6c9;">📝 ベータ版プラス無料申込</a>` 
      : "";

    // 👇新規追加: 採用薬ボタン（プラスモードのみ表示、トップ画面用）
    const adoptedButtonsHTML = isHospitalMode ? `
        <div id="adoptedButtons" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 10px;">
          <button onclick="loadAdoptedList('[内]')" style="padding: 8px 4px; background: #f0fafd; border: 1.5px dashed #4dd0e1; border-radius: 10px; font-size: 11px; font-weight: bold; color: #00838f; cursor: pointer; outline: none;">採用💊 内服</button>
          <button onclick="loadAdoptedList('[外]')" style="padding: 8px 4px; background: #f0fafd; border: 1.5px dashed #4dd0e1; border-radius: 10px; font-size: 11px; font-weight: bold; color: #00838f; cursor: pointer; outline: none;">採用🩹 外用</button>
          <button onclick="loadAdoptedList('[注]')" style="padding: 8px 4px; background: #f0fafd; border: 1.5px dashed #4dd0e1; border-radius: 10px; font-size: 11px; font-weight: bold; color: #00838f; cursor: pointer; outline: none;">採用💉 注射</button>
        </div>
    ` : "";

    // 👇新規追加: メニュー用の「公式サイトへ」ボタンと、プラス体験ボタンの遷移先
    const officialMenuItem = `<a href="https://medikani.com/info" target="_blank" class="menu-item" style="text-decoration:none; display:flex; background:#e3f2fd; color:#0056b3; border:1px solid #bbdefb;">ℹ️ 公式サイトへ</a>`;
    const demoBtnUrl = isHospitalMode ? `/${hospitalId}` : "/HPTEST1";
    // 🌟追加: プラスモード時に表示する管理画面へのリンク
    const adminMenuItem = isHospitalMode ? `<a href="/${hospitalId}/admin" class="menu-item" style="text-decoration:none; display:flex; background:#f4f4f4; color:#333; border:1px solid #ccc;">⚙️ 管理画面</a>` : "";
    // 👆ここまで追加

    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦀</text></svg>">
    <link rel="icon" type="image/png" sizes="512x512" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
    <link rel="apple-touch-icon" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
    <title>メディカニ - 医薬品検索</title>
    <style>
      :root { --main-orange: #ff9d00; --bg: #fff9f0; }
      html { background: #333; display: flex; justify-content: center; }
      body { max-width: 500px; width: 100%; background: ${bgColor}; font-family: sans-serif; margin: 0; min-height: 100vh; box-shadow: 0 0 50px rgba(0,0,0,0.5); position: relative; transition: background 0.3s ease; }
      .header { background: ${headerBgColor}; padding: 8px; text-align: center; border-radius: 0 0 15px 15px; transition: background 0.3s ease; }
      .header h1 { margin: 0; font-size: 22px; color: var(--main-orange); display: flex; align-items: center; justify-content: center; gap: 8px; }
      .search-box { padding: 15px; background: #fff; position: sticky; top: 0; z-index: 10; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border-radius: 0 0 15px 15px; margin-bottom: 10px; }
      .tabs { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 15px; }
      .tab { padding: 10px 2px; border: none; background: #f0f0f0; border-radius: 10px; font-size: 11px; font-weight: bold; cursor: pointer; transition: all 0.2s; text-align: center; color: #555; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tab.active { background: var(--main-orange) !important; color: #fff !important; transform: scale(1.03); box-shadow: 0 2px 8px rgba(255, 157, 0, 0.4); border-color: var(--main-orange) !important; }
      input { width: 100%; padding: 14px 16px; border: 2px solid #e0e0e0; border-radius: 20px; box-sizing: border-box; font-size: 16px; outline: none; transition: border-color 0.2s; background: #fdfdfd; }
      input:focus { border-color: var(--main-orange); background: #fff; }
      .results { padding: 10px 15px; }
      
      /* メディカニくんの吹き出しエリア */
      .kani-tips-area { display: flex; align-items: center; gap: 10px; padding: 20px; background: #fff; border-radius: 15px; margin-top: 10px; border: 1px solid #ffe0b2; box-shadow: 0 4px 12px rgba(255,157,0,0.05); }
      .kani-icon { width: 60px; height: 60px; flex-shrink: 0; }
      .kani-bubble { position: relative; background: #fff3e0; padding: 12px 15px; border-radius: 15px; font-size: 14px; color: #e65100; font-weight: bold; line-height: 1.4; flex: 1; }
      .kani-bubble::before { content: ""; position: absolute; left: -10px; top: 20px; border-width: 5px 10px 5px 0; border-style: solid; border-color: transparent #fff3e0 transparent transparent; }

      /* トップ画面履歴エリア */
      .top-hist-scroll { display: flex; overflow-x: auto; gap: 8px; padding-bottom: 5px; scrollbar-width: none; }
      .top-hist-scroll::-webkit-scrollbar { display: none; }
      .top-hist-chip { background: #fff; border: 1px solid #ffcc80; border-radius: 20px; padding: 6px 12px; font-size: 12px; font-weight: bold; color: #e65100; box-shadow: 0 2px 4px rgba(255,157,0,0.1); cursor: pointer; white-space: nowrap; max-width: 150px; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; transition: transform 0.1s; }
      .top-hist-chip:active { transform: scale(0.95); }

      .card { background: #fff; border-radius: 15px; padding: 16px; margin-bottom: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.03); cursor: pointer; border-left: 6px solid #ccc; transition: transform 0.1s; }
      .card:active { transform: scale(0.98); }
      .card.adopted { border-left-color: #28a745; }
      .no-results { text-align: center; padding: 40px 20px; color: #777; font-size: 15px; line-height: 1.6; }
      .help-box { background: #fff; padding: 20px; border-radius: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.03); line-height: 1.6; white-space: pre-wrap; font-size: 14px; color: #444; }
      .tag { font-size: 11px; padding: 4px 10px; border-radius: 20px; background: #eee; font-weight: bold; white-space: nowrap; display: inline-block; }
      .tag.green { background: #d1ffd1; color: #155724; }
      .tag.red { background: #ffebeb; color: #dc3545; border: 1px solid #ffcdd2; }
      .tag.blue { background: #e3f2fd; color: #0d47a1; border: 1px solid #bbdefb; }
      #modalOverlay, #reportModalOverlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); backdrop-filter: blur(3px); display: none; z-index: 1000; justify-content: center; align-items: center; }
      #reportModalOverlay { z-index: 1100; }
      .modal { background: #fff; width: 92%; max-width: 400px; border-radius: 24px; padding: 25px; position: relative; overflow-y: auto; max-height: 85vh; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
      .modal-close { position: absolute; top: 12px; right: 18px; font-size: 28px; cursor: pointer; color: #999; }
      .btn-group { display: flex; gap: 10px; margin: 18px 0; }
      .btn { flex: 1; padding: 12px; font-size: 14px; text-align: center; text-decoration: none; border-radius: 12px; color: #fff; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 5px; }
      .btn-medley { background: #007bff; box-shadow: 0 3px 8px rgba(0,123,255,0.3); } .btn-google { background: #4285f4; box-shadow: 0 3px 8px rgba(66,133,244,0.3); }
      .alt-item { display: block; padding: 10px 12px; margin-bottom: 8px; border-radius: 10px; font-size: 13px; background: #f8f9fa; text-decoration: none; color: #444; border: 1px solid #eee; cursor: pointer; transition: background 0.2s; }
      .alt-item:active { background: #e9ecef; }
      .alt-item.adopted { background: #f2fff2; border-color: #d1ffd1; }
      .alt-item.adopted:active { background: #e2ffe2; }
      .alt-item-content { display: flex; justify-content: space-between; align-items: center; }
      #loading { text-align: center; padding: 30px; color: var(--main-orange); display: none; font-weight: bold; font-size: 15px; }
      .promo-box { margin-top: 25px; padding: 15px; border: 2px dashed #ff9d00; border-radius: 15px; background: #fff3e0; text-align: center; box-shadow: 0 4px 8px rgba(255,157,0,0.1); }
      .promo-title { font-size: 16px; font-weight: bold; color: #e65100; margin-bottom: 10px; display: flex; align-items: center; justify-content: center; gap: 6px; }
      .promo-qr { max-width: 150px; border-radius: 10px; margin: 10px 0; border: 3px solid #fff; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
      .promo-copy-area { position: relative; margin-top: 12px; }
      .promo-text { width: 100%; height: 60px; font-size: 12px; color: #555; border: 1px solid #ccc; border-radius: 8px; padding: 8px; box-sizing: border-box; background: #fff; resize: none; overflow: hidden; }
      .btn-copy { background: #e65100; color: #fff; border: none; padding: 6px 12px; font-size: 12px; border-radius: 6px; cursor: pointer; font-weight: bold; margin-top: 6px; transition: background 0.2s; }
      .btn-copy:active { background: #bf360c; }

      /* 報告モーダル用スタイル */
      .report-radio-group { display: flex; flex-direction: column; gap: 8px; margin-bottom: 15px; }
      .report-radio-label { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #444; background: #f8f9fa; padding: 10px; border-radius: 8px; border: 1px solid #eee; cursor: pointer; }
      .report-radio-label input[type="radio"] { width: auto; margin: 0; }
      /* === 新規追加: ハンバーガーメニュー用スタイル === */
      .hamburger-btn { background: none; border: none; font-size: 28px; cursor: pointer; color: var(--main-orange); padding: 5px; }
      .menu-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; display: none; opacity: 0; transition: opacity 0.3s; }
      .side-menu { position: fixed; top: 0; right: -250px; width: 200px; height: 100%; background: #fff; z-index: 1001; box-shadow: -4px 0 15px rgba(0,0,0,0.1); transition: right 0.3s ease; padding: 20px; display: flex; flex-direction: column; gap: 15px; }
      .side-menu-close { text-align: right; font-size: 28px; cursor: pointer; color: #999; margin-bottom: 5px; line-height: 1; }
      .menu-item { background: #f4f7f6; border: none; padding: 15px; border-radius: 10px; font-size: 14px; font-weight: bold; cursor: pointer; text-align: left; color: #555; display: flex; align-items: center; gap: 10px; transition: background 0.2s; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
      .menu-item:active { background: #e2e6e5; }
    </style></head>
    <body>
      <div id="sysHelpData" style="display:none;">${env.HELP_TEXT || "環境変数 HELP_TEXT に使い方の説明などを設定してください。"}</div>
      <div class="header" style="display:flex; justify-content:space-between; align-items:center;">
        <div style="width:38px;"></div> <div style="display:flex; flex-direction:column; align-items:center;">
          <h1 style="margin:0;">
            <a href="/${hospitalId}" style="display: flex; align-items: center; justify-content: center;">
              <img src="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/medikanilogo.png" alt="メディカニ 医薬品検索" style="height: 50px; max-width: 100%; object-fit: contain; border: none;">
            </a>
          </h1>
          ${hospitalName ? `<div style="margin-top: 4px; display: inline-block; background: rgba(255,255,255,0.7); color: #d63384; font-size: 11px; font-weight: bold; padding: 2px 6px; border-radius: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">🏥 ${hospitalName}</div>` : ''}
        </div>
        <button class="hamburger-btn" onclick="toggleMenu()">☰</button>
      </div>
      
      <div class="menu-overlay" id="menuOverlay" onclick="toggleMenu()"></div>
      <div class="side-menu" id="sideMenu">
        <div class="side-menu-close" onclick="toggleMenu()">×</div>
        <button class="menu-item" onclick="setCat('[履歴]', null); toggleMenu();">🕒 履歴</button>
        <button class="menu-item" onclick="setCat('[お気に入り]', null); toggleMenu();">⭐️ お気に入り</button>
        <a href="${demoBtnUrl}" class="menu-item" style="text-decoration:none; display:flex; ${demoBtnStyle}" onclick="toggleMenu();">${demoBtnLabel}</a>
        <button class="menu-item" onclick="setCat('[ヘルプ]', null); toggleMenu();">❓ ヘルプ</button>
        ${signMenuItem}
        ${officialMenuItem}
        ${adminMenuItem}
      </div>
      <div class="search-box">
        <div class="tabs">
          <button class="tab active" onclick="setCat('[内]', this)">💊 内服</button>
          <button class="tab" onclick="setCat('[外]', this)">🩹 外用</button>
          <button class="tab" onclick="setCat('[注]', this)">💉 注射</button>
          <button class="tab" onclick="setCat('[一般名]', this)">🧬 一般名</button>
          <button class="tab" onclick="setCat('[市販]', this)">🛒 市販薬</button>
        </div>
        <input type="text" id="q" placeholder="🔍 お薬名（かな・カナ３文字〜）..." oninput="search()">
      </div>
      <div id="loading">🦀 メディカニくんが一生懸命探しています... 💦</div>
      <div class="results" id="results">
        <div id="defaultDisplay">
          ${adoptedButtonsHTML}
          <div class="kani-tips-area">
            <img src="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani.png" class="kani-icon" alt="カニ">
            <div class="kani-bubble">${randomTip}</div>
          </div>
          <div id="topHistoryArea" style="margin-top:10px;"></div>
          <div id="boardArea"></div>
          ${combinedPromoHTML} ${infoManageHTML}
          ${officialSiteHTML} </div>
      </div>
      <div id="modalOverlay" onclick="closeModal(event)"><div class="modal" onclick="event.stopPropagation()">
        <span class="modal-close" onclick="closeModal()">×</span>
        <div id="modalContent"></div>
      </div></div>
      
      <div id="reportModalOverlay" onclick="closeReportModal(event)"><div class="modal" onclick="event.stopPropagation()">
        <span class="modal-close" onclick="closeReportModal()">×</span>
        <h3 style="color:#dc3545; margin-top:0;">🚨 現場の知見を報告</h3>
        <p id="reportDrugNameLabel" style="font-size:14px; font-weight:bold; color:#555; margin-bottom:15px;"></p>
        
        <label style="font-size:12px; font-weight:bold; color:#666; margin-bottom:5px; display:block;">報告の種類</label>
        <div class="report-radio-group">
          <label class="report-radio-label"><input type="radio" name="repType" value="📝 メモの修正・追加" checked> 📝 メモの修正・追加</label>
          <label class="report-radio-label"><input type="radio" name="repType" value="🏥 採用薬のはず（漏れ）"> 🏥 採用薬のはず（漏れ）</label>
          <label class="report-radio-label"><input type="radio" name="repType" value="💡 その他・要望"> 💡 その他・要望</label>
        </div>

        <label style="font-size:12px; font-weight:bold; color:#666; margin-bottom:5px; display:block;">内容</label>
        <textarea id="reportComment" style="width:100%; height:80px; padding:10px; border:1px solid #ccc; border-radius:8px; margin-bottom:15px; box-sizing:border-box; font-family:sans-serif;" placeholder="具体的な内容を教えてくださいカニ🦀"></textarea>
        
        <label style="font-size:12px; font-weight:bold; color:#666; margin-bottom:5px; display:block;">お名前（部署など）</label>
        <input type="text" id="reportName" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:8px; margin-bottom:20px; box-sizing:border-box;" placeholder="例：受付 山田">
        
        <button id="btnSubmitReport" onclick="submitReport()" style="width:100%; padding:12px; background:#dc3545; color:#fff; border:none; border-radius:8px; font-weight:bold; cursor:pointer; transition: transform 0.1s;">🚀 報告を送信する</button>
      </div></div>

      <!-- ===== 🌟追加: フッター（運営元表示） ここから ===== -->
      <footer style="max-width:600px; margin:15px auto 0; padding:22px 16px 26px; background:#fff0f5; border-radius:15px; text-align:center; font-family:sans-serif;">
        <div style="font-size:14px; font-weight:bold; color:#d63384; margin-bottom:8px;">
          🦀 メディカニ 医薬品検索
        </div>
        <div style="font-size:11px; color:#aa8899; line-height:1.9;">
          © 2026 🐔トリの巣ワークス  メディカニ運営事務局
        </div>
        </footer>
      <!-- ===== 🌟追加: フッター ここまで ===== -->

        <script>
        const hId = "${hospitalId}";
        let currentCat = '[内]'; let timer = null;
        let currentDetailData = null; 

        // 🌟新規追加: 採用一覧表示・追加読み込み（50件ページネーション）用の処理
        let adoptedFullList = [];
        let adoptedDisplayCount = 0;
        let currentAdoptedCat = '';

        // 🌟追加: 採用薬一覧の上に出す「カテゴリ切替ボタン」を作る（今開いているカテゴリは色付きで表示）
        function adoptedCatSwitcherHTML() {
          const cats = [ ['[内]', '採用💊 内服'], ['[外]', '採用🩹 外用'], ['[注]', '採用💉 注射'] ];
          let btns = '';
          for (const c of cats) {
            const isActive = (currentAdoptedCat === c[0]);
            const style = isActive
              ? 'padding: 8px 4px; background: #4dd0e1; border: 1.5px solid #4dd0e1; border-radius: 10px; font-size: 11px; font-weight: bold; color: #fff; cursor: pointer; outline: none;'
              : 'padding: 8px 4px; background: #f0fafd; border: 1.5px dashed #4dd0e1; border-radius: 10px; font-size: 11px; font-weight: bold; color: #00838f; cursor: pointer; outline: none;';
            btns += '<button onclick="loadAdoptedList(\\'' + c[0] + '\\')" style="' + style + '">' + c[1] + '</button>';
          }
          return '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 12px;">' + btns + '</div>';
        }

        async function loadAdoptedList(cat) {
          document.getElementById('q').value = ''; // 検索窓に入っている文字を綺麗にする
          currentAdoptedCat = cat;
          document.getElementById('loading').style.display = 'block';
          const resDiv = document.getElementById('results');
          resDiv.innerHTML = '';
          
          try {
            const res = await fetch('/api/adopted-list?c=' + encodeURIComponent(cat) + '&h=' + hId);
            adoptedFullList = await res.json();
            document.getElementById('loading').style.display = 'none';
            adoptedDisplayCount = 0;
            
            if (adoptedFullList.length === 0) {
              // 🌟修正: 0件でもカテゴリ切替ボタンは出したままにする
              resDiv.innerHTML = adoptedCatSwitcherHTML() + '<div class="no-results">📭 該当する採用薬が登録されていませんカニ🦀</div>';
              return;
            }
            renderAdoptedMore(true); // 最初の50件を描画
          } catch(e) {
            document.getElementById('loading').style.display = 'none';
            resDiv.innerHTML = '<div class="no-results">⚠️ データの読み込みに失敗しましたカニ🦀💦</div>';
          }
        }

        function renderAdoptedMore(isFirst = false) {
          const resDiv = document.getElementById('results');
          // 役目を終えた古い「もっと見る」ボタンを画面から消去
          const oldBtn = document.getElementById('btnAdoptedMore');
          if (oldBtn) oldBtn.remove();

          const start = adoptedDisplayCount;
          const end = Math.min(start + 50, adoptedFullList.length);
          const chunk = adoptedFullList.slice(start, end);
          adoptedDisplayCount = end;

          // 検索結果と全く同じカードデザインを組み立てる
          // 🌟修正: シングルクォーテーションを守るためのバックスラッシュを \\' に強化してエラーを完全消滅させました！
          const html = chunk.map(i => {
            return '<div class="card adopted" onclick="showDetail(\\'' + i.key.replace(/'/g, "\\\\'") + '\\')">' +
              '<div style="display:flex; justify-content:space-between; align-items:flex-start; font-weight:bold; font-size:15px; gap:8px;">' +
                '<div style="flex:1; line-height:1.4;">' + getFormEmoji(i.yj, currentAdoptedCat) + ' ' + i.name + '</div>' +
                '<div style="flex-shrink:0; display:flex; gap:4px; margin-top:2px;">' +
                  (i.isBrand ? '<span class="tag blue">先</span>' : '') +
                  (i.price && i.price !== '-' ? '<span class="tag" style="background:#fff3cd;color:#333;border:1px solid #ffe69c;"><span style="color:#e65100;">￥</span>' + i.price + '</span>' : '') +
                  (i.yj && i.yj.startsWith('8') ? '<span class="tag red">麻</span>' : '') +
                  '<span class="tag green">🏥 採用</span>' +
                '</div>' +
              '</div>' +
              
              '<div style="font-size:12px; color:#888; margin-top:8px;">📦 ' + i.spec + ' ' + (i.type ? '/ ' + i.type : '') + '</div>' +
            '</div>';
          }).join('');

          if (isFirst) {
            // 🌟修正: 一覧の先頭にカテゴリ切替ボタンを付けて、他の採用薬一覧へ直接移動できるようにする
            resDiv.innerHTML = adoptedCatSwitcherHTML() + html;
          } else {
            // 2回目以降（追加読み込み）は、スクロール位置を崩さず一番下にお薬を継ぎ足す
            resDiv.insertAdjacentHTML('beforeend', html);
          }

          // まだ残りのデータがあれば「もっと見る」ボタンを一番下に配置
          if (adoptedDisplayCount < adoptedFullList.length) {
            const moreBtnHtml = '<button id="btnAdoptedMore" onclick="renderAdoptedMore()" style="width:100%; padding:12px; background:#f0fafd; border:1.5px dashed #4dd0e1; border-radius:12px; color:#00838f; font-weight:bold; cursor:pointer; margin-top:15px; outline:none; transition: transform 0.1s;">もっと見る🦀 （' + adoptedDisplayCount + ' / ' + adoptedFullList.length + ' 件を表示中）</button>';
            resDiv.insertAdjacentHTML('beforeend', moreBtnHtml);
          }
        }
        
        // 報告用グローバル変数
        let currentReportYj = "";
        let currentReportName = "";

        const promoHTML = \`
          <div class="promo-box">
            <div class="promo-title">📣 メディカニをシェアしてカニ〜！🦀✨</div>
            <p style="font-size:13px;color:#666;margin:5px 0 10px;">スマホでQRを読み取って同僚や友人に教えてあげてね！🎁</p>
            <img src="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/QR.png" alt="メディカニQRコード" class="promo-qr">
            <div class="promo-copy-area">
              <textarea id="shareText" class="promo-text" readonly>🏥 採用薬が爆速でわかる「メディカニ」超便利だよ！🦀\n今すぐチェックカニ〜！✨\nhttps://medikani.com/</textarea>
              <button class="btn-copy" onclick="copyShareText()">📝 コピペしてシェアする</button>
              <span id="copyMsg" style="display:none;font-size:11px;color:#28a745;margin-left:8px;">✅ コピーしたカニ！🦀</span>
            </div>
          </div>
        \`;

        // 🌟紹介キャンペーン一時停止のため空にする
const introCampaignHTML = '';

// 🌟環境変数とテキストをベータ版に変更
const signFormHTML = \`
  <a href="${env.BETA_FORM_URL || '#'}" target="_blank" style="display:block; margin-top:5px; padding:15px; background:#28a745; color:#fff; border-radius:15px; text-decoration:none; font-weight:bold; box-shadow:0 4px 10px rgba(40,167,69,0.3); text-align:center; font-size:15px;">
    📝 ベータ版プラス無料申込
  </a>
\`;

// 🌟紹介キャンペーン一時停止のため空にする
const simpleIntroHTML = '';

        function copyShareText() {
          const textArea = document.getElementById('shareText');
          textArea.select();
          textArea.setSelectionRange(0, 99999); 
          navigator.clipboard.writeText(textArea.value).then(() => {
            const msg = document.getElementById('copyMsg');
            msg.style.display = 'inline';
            setTimeout(() => msg.style.display = 'none', 2000);
          });
        }
        function setCat(cat, el) { 
          currentCat = cat; 
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); 
          if (el) { el.classList.add('active'); } // エラー防止：elがある時だけ色を変える
          search(); 
        }
        
        // 👇新規追加: メニューを開閉するアニメーション処理👇
        function toggleMenu() {
          const menu = document.getElementById('sideMenu');
          const overlay = document.getElementById('menuOverlay');
          if (menu.style.right === '0px') {
            menu.style.right = '-250px';
            overlay.style.opacity = '0';
            setTimeout(() => overlay.style.display = 'none', 300);
          } else {
            overlay.style.display = 'block';
            setTimeout(() => { overlay.style.opacity = '1'; menu.style.right = '0px'; }, 10);
          }
        }
        function searchAlt(kw) {
          document.getElementById('q').value = kw;
          setCat('[一般名]', document.querySelectorAll('.tab')[3]); 
        }
function getFormEmoji(yj, ctx = "") {
          if (!yj || yj === "NONE" || yj.length < 8) return "💊";
          const f = yj.charAt(7).toUpperCase();
          const s = String(ctx);
          
          // 1. 注射薬
          if (s.includes("注")) return "💉";
          
          // 2. 外用薬（「外」または「坐」が含まれていればここに入る）
          if (s.includes("外") || s.includes("坐")) {
            if (f === "P" || f === "S") return "🩹"; // テープ・パップ等
            if (f === "R" || f === "T") return "💨"; // スプレー・吸入等
            if (f === "M" || f === "T") return "🧴"; // 軟膏
            if ("QUVWX".includes(f)) return "💧"; // 点眼・点鼻・うがい・浣腸等
            if (f === "J" || s.includes("坐")) return "🚀"; // 坐薬（YJコードか文字で判定）
            return "🧴"; // 他ローション等
          }
          
          // 3. 内服薬
          if (f === "A") return "🧂"; // 散剤・顆粒（粉薬）
          if ("DQEST".includes(f)) return "💧"; // シロップ・液剤等
          if (f === "G") return "🍬"; // トローチ・ドロップ
          if ("HR".includes(f)) return "🍮"; // ゼリー剤
          if (f === "K") return "👅"; // フィルム剤
          
          // B(錠剤), C(カプセル), F, I, J(チュアブル) などは基本の薬マーク
          return "💊";
        }
        function renderHistory() {
          const resDiv = document.getElementById('results');
          document.getElementById('loading').style.display = 'none';
          let hist = JSON.parse(localStorage.getItem('yakumiru_history') || '[]');
          if (hist.length === 0) {
            resDiv.innerHTML = '<div class="no-results">📭 まだメディカニくんが見たお薬はないみたいです 🦀<br><span style="font-size:12px;color:#aaa;">検索するとここに履歴が残ります✨</span></div>';
          } else {
            resDiv.innerHTML = hist.map(i => {
                const displayName = i.name || i.fullName || "名称不明";
                const onClickStr = i.isOtc ? "showOtcDetail('" + i.fullName.replace(/'/g, "\\\\'") + "')" : "showDetail('" + i.key + "')";
                return \`
                <div class="card \${i.isAdopted ? 'adopted' : ''}" onclick="\${onClickStr}">
                  <div style="display:flex; justify-content:space-between; align-items:flex-start; font-weight:bold; gap:8px;">
                  <div style="flex:1; line-height:1.4;">\${i.isOtc ? '🛒' : getFormEmoji(i.yj, i.key)} \${displayName}</div>
                  <div style="flex-shrink:0; display:flex; gap:4px; margin-top:2px;">
                    \${i.isOtc ? '<span class="tag" style="background:#fff3e0;color:#e65100;border:1px solid #ffcc80;">市販薬</span>' : \`
                    \${i.isBrand ? '<span class="tag blue">先</span>' : ''}
                    \${i.price && i.price !== '-' ? \`<span class="tag" style="background:#fff3cd;color:#333;border:1px solid #ffe69c;"><span style="color:#e65100;">￥</span>\${i.price}</span>\` : ''}
                    \${i.yj && i.yj.startsWith('8') ? '<span class="tag red">麻</span>' : ''}
                    \${i.isAdopted ? '<span class="tag green">🏥 採用</span>' : '<span class="tag">未採用</span>'}
                    \`}
                  </div>
                </div>
                <div style="font-size:12px; color:#888; margin-top:8px;">🕒 さいきん見たお薬カニ🦀</div>
              </div>\`
            }).join('');
          }
        }
        function renderFavorites() {
          const resDiv = document.getElementById('results');
          document.getElementById('loading').style.display = 'none';
          let favs = JSON.parse(localStorage.getItem('yakumiru_favorites') || '[]');
          if (favs.length === 0) {
            resDiv.innerHTML = '<div class="no-results">⭐️ お気に入りはまだありませんカニ🦀<br><span style="font-size:12px;color:#aaa;">お薬の詳細画面で「⭐」を押すと登録できるよ！</span></div>';
          } else {
            resDiv.innerHTML = favs.map(i => {
                const displayName = i.name || i.fullName || "名称不明";
                const onClickStr = i.isOtc ? "showOtcDetail('" + i.fullName.replace(/'/g, "\\\\'") + "')" : "showDetail('" + i.key + "')";
                return \`
                <div class="card \${i.isAdopted ? 'adopted' : ''}" onclick="\${onClickStr}">
                  <div style="display:flex; justify-content:space-between; align-items:flex-start; font-weight:bold; gap:8px;">
                  <div style="flex:1; line-height:1.4;">\${i.isOtc ? '🛒' : getFormEmoji(i.yj, i.key)} \${displayName}</div>
                  <div style="flex-shrink:0; display:flex; gap:4px; margin-top:2px;">
                    \${i.isOtc ? '<span class="tag" style="background:#fff3e0;color:#e65100;border:1px solid #ffcc80;">市販薬</span>' : \`
                    \${i.isBrand ? '<span class="tag blue">先</span>' : ''}
                    \${i.price && i.price !== '-' ? \`<span class="tag" style="background:#fff3cd;color:#333;border:1px solid #ffe69c;"><span style="color:#e65100;">￥</span>\${i.price}</span>\` : ''}
                    \${i.yj && i.yj.startsWith('8') ? '<span class="tag red">麻</span>' : ''}
                    \${i.isAdopted ? '<span class="tag green">🏥 採用</span>' : '<span class="tag">未採用</span>'}
                    \`}
                  </div>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
                  <div style="font-size:12px; color:#ff9d00; font-weight:bold;">⭐️ お気に入りカニ🦀</div>
                  <!-- 👇 WAFに引っかからないようシンプルなonclickのみに変更 -->
                  <div onclick="removeFromFavorites('\${i.key}', event)" style="font-size:20px; cursor:pointer; background:#fff3e0; border-radius:50%; width:34px; height:34px; display:flex; justify-content:center; align-items:center; border:1px solid #ffcc80;" title="お気に入りから削除する">⭐️</div>
                </div>
              </div>\`;
            }).join('');
          }
        }
        function renderTopHistory(cat) {
          const area = document.getElementById('topHistoryArea');
          if (!area) return;
          if (cat === '[履歴]' || cat === '[お気に入り]' || cat === '[デモ]' || cat === '[ヘルプ]') {
            area.innerHTML = '';
            return;
          }
          let hist = [];
          try { hist = JSON.parse(localStorage.getItem('yakumiru_history') || '[]'); } catch(e) {}
          let filtered = hist.filter(h => h.key && h.key.includes(cat)).slice(0, 5);
          if (filtered.length === 0) {
            area.innerHTML = '';
            return;
          }
          let chipsHTML = filtered.map(h => {
             let n = h.name || h.fullName || "名称不明";
             let shortName = n.split(' ')[0];
             const onClickStr = h.isOtc ? "showOtcDetail('" + h.fullName.replace(/'/g, "\\\\'") + "')" : "showDetail('" + h.key + "')";
             return \`<div class="top-hist-chip" onclick="\${onClickStr}">\${h.isOtc ? '🛒' : getFormEmoji(h.yj, h.key)} \${shortName}</div>\`;
          }).join('');
          
          let catName = cat.replace(/\\[|\\]/g, '');
          area.innerHTML = \`<div style="font-size:12px; color:#888; font-weight:bold; margin-bottom:6px; padding-left:4px;">🕒 最近見た\${catName}薬</div><div class="top-hist-scroll">\${chipsHTML}</div>\`;
        }
        function saveHistory(key, d) {
          try {
            let hist = JSON.parse(localStorage.getItem('yakumiru_history') || '[]');
            hist = hist.filter(h => h.key !== key);
            if (d.isOtc) {
              hist.unshift({ key: key, isOtc: true, name: d.name || d.fullName, fullName: d.fullName, aiInfo: d.aiInfo, kataQuery: d.kataQuery });
            } else {
              hist.unshift({ key: key, name: d.fullName, yj: d.yj, isAdopted: d.isAdopted, isBrand: d.isBrand, price: d.price });
            }
if (hist.length > 50) hist.pop(); 
            localStorage.setItem('yakumiru_history', JSON.stringify(hist));
            if (currentCat === '[履歴]') renderHistory();
            else if (document.getElementById('q').value.trim().length === 0) renderTopHistory(currentCat);
            // === 追加: 詳細表示ランキング用データ送信 ===
            if (hId) fetch('/api/track?h=' + hId, { method: 'POST', body: JSON.stringify({ type: 'view', key: key, name: d.name || d.fullName }) }).catch(e=>{});
            // ==================================
          } catch(e) {}
        }
        function isFavorite(key) {
          let favs = JSON.parse(localStorage.getItem('yakumiru_favorites') || '[]');
          return favs.some(f => f.key === key);
        }
        
         // === 修正: インラインでのお気に入り追加に対応、履歴への同時保存機能を追加 ===
        function toggleFav(isInline = false) {
          if (isInline && window.lastOtcResult) {
            currentDetailData = window.lastOtcResult;
          }
          if (!currentDetailData) return;
          let d = currentDetailData;
          let favs = JSON.parse(localStorage.getItem('yakumiru_favorites') || '[]');
          let idx = favs.findIndex(f => f.key === d.key);
          const starEl = isInline ? document.getElementById('inlineFavStar') : document.getElementById('favStar');
          
          let trackVal = 0;
          if (idx >= 0) {
            favs.splice(idx, 1);
            if (starEl) {
              if (isInline) {
                starEl.innerHTML = '<span style="color:#eed25c; font-size:36px; font-weight:bold; line-height:1;">☆</span>';
              } else {
                starEl.innerHTML = '<span style="color:#eed25c; font-size:36px; font-weight:bold; line-height:1; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.1));">☆</span> <span style="color:gray; font-size:11pt; font-weight:bold; line-height:1;">お気に入り追加</span>';
              }
            }
            trackVal = -1;
          } else {
            if (d.isOtc) {
              favs.unshift({ key: d.key, isOtc: true, name: d.name || d.fullName, fullName: d.fullName, aiInfo: d.aiInfo, kataQuery: d.kataQuery });
              saveHistory(d.key, d);
            } else {
              favs.unshift({ key: d.key, name: d.fullName, yj: d.yj, isAdopted: d.isAdopted, isBrand: d.isBrand, price: d.price });
            }
            if (starEl) {
              if (isInline) {
                starEl.innerText = '⭐️';
              } else {
                starEl.innerHTML = '<span style="font-size:28px; line-height:1; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.1));">⭐️</span> <span style="color:gray; font-size:11pt; font-weight:bold; line-height:1;">お気に入り済</span>';
              }
            }
            trackVal = 1;
          }
          localStorage.setItem('yakumiru_favorites', JSON.stringify(favs));
          // === 追加: ランキング用データ送信 ===
          if (hId) fetch('/api/track?h=' + hId, { method: 'POST', body: JSON.stringify({ type: 'fav', key: d.key, val: trackVal, name: d.name || d.fullName }) }).catch(e=>{});
          // ==================================
          if (currentCat === '[お気に入り]') renderFavorites();
        }
        // ==============================================================
// === 追加：お気に入り一覧から直接削除する専用の関数 ===
        function removeFromFavorites(key, event) {
          // ① これが超重要！カード全体の「クリックして詳細を開く」という動きをここでストップさせます
          event.stopPropagation(); 
          
          // ② 保存されているお気に入りリストを呼び出す
          let favs = JSON.parse(localStorage.getItem('yakumiru_favorites') || '[]');
          
          // ③ クリックされた薬「以外」を残す ＝ クリックされた薬を削除する
          favs = favs.filter(f => f.key !== key);
          
          // ④ 新しいリストを保存し直す
          localStorage.setItem('yakumiru_favorites', JSON.stringify(favs));
          
          // ⑤ ランキングのカウントも裏でこっそり減らしておく
          if (hId) fetch('/api/track?h=' + hId, { method: 'POST', body: JSON.stringify({ type: 'fav', key: key, val: -1 }) }).catch(e=>{});
          
          // ⑥ 画面を最新のお気に入り一覧に更新する
          if (currentCat === '[お気に入り]') renderFavorites();
        }
        // ===================================================
        function search() {
          const q = document.getElementById('q').value.trim();
          const resDiv = document.getElementById('results');
          if (currentCat === '[ヘルプ]') {
            clearTimeout(timer);
            document.getElementById('loading').style.display = 'none';
            const helpEl = document.getElementById('sysHelpData');
            resDiv.innerHTML = '<div class="help-box">' + (helpEl ? helpEl.innerHTML : '説明文がありませんカニ🦀') + '</div>' + promoHTML + '<div style="margin-top:20px; text-align:center;">' + simpleIntroHTML + '<a href="https://medikani.com/info" target="_blank" style="display:block; background:#e3f2fd; color:#0056b3; padding:15px; border-radius:15px; text-decoration:none; font-weight:bold; border:1px solid #bbdefb; box-sizing:border-box;">ℹ️ 公式サイトで詳しく見る</a></div>';
            return;
          }
          if (currentCat === '[履歴]') { clearTimeout(timer); renderHistory(); return; }
          if (currentCat === '[お気に入り]') { clearTimeout(timer); renderFavorites(); return; }

                   
          // 検索文字が空になったらデフォルト表示に戻す
          if (q.length === 0) {
            // 📢 infoManageHTML を boardArea の後ろに追加
            resDiv.innerHTML = '<div id="defaultDisplay">' + \`${adoptedButtonsHTML}\` + '<div class="kani-tips-area"><img src="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani.png" class="kani-icon" alt="カニ"><div class="kani-bubble">' + (window.currentKaniTip || 'お薬名を入力してみてカニ！🦀') + '</div></div><div id="topHistoryArea" style="margin-top:10px;"></div><div id="boardArea">' + (window.boardHTML || '') + '</div>' + introCampaignHTML + \`${combinedPromoHTML}\` + \`${infoManageHTML}\` + \`${officialSiteHTML}\` + '</div>';
            renderTopHistory(currentCat);
            return;
          }
          // ===== 🌟ここから追加: ツムラの番号検索なら1文字でも通す =====
          // 「1」や「ツムラ1」「つむら１」などの形かどうかを判定します
          const isTsumuraNumber = /^(?:ツムラ|つむら)?\s*[０-９0-9]{1,3}$/.test(q);
          
          // ツムラ番号ではなく、かつ1文字以下の場合はここでストップ！
          if (!isTsumuraNumber && q.length < 2) { resDiv.innerHTML = ''; return; }
          // ===== 🌟ここまで追加 =====
                            
          clearTimeout(timer);
          timer = setTimeout(async () => {
            document.getElementById('loading').style.display = 'block';
            resDiv.innerHTML = ''; 
            try {
              const res = await fetch(\`/api/search?c=\${encodeURIComponent(currentCat)}&q=\${encodeURIComponent(q)}&h=\${hId}\`);
              const data = await res.json();
              document.getElementById('loading').style.display = 'none';
              if (data.isOtc) {
                let infoHtml = data.aiInfo || "";
                
                let extractedName = q;
                infoHtml = infoHtml.replace(/(?:対象|薬品名)[:：]\\s*([^\\n]+)/, function(match, name) {
                   extractedName = name.trim();
                   return '<div style="font-weight:bold; color:#d63384; margin-bottom:8px; border-bottom:1px dashed #ffd1dc; padding-bottom:4px;">薬品名： ' + extractedName + '</div>';
                });
                infoHtml = infoHtml.replace(/切替候補[:：]\\s*([^\\n]+)/, function(match, kw) {
                  var cleanKw = kw.trim().replace(/['"]/g, "");
                  return '主成分：<span style="font-weight:bold; color:#0056b3;">' + cleanKw + '</span> <button onclick="searchAlt(\\'' + cleanKw + '\\')" style="background:var(--main-orange);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;margin-left:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);font-weight:bold;vertical-align:middle;">🔍 主成分で切替検索</button>';
                });
                const searchKw = data.kataQuery || q;

                // === 修正箇所: キーを表示された市販薬名（extractedName）に統一する ===
                const otcKey = '[市販]' + extractedName;
                window.lastOtcResult = { key: otcKey, isOtc: true, name: extractedName, fullName: extractedName, aiInfo: data.aiInfo, kataQuery: data.kataQuery };
                const isFav = isFavorite(otcKey);

                resDiv.innerHTML = '<div class="card" style="border-left-color:#e83e8c;">' +
                  '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">' +
                    '<div style="font-weight:bold; color:#e83e8c;">👩‍⚕️ メディカニくんの解説 🦀✨</div>' +
                    '<span id="inlineFavStar" onclick="toggleFav(true)" style="font-size:24px; cursor:pointer; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1)); line-height:1;" title="お気に入りに登録/解除">' + (isFav ? '⭐️' : '☆') + '</span>' +
                  '</div>' +
                  '<div style="font-size:14px; background:#fff0f5; padding:12px; border-radius:10px; margin-bottom:12px; line-height:1.6; white-space:pre-wrap; border: 1px solid #ffd1dc;">' + infoHtml + '</div>' +
                  '<a href="https://www.google.com/search?q=' + encodeURIComponent(searchKw + ' 医療用 同成分') + '" class="btn btn-google" target="_blank" style="display:flex;">🔍 Googleで処方薬を探す</a>' +
                '</div>';
                // ==========================================================

              } else if (!data || data.length === 0) {
                resDiv.innerHTML = '<div class="no-results">📭 アレ…？お薬が見つかりませんでしたカニ🦀💦<br><span style="font-size:12px;color:#aaa;">名前のスペルを変えて試してみてね！</span></div>';
              } else {
                resDiv.innerHTML = data.map(i => \`
                  <div class="card \${i.isAdopted ? 'adopted' : ''}" onclick="showDetail('\${i.key}')">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; font-weight:bold; font-size:15px; gap:8px;">
                      <div style="flex:1; line-height:1.4;">\${getFormEmoji(i.yj, currentCat)} \${i.name}</div>
                      <div style="flex-shrink:0; display:flex; gap:4px; margin-top:2px;">
                        \${i.isBrand ? '<span class="tag blue">先</span>' : ''}
                        \${i.price && i.price !== '-' ? \`<span class="tag" style="background:#fff3cd;color:#333;border:1px solid #ffe69c;"><span style="color:#e65100;">￥</span>\${i.price}</span>\` : ''}
                        \${i.yj && i.yj.startsWith('8') ? '<span class="tag red">麻</span>' : ''}
                        \${i.isAdopted ? '<span class="tag green">🏥 採用</span>' : '<span class="tag">未採用</span>'}
                      </div>
                    </div>
                    <div style="font-size:12px; color:#888; margin-top:8px;">📦 \${i.spec} \${i.type ? '/ ' + i.type : ''}</div>
                  </div>\`).join('');
              }
            } catch(e) {
              document.getElementById('loading').style.display = 'none';
              resDiv.innerHTML = '<div class="no-results">⚠️ ネットの調子が悪いみたいですカニ… 🦀💦</div>';
            }
          }, 400);
        }
        
        // === 新規追加: 掲示板データの初期取得と保持 ===
        window.currentKaniTip = \`${randomTip}\`;
        window.boardHTML = "";
        
        // 初回表示の履歴レンダリング
        if (document.getElementById('q').value.trim().length === 0) {
           renderTopHistory(currentCat);
        }

        fetch('/api/board?h=' + hId).then(r=>r.json()).then(data => {
          if (data && data.length > 0) {
            window.boardHTML = '<div style="margin-top:15px; font-weight:bold; color:var(--main-orange);">📢 お知らせ</div>' + 
              data.slice(0, 5).map(b => {
                // 正規表現のバックスラッシュをエスケープ（\を二重化）
                const parsedMessage = (b.message || "").replace(/\\[\\[\\[💊 (.*?)\\|(.*?)\\]\\]\\]/g, (match, name, key) => {
                  const safeKey = String(key).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  const safeName = String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  // バッククォートをやめてシングルクォートの結合に変更
                  return '<a href="#" onclick="showDetail(\\'' + safeKey + '\\'); return false;" style="color:#0056b3; font-weight:bold; text-decoration:underline;">💊 ' + safeName + '</a>';
                });
                return '<div class="card" style="border-left-color:var(--main-orange); margin-top:10px;"><div style="font-size:12px; color:#888; margin-bottom:5px;">🕒 ' + b.date + '</div><div style="font-size:14px; line-height:1.6; white-space:pre-wrap;">' + parsedMessage + '</div></div>';
              }).join('');
          }
          // 初期表示時（検索欄が空の時）に流し込む
          if (document.getElementById('q').value.trim().length === 0 && document.getElementById('boardArea')) {
            document.getElementById('boardArea').innerHTML = window.boardHTML;
            renderTopHistory(currentCat);
          }
        }).catch(e => {});

                // === 新規追加: 市販薬専用の履歴表示モーダル ===
        function showOtcDetail(query) {
          let hist = JSON.parse(localStorage.getItem('yakumiru_history') || '[]');
          let favs = JSON.parse(localStorage.getItem('yakumiru_favorites') || '[]');
          let item = hist.find(h => h.isOtc && h.fullName === query) || favs.find(f => f.isOtc && f.fullName === query);
          if (!item) return;

        const displayName = item.name || query;
          // 👇 修正：名前からキーを再生成せず、保存されている正しいキーをそのまま使います！
          const otcKey = item.key;
          currentDetailData = { key: otcKey, isOtc: true, name: displayName, fullName: item.fullName || query, aiInfo: item.aiInfo, kataQuery: item.kataQuery };
          
          let infoHtml = item.aiInfo || "";
          
          infoHtml = infoHtml.replace(/(?:対象|薬品名)[:：]\\s*([^\\n]+)/, function(match, name) {
              return '<div style="font-weight:bold; color:#d63384; margin-bottom:8px; border-bottom:1px dashed #ffd1dc; padding-bottom:4px;">薬品名： ' + name.trim() + '</div>';
          });
          infoHtml = infoHtml.replace(/切替候補[:：]\\s*([^\\n]+)/, function(match, kw) {
            var cleanKw = kw.trim().replace(/['"]/g, "");
            return '主成分：<span style="font-weight:bold; color:#0056b3;">' + cleanKw + '</span> <button onclick="closeModal(); searchAlt(\\'' + cleanKw + '\\')" style="background:var(--main-orange);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;margin-left:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);font-weight:bold;vertical-align:middle;">🔍 主成分で切替検索</button>';
          });
          
          const searchKw = item.kataQuery || query;
          const isFav = isFavorite(otcKey);

          document.getElementById('modalContent').innerHTML = \`
            <div id="favStar" onclick="toggleFav()" style="display:inline-flex; align-items:center; gap:6px; cursor:pointer; margin-bottom:8px; padding:4px 8px 4px 0; user-select:none;" title="お気に入りに登録/解除">
              \${isFav ? '<span style="font-size:28px; line-height:1; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.1));">⭐️</span> <span style="color:gray; font-size:11pt; font-weight:bold; line-height:1;">お気に入り済</span>' 
                      : '<span style="color:#eed25c; font-size:34px; font-weight:bold; line-height:1; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.1));">☆</span> <span style="color:gray; font-size:11pt; font-weight:bold; line-height:1;">お気に入り追加</span>'}
            </div>
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
              <h3 style="color:#e83e8c; margin: 0 15px 0 0; font-size:20px; flex:1; line-height:1.4; word-break: break-word;">🛒 \${displayName}</h3>
            </div>
            <p style="font-weight:bold; font-size:15px; margin-top:0; margin-bottom:15px; color:#888">
              市販薬のAI推測結果カニ🦀
            </p>
            <div style="font-size:14px; background:#fff0f5; padding:12px; border-radius:10px; margin-bottom:12px; line-height:1.6; white-space:pre-wrap; border: 1px solid #ffd1dc;">\${infoHtml}</div>
            <div class="btn-group"><a href="https://www.google.com/search?q=\${encodeURIComponent(searchKw + ' 医療用 同成分')}" class="btn btn-google" target="_blank" style="display:flex;">🔍 Googleで処方薬を探す</a></div>
            \${promoHTML}
              <div style="margin-top:20px; text-align:center;">
                <a href="https://medikani.com/info" target="_blank" style="display:inline-block; width:100%; background:#e3f2fd; color:#0056b3; padding:12px; border-radius:12px; text-decoration:none; font-weight:bold; border:1px solid #bbdefb; box-sizing:border-box;">ℹ️ 公式サイトで詳しく見る</a>
              </div>
              \${combinedPromoHTML}
            \`;
          document.getElementById('modalOverlay').style.display = 'flex';
        }

        // === 新規追加: 報告モーダルの制御 ===
        function openReportModal(yj, fullName) {
          currentReportYj = yj;
          currentReportName = fullName;
          document.getElementById('reportDrugNameLabel').innerText = fullName;
          document.getElementById('reportComment').value = '';
          const savedName = localStorage.getItem('yakumiru_reporter_name');
          if (savedName) document.getElementById('reportName').value = savedName;
          document.getElementById('reportModalOverlay').style.display = 'flex';
        }
        function closeReportModal(e) {
          if (e && e.target.id !== 'reportModalOverlay') return;
          document.getElementById('reportModalOverlay').style.display = 'none';
        }
        async function submitReport() {
          const comment = document.getElementById('reportComment').value.trim();
          const name = document.getElementById('reportName').value.trim();
          const type = document.querySelector('input[name="repType"]:checked').value;
          
          if (!comment) { alert("内容を入力してくださいカニ🦀"); return; }
          
          const btn = document.getElementById('btnSubmitReport');
          btn.disabled = true;
          btn.innerText = "送信中...💦";
          
          if (name) localStorage.setItem('yakumiru_reporter_name', name);

          try {
            const res = await fetch(\`/api/report?h=\${hId}\`, {
              method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ yj: currentReportYj, drugName: currentReportName, type, comment, name })
            });
            if ((await res.json()).success) {
              alert("現場からの報告ありがとうございました！🦀✨");
              closeReportModal();
            } else {
              alert("エラーが発生しましたカニ🦀💦");
            }
          } catch(e) {
            alert("通信エラーが発生しましたカニ🦀💦");
          }
          btn.disabled = false;
          btn.innerText = "🚀 報告を送信する";
        }
        // === 新規追加: 報告モーダルの制御 (ここまで) ===

        async function showDetail(key) {
          document.getElementById('modalContent').innerHTML = '<p style="text-align:center;padding:30px;font-weight:bold;color:#ff9d00;">🦀 メディカニくんが詳細を開いています... 💦</p>';
          document.getElementById('modalOverlay').style.display = 'flex';
          try {
            const res = await fetch(\`/api/detail?key=\${encodeURIComponent(key)}&h=\${hId}\`);
            const d = await res.json();
            if (d.error) {
              document.getElementById('modalContent').innerHTML = \`<p style="text-align:center;padding:20px;color:#dc3545;font-weight:bold;">⚠️ データの取得に失敗しましたカニ🦀💦<br><span style="font-size:12px;">\${d.error}</span></p>\`;
              return;
            }
            currentDetailData = d;
            saveHistory(key, d);
            const mUrl = d.yj ? \`https://medley.life/medicines/prescription/\${d.yj}/#effect\` : "https://medley.life/";
            const gUrl = \`https://www.google.com/search?q=\${encodeURIComponent(d.fullName)}\`;
            const isNarcotic = d.yj && d.yj.startsWith('8');
            const isFav = isFavorite(key);
            const commentHTML = d.comment ? \`
              <div style="background:#fff0f5; color:#d63384; padding:14px; border-radius:12px; margin-bottom:15px; font-weight:bold; border: 1px solid #ffcdd2; box-shadow: 0 2px 8px rgba(214,51,132,0.1);">
                📝 メモ
                <span style="font-size:14px; color:#444; font-weight:normal; display:block; margin-top:6px; line-height:1.5;">\${d.comment}</span>
              </div>
            \` : '';

            // ===== 🌟追加: PMDAの効能・用法を綺麗にデザインして表示するHTMLを作る =====
            // 修正: サーバー側ですでに <br> に変換済みなので、ここでは出力するだけにします！
            const pmdaHTML = (d.pmdaEfficacy || d.pmdaUsage || d.pmdaContra) ? \`
              <div style="background:#f8f9fa; border:1px solid #dee2e6; border-radius:12px; padding:15px; margin-bottom:12px; font-size:13px; line-height:1.6; color:#333;">
                \${d.pmdaEfficacy ? \`
                <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:4px;">
                  <div style="color:#0056b3; font-weight:bold;">💊 効能・効果</div>
                  \${d.pmdaLastUpdated ? \`<div style="font-size:11px; color:#888; font-weight:normal;">🗒️最終更新日：\${d.pmdaLastUpdated}</div>\` : ''}
                </div>
                <div style="margin-bottom:12px;">\${d.pmdaEfficacy}</div>
                \` : ''}
                \${d.pmdaUsage ? \`<div style="color:#28a745; font-weight:bold; margin-bottom:4px;">🕒 用法・用量</div><div style="margin-bottom:12px;">\${d.pmdaUsage}</div>\` : ''}
                \${d.pmdaContra ? \`<div style="color:#d63384; font-weight:bold; margin-bottom:4px;">🚫 禁忌</div><div>\${d.pmdaContra}</div>\` : ''}
              </div>
              <div style="background:#fff8e1; border:1px solid #ffe082; border-radius:8px; padding:10px 12px; margin-bottom:12px; font-size:11px; line-height:1.5; color:#8a6d3b;">
                ⚠️ 本要約はAIが生成した参考情報であり、正確性を保証するものではありません。実際の使用にあたっては、必ず最新の添付文書をご確認ください。
              </div>
              \${(d.yj && d.yj !== "NONE") ? \`
              <a href="https://www.pmda.go.jp/PmdaSearch/rdSearch/02/\${d.yj}?user=1" target="_blank" style="display:flex; align-items:center; justify-content:center; gap:6px; width:100%; padding:14px; background:#fff0f5; border:2px solid #d63384; color:#d63384; border-radius:12px; text-decoration:none; font-weight:bold; font-size:14px; box-sizing:border-box; margin-bottom:15px; box-shadow:0 2px 4px rgba(214,51,132,0.1);">
                📄 添付文書等のお薬詳細を見る 🔍
              </a>\` : ''}
            \` : '';
            // ===== 🌟変更: 生テキストの詳細アコーディオンは廃止（著作権対策でAI要約＋PMDA公式リンクに一本化） =====
            // 詳細はPMDA公式サイトへのリンク（pmdaHTML内に設置済み）へ誘導する方針に変更。
            // ※旧データ(warnings付き)が万一残っていても表示しないよう、ここは常に空にする。
            let pmdaDetailHTML = '';
           
            // 薬品名をエスケープ（シングルクォーテーション等でのJSエラー防止）
            const safeDrugName = d.fullName.replace(/'/g, "\\\\'");

            document.getElementById('modalContent').innerHTML = \`
              <div id="favStar" onclick="toggleFav()" style="display:inline-flex; align-items:center; gap:6px; cursor:pointer; margin-bottom:8px; padding:4px 8px 4px 0; user-select:none;" title="お気に入りに登録/解除">
                \${isFav ? '<span style="font-size:28px; line-height:1; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.1));">⭐️</span> <span style="color:gray; font-size:11pt; font-weight:bold; line-height:1;">お気に入り済</span>' 
                        : '<span style="color:#eed25c; font-size:34px; font-weight:bold; line-height:1; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.1));">☆</span> <span style="color:gray; font-size:11pt; font-weight:bold; line-height:1;">お気に入り追加</span>'}
              </div>
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                <h3 style="color:#0056b3; margin: 0 15px 0 0; font-size:20px; flex:1; line-height:1.4; word-break: break-word;">
                  \${getFormEmoji(d.yj, d.label)} \${d.fullName}
                  \${d.price && d.price !== '-' ? \`<span style="font-size:16px; color:#333; background:#fff3cd; padding:4px 8px; border-radius:8px; vertical-align:middle; margin-left:8px; border:1px solid #ffe69c; white-space:nowrap;"><span style="color:#e65100;">￥</span>\${d.price}</span>\` : ''}
                </h3>
              </div>
              <p style="font-weight:bold; font-size:15px; margin-top:0; margin-bottom:15px; color:\${d.isAdopted?'#28a745':'#888'}">
                \${d.isBrand ? '<span class="tag blue" style="margin-right:5px;">先</span>' : ''}
                \${isNarcotic ? '<span class="tag red" style="margin-right:5px;">麻</span>' : ''}
                \${d.isAdopted?'🏥 採用薬ですカニ！🦀':'🏠 未採用のお薬ですカニ🦀'}
              </p>
              \${commentHTML}
              \${pmdaHTML}
              \${pmdaDetailHTML}
              \${hId ? \`<button onclick="openReportModal('\${d.yj}', '\${safeDrugName}')" style="width:100%; padding:10px; background:#fff; border:1px solid #dc3545; border-radius:8px; color:#dc3545; margin-bottom:15px; font-size:13px; font-weight:bold; cursor:pointer; box-shadow:0 2px 4px rgba(220,53,69,0.1);">🚨 現場の知見を報告する / 採用漏れ申請</button>\` : ''}
              <div class="btn-group"><a href="\${mUrl}" class="btn btn-medley" target="_blank">📘 メドレー</a><a href="\${gUrl}" class="btn btn-google" target="_blank">🔍 Google</a></div>
              <hr style="border:none; border-top:1px dashed #ccc; margin:15px 0;">
              <p style="font-weight:bold; font-size:14px; margin-bottom:12px; color:#555;">🔄 同成分・切替候補カニ🦀</p>
              \${d.alts && d.alts.length ? d.alts.map(a => {
               const aIsNarcotic = a.yj && a.yj.startsWith('8');
                return \`
                <a href="#" onclick="showDetail('\${a.key}'); return false;" class="alt-item \${a.isAdopted?'adopted':''}">
                  <div style="display:flex; flex-direction:column; gap:6px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                      <span style="font-weight:bold; line-height:1.3;">\${getFormEmoji(a.yj, a.key)} \${a.name} <span style="font-weight:normal;color:#666;font-size:11px;">\${a.spec}</span></span>
                      <span style="font-weight:bold;color:\${a.isAdopted?'#28a745':'#aaa'}; white-space:nowrap; margin-left:8px;">
                        \${a.isAdopted?'🏥 採用':''} ❯
                      </span>
                    </div>
                    <div style="display:flex; gap:4px; align-items:center;">
                       \${a.isBrand ? '<span class="tag blue" style="font-size:10px; padding:2px 6px;">先</span>' : ''}
                       \${aIsNarcotic ? '<span class="tag red" style="font-size:10px; padding:2px 6px;">麻</span>' : ''}
                       \${a.price && a.price !== '-' ? '<span class="tag" style="background:#fff3cd;color:#333;border:1px solid #ffe69c;font-size:10px; padding:2px 6px;"><span style="color:#e65100;">￥</span>' + a.price + '</span>' : ''}
                    </div>
                  </div>
                </a>\`}).join('') : '<p style="font-size:13px; color:#999; text-align:center; padding:10px 0;">見つかりませんでしたカニ🦀💦</p>'}
              \${promoHTML}
              <div style="margin-top:20px; text-align:center;">
                <a href="https://medikani.com/info" target="_blank" style="display:inline-block; width:100%; background:#e3f2fd; color:#0056b3; padding:12px; border-radius:12px; text-decoration:none; font-weight:bold; border:1px solid #bbdefb; box-sizing:border-box;">ℹ️ 公式サイトで詳しく見る</a>
              </div>
              \${!hId ? \`<a href="/HPTEST1" style="display:block; margin-top:15px; text-align:center; padding:15px; background:#fff0f5; border-radius:12px; border:1px dashed #ffb6c1; cursor:pointer; text-decoration:none; transition: opacity 0.2s;"><span style="color:#d63384;font-weight:bold;font-size:13px;">🦀メディカニ・プラスは採用薬が切替候補に出るカニ💚</span><br><span style="color:#fff;background:#e83e8c;font-size:14px;text-decoration:none;margin-top:10px;padding:10px 20px;border-radius:25px;display:inline-block;font-weight:bold;box-shadow:0 4px 6px rgba(232,62,140,0.3);">✨ プラス体験はこちら ✨</span></a>\` : ''}
            \`;
          } catch(e) {
            document.getElementById('modalContent').innerHTML = '<p style="text-align:center;padding:20px;color:#dc3545;font-weight:bold;">⚠️ 詳細を開けませんでしたカニ🦀💦</p>';
          }
        }
        function closeModal(e) { 
          if (e && e.target.id !== 'modalOverlay') return;
          document.getElementById('modalOverlay').style.display = 'none'; 
        }
      </script></body></html>`;
  },

getDashboardHTML(env, hospitalId, hospitalName = "") {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦀</text></svg>">
    <link rel="icon" type="image/png" sizes="512x512" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
    <link rel="apple-touch-icon" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani-icon.png">
<title>メディカニ・プラス 管理画面🦀</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/encoding-japanese/2.0.0/encoding.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
    <style>
      :root { --main-blue: #0056b3; --bg: #f4f7f6; }
      body { font-family: sans-serif; background: var(--bg); margin: 0; padding: 0; color: #333; }
      .header { background: var(--main-blue); color: #fff; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
      .header h1 { margin: 0; font-size: 18px; display: flex; align-items: center; gap: 8px; }
      .container { max-width: 800px; margin: 20px auto; padding: 0 15px; }
      .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
      .card h2 { margin-top: 0; font-size: 16px; color: var(--main-blue); border-bottom: 2px solid #eee; padding-bottom: 10px; margin-bottom: 15px; display: flex; align-items: center; gap: 8px; }
      .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 10px; }
      .stat-box { background: #e3f2fd; padding: 15px; border-radius: 8px; text-align: center; }
      .stat-box .num { font-size: 24px; font-weight: bold; color: var(--main-blue); margin: 5px 0; }
      .stat-box .label { font-size: 12px; color: #555; }
      .dropzone { display: block; width: 100%; box-sizing: border-box; border: 2px dashed #bbb; border-radius: 10px; padding: 30px; text-align: center; background: #fafafa; cursor: pointer; transition: background 0.2s; }
      .dropzone:hover { background: #f0f0f0; }
      .dropzone input[type="file"] { display: none; }
      .mapping-area { display: none; margin-top: 20px; background: #fdfdfd; padding: 15px; border-radius: 8px; border: 1px solid #ddd; }
      .map-row { display: flex; flex-direction: column; margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px dashed #eee; }
      .map-row label { font-size: 14px; font-weight: bold; color: #444; margin-bottom: 6px; }
      .map-row select { width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #ccc; font-size: 14px; box-sizing: border-box; }
      .preview-area { display: none; margin-top: 20px; }
      .preview-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
      .preview-table th, .preview-table td { border: 1px solid #ddd; padding: 8px; text-align: left; }
      .preview-table th { background: #f4f4f4; color: #555; }
      .btn { display: inline-block; width: 100%; padding: 14px; background: #28a745; color: #fff; font-size: 16px; font-weight: bold; text-align: center; border: none; border-radius: 8px; cursor: pointer; margin-top: 15px; box-shadow: 0 4px 6px rgba(40,167,69,0.2); transition: transform 0.1s; }
      .btn:active { transform: scale(0.98); }
      .btn:disabled { background: #ccc; cursor: not-allowed; box-shadow: none; }
      #uploadMsg { margin-top: 10px; font-size: 14px; font-weight: bold; text-align: center; display: none; }
      
      /* 新規: 管理画面用薬品リスト */
      .admin-item-list { margin-top: 20px; border-top: 1px solid #eee; }
      .admin-item { padding: 12px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; font-size: 14px; }
      .admin-item-info { flex: 1; }
      .admin-item-actions { display: flex; gap: 8px; }
      .btn-small { padding: 6px 12px; font-size: 12px; border-radius: 4px; cursor: pointer; border: none; font-weight: bold; }
      .btn-edit { background: #007bff; color: #fff; }
      .btn-delete { background: #dc3545; color: #fff; }
      .btn-done { background: #17a2b8; color: #fff; }
      .report-item.done { opacity: 0.5; background: #f9f9f9; }

/* === ポスター印刷用スタイル === */
      @media print {
        @page { margin: 0; }
        /* 上30mm、左右下20mmの余白に設定 */
        body { background: #fff !important; margin: 30mm 20mm 20mm; }
        .header, .container, #adminEditModal, #adminAddModal { display: none !important; }
        #printArea { display: block !important; position: absolute; left: 0; top: 0; width: 100%; padding: 0; }
      }
      #printArea { display: none; text-align: center; color: #000; font-family: sans-serif; }
      /* margin-top: 20px; を追加してさらにロゴ上のスペースを確保 */
      .poster-logo { height: 150px; margin-top: 20px; margin-bottom: 10px; }
      .poster-title { font-size: 28px; font-weight: bold; border-bottom: 3px solid #000; padding-bottom: 15px; margin-bottom: 30px; }
      .poster-desc { font-size: 18px; line-height: 1.6; margin-bottom: 30px; font-weight: bold; }
      .poster-box { border: 4px solid #000; border-radius: 15px; padding: 30px; max-width: 650px; margin: 0 auto 30px; display: flex; align-items: center; justify-content: center; gap: 40px; }
      .poster-qr { width: 160px; height: 160px; }
      .poster-box-text { font-size: 22px; font-weight: bold; text-align: left; line-height: 1.5; }
      .poster-freetext { font-size: 16px; line-height: 1.6; border: 2px dashed #000; padding: 25px; border-radius: 10px; max-width: 650px; margin: 0 auto; text-align: left; white-space: pre-wrap; font-weight: bold; }
    </style></head>
    <body>
      <div class="header">
        <h1>🏥 メディカニ・プラス 管理画面</h1>
        <div style="text-align:right; display:flex; flex-direction:column; align-items:flex-end; gap:5px;">
          <div style="font-size:12px; background:rgba(255,255,255,0.2); padding:4px 10px; border-radius:15px; text-align:right;">
            ${hospitalName ? `<div style="font-weight:bold; margin-bottom:2px;">${hospitalName}</div>` : ''}
            ID: ${hospitalId}
          </div>
          <div style="display:flex; gap:8px;">
            <a href="https://medikani.com/manual" target="_blank" style="color:#0056b3; font-size:12px; text-decoration:none; background:#e3f2fd; padding:4px 12px; border-radius:15px; font-weight:bold; border:1px solid #bbdefb;">📘 管理画面マニュアル</a>
            <a href="/${hospitalId}/admin/logout" style="color:#fff; font-size:12px; text-decoration:none; background:#dc3545; padding:4px 12px; border-radius:15px; font-weight:bold; border:1px solid #c82333;">🚪 ログアウト</a>
          </div>
        </div>
      </div>
      <div class="container">
        
        <div class="card" style="border-top: 4px solid #dc3545;">
          <h2>🚨 現場からの報告一覧</h2>
          <p style="font-size:12px; color:#666; margin-bottom:10px;">スタッフから送信されたメモの修正依頼や採用薬の追加要望です。<br>確認が終わったら「済」を押してください。3ヶ月経過で自動削除されます。</p>
          <a href="/api/admin/download-reports?h=${hospitalId}" class="btn" style="background:#dc3545; padding:8px; font-size:13px; margin-top:0; margin-bottom:15px; display:inline-block; width:auto;">⬇️ 報告一覧CSVダウンロード</a>
          <div id="reportList" class="admin-item-list" style="max-height:400px; overflow-y:auto; border-top:none; margin-top:0;">
            <p style="text-align:center; color:#999; font-size:13px; padding:15px;">読み込み中...🦀</p>
          </div>
        </div>

        <div class="card">
          <h2>📊 現在のステータス</h2>
          <div class="stat-grid">
            <div class="stat-box"><div class="label">採用薬 登録件数</div><div class="num" id="metaCount">--</div></div>
            <div class="stat-box"><div class="label">最終更新日時</div><div class="num" id="metaDate" style="font-size:16px; margin-top:12px;">確認中...</div></div>
          </div>
          <a href="/api/admin/download?h=${hospitalId}" class="btn" style="background:#17a2b8; margin-top:10px; display:flex; align-items:center; justify-content:center; gap:8px; text-decoration:none;">⬇️ 現在の採用薬CSVをダウンロード</a>
        </div>

        <!-- ===== 🌟新規追加: メディカニレーダーのウィンドウ ===== -->
        <div class="card" style="border-top: 4px solid #8e44ad;">
          <h2>📡 メディカニレーダー</h2>
          <p style="font-size:12px; color:#666; margin-bottom:15px;">現在登録されている重要な添付文書の更新を検知しますカニ🦀※テスト運用</p>
          <button id="btnRunRadar" onclick="runMedikaniRadar()" class="btn" style="background:#8e44ad; margin-top:0;">📡 レーダーを起動する</button>
          <div id="radarResults" style="margin-top:15px; display:none;"></div>
        </div>
        <div class="card">
          <h2>✏️ 個別編集（修正・削除）</h2>
          <p style="font-size:12px; color:#666; margin-bottom:10px;">採用中の薬品を検索して修正・削除ができますカニ🦀</p>
          <div style="display:flex; gap:8px;">
            <input type="text" id="adminSearchQ" placeholder="採用薬を検索..." style="flex:1; padding:10px; border:1px solid #ccc; border-radius:8px;" onkeydown="if(event.key==='Enter') adminSearch()">
            <button onclick="adminSearch()" style="padding:10px 20px; background:var(--main-blue); color:#fff; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">検索</button>
          </div>
          <div id="adminSearchResults" class="admin-item-list"></div>
        </div>

        <div class="card" style="border-top: 4px solid #28a745;">
          <h2>➕ 個別追加</h2>
          <p style="font-size:12px; color:#666; margin-bottom:10px;">未採用の薬（マスターデータ）を検索して、採用薬に追加できますカニ🦀</p>
          <div style="display:flex; gap:8px;">
            <input type="text" id="adminAddSearchQ" placeholder="未採用薬を検索..." style="flex:1; padding:10px; border:1px solid #ccc; border-radius:8px;" onkeydown="if(event.key==='Enter') adminAddSearch()">
            <button onclick="adminAddSearch()" style="padding:10px 20px; background:#28a745; color:#fff; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">検索</button>
          </div>
          <div id="adminAddSearchResults" class="admin-item-list"></div>
        </div>

        <div id="adminEditModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:2000; justify-content:center; align-items:center;">
          <div style="background:#fff; width:90%; max-width:400px; padding:25px; border-radius:15px; position:relative;">
            <h3 id="editTitle" style="margin-top:0; color:var(--main-blue);">メモの編集</h3>
            <p id="editDrugName" style="font-size:13px; font-weight:bold; margin-bottom:15px; color:#555;"></p>
            <textarea id="editMemo" style="width:100%; height:100px; padding:10px; border:1px solid #ccc; border-radius:8px; box-sizing:border-box; font-family:sans-serif; margin-bottom:15px;"></textarea>
            <div style="display:flex; gap:10px;">
              <button onclick="saveAdminComment()" id="btnSaveAdmin" style="flex:1; padding:12px; background:#28a745; color:#fff; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">保存する</button>
              <button onclick="closeAdminEdit()" style="flex:1; padding:12px; background:#eee; color:#333; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">キャンセル</button>
            </div>
          </div>
        </div>

        <div id="adminAddModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:2000; justify-content:center; align-items:center;">
          <div style="background:#fff; width:90%; max-width:400px; padding:25px; border-radius:15px; position:relative;">
            <h3 style="margin-top:0; color:#28a745;">採用薬の追加</h3>
            <p id="addDrugName" style="font-size:13px; font-weight:bold; margin-bottom:15px; color:#555;"></p>
            <label style="font-size:12px; font-weight:bold; color:#666; margin-bottom:5px; display:block;">メモ (任意)</label>
            <textarea id="addMemo" style="width:100%; height:100px; padding:10px; border:1px solid #ccc; border-radius:8px; box-sizing:border-box; font-family:sans-serif; margin-bottom:15px;"></textarea>
            <div style="display:flex; gap:10px;">
              <button onclick="saveAdminAdd()" id="btnSaveAdd" style="flex:1; padding:12px; background:#28a745; color:#fff; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">追加する</button>
              <button onclick="closeAdminAdd()" style="flex:1; padding:12px; background:#eee; color:#333; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">キャンセル</button>
            </div>
          </div>
        </div>

        <div id="boardEditModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:2000; justify-content:center; align-items:center;">
          <div style="background:#fff; width:90%; max-width:400px; padding:25px; border-radius:15px; position:relative;">
            <h3 style="margin-top:0; color:#28a745;">お知らせの編集</h3>
            <textarea id="editBoardMessage" style="width:100%; height:120px; padding:10px; border:1px solid #ccc; border-radius:8px; box-sizing:border-box; font-family:sans-serif; margin-bottom:15px;"></textarea>
            <div style="display:flex; gap:10px;">
              <button onclick="saveBoardEdit()" id="btnSaveBoard" style="flex:1; padding:12px; background:#28a745; color:#fff; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">保存する</button>
              <button onclick="closeBoardEdit()" style="flex:1; padding:12px; background:#eee; color:#333; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">キャンセル</button>
            </div>
          </div>
        </div>

        <div class="card">
          <h2>📥 CSV/Excelデータのアップロード</h2>
          <p style="font-size:12px; color:#666; margin-bottom:15px;">一括更新はこちら。フル更新と追加更新が出来るよ🦀</p>
          <label class="dropzone" id="dropzone">
            <div style="font-size:24px; margin-bottom:10px;">📄</div>
            <div style="font-size:14px; color:#555; font-weight:bold;">CSVまたはExcelファイルをタップして選択</div>
            <input type="file" id="csvFile" accept=".csv, .xlsx, .xls">
          </label>
          <div class="mapping-area" id="mappingArea">
            <h3 style="font-size:14px; color:#d63384; margin-top:0;">🔀 列の紐付け（自動選択）</h3>
            <div class="map-row"><label>💊 薬品名 (必須)</label><select id="mapName"></select></div>
            <div class="map-row"><label>📦 規格</label><select id="mapSpec"></select></div>
            <div class="map-row"><label>🔑 YJコード (必須)</label><select id="mapYJ"></select></div>
            <div class="map-row"><label>💬 メモ</label><select id="mapC1"></select></div>
            <div class="map-row" style="background:#fff3cd; padding:10px; border-radius:6px; border:1px solid #ffe69c; border-bottom:none; margin-top:15px;">
              <label style="color:#856404; margin-bottom:0; cursor:pointer;"><input type="checkbox" id="chkFullSync"> 🗑️ フル同期カニ🦀</label>
            </div>
            <button class="btn" id="btnPreview" style="background:var(--main-blue); margin-top:15px;">👀 プレビュー</button>
          </div>
          <div class="preview-area" id="previewArea">
            <h3 style="font-size:14px; color:#28a745; border-bottom:1px solid #eee; padding-bottom:5px;">✅ プレビューカニ🦀</h3>
            <div id="previewStats"></div>
            <div style="overflow-x: auto;"><table class="preview-table" id="previewTable"><thead><tr><th>YJコード</th><th>薬品名</th><th>規格</th><th>メモ</th></tr></thead><tbody></tbody></table></div>
            <button class="btn" id="btnUpload">☁️ メディカニを更新する</button>
            <div id="uploadMsg"></div>
          </div>
        </div>

        <div class="card" style="border-top: 4px solid #28a745;">
          <h2>📢 掲示板（お知らせ）管理</h2>
          <p style="font-size:12px; color:#666; margin-bottom:10px;">検索画面のトップに表示されるお知らせを投稿できますカニ🦀</p>

          <div style="background:#f8f9fa; padding:10px; border-radius:8px; margin-bottom:10px; border:1px solid #eee;">
            <label style="font-size:12px; font-weight:bold; color:#666; margin-bottom:5px; display:block;">🔗 お薬リンクを挿入（本文にタグが入ります）</label>
            <div style="display:flex; gap:8px; margin-bottom:5px;">
              <input type="text" id="boardDrugSearchQ" placeholder="お薬を検索..." style="flex:1; padding:8px; border:1px solid #ccc; border-radius:6px;" onkeydown="if(event.key==='Enter') boardDrugSearch()">
              <button onclick="boardDrugSearch()" style="padding:8px 15px; background:var(--main-blue); color:#fff; border:none; border-radius:6px; font-weight:bold; cursor:pointer;">検索</button>
            </div>
            <div id="boardDrugSearchResults" class="admin-item-list" style="margin-top:0; border-top:none; max-height:150px; overflow-y:auto;"></div>
          </div>
          <textarea id="boardMessage" placeholder="お知らせ内容を入力してください..." style="width:100%; height:80px; padding:10px; border:1px solid #ccc; border-radius:8px; box-sizing:border-box; font-family:sans-serif; margin-bottom:10px;"></textarea>
          <button onclick="postBoard()" style="width:100%; padding:12px; background:#28a745; color:#fff; border:none; border-radius:8px; font-weight:bold; cursor:pointer; margin-bottom:20px; transition: transform 0.1s;">📢 投稿する</button>
          
          <h3 style="font-size:14px; color:#444; margin-top:0; border-bottom:1px dashed #ccc; padding-bottom:5px;">📋 過去のお知らせ</h3>
          <div id="boardList" class="admin-item-list" style="max-height:300px; overflow-y:auto;"></div>
        </div>

        <div class="card" style="border-top: 4px solid #ff9800;">
          <h2>🏆 よく見られているお薬（トップ10）</h2>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
            <div>
              <h3 style="font-size:14px; color:#555; border-bottom:1px solid #eee; padding-bottom:5px;">⭐️ お気に入り (全期間)</h3>
              <div id="favRankingList" style="font-size:13px; line-height:1.8; color:#444;">読込中...🦀</div>
            </div>
            <div>
              <h3 style="font-size:14px; color:#555; border-bottom:1px solid #eee; padding-bottom:5px;">👀 詳細表示 (直近30日)</h3>
              <div id="viewRankingList" style="font-size:13px; line-height:1.8; color:#444;">読込中...🦀</div>
            </div>
          </div>
        </div>

        <div class="card" style="border-top: 4px solid #17a2b8;">
          <h2>🖨️ 現場用ポスターの印刷</h2>
          <p style="font-size:12px; color:#666; margin-bottom:10px;">スタッフ周知用のQRコード付きポスターを印刷できます。<br>以下のメッセージを自由に書き換えてから印刷ボタンを押してくださいカニ🦀</p>
         <textarea id="posterInputText" style="width:100%; height:180px; padding:10px; border:1px solid #ccc; border-radius:8px; box-sizing:border-box; font-family:sans-serif; margin-bottom:10px;">スタッフの皆様へ
お手持ちのスマートフォンでQRコードを読み取ると、当施設の「採用薬」が優先して表示されるお薬検索アプリが使えるようになります！
処方薬からも市販薬からも検索可能です。
アプリのインストールやログインは不要です。ホーム画面に追加して今日からご活用くださ
い。
</textarea>
          <button onclick="printPoster()" style="width:100%; padding:12px; background:#17a2b8; color:#fff; border:none; border-radius:8px; font-weight:bold; cursor:pointer; transition: transform 0.1s; display:flex; align-items:center; justify-content:center; gap:8px;">🖨️ この内容でポスターを印刷する</button>
        </div>

        <div class="card" style="border-top: 4px solid #ff9d00;">
          <h2>🔑 パスワード変更</h2>
          <input type="password" id="changePwd" placeholder="新しいパスワードを入力カニ🦀" style="width:100%; padding:12px; border:1px solid #ccc; border-radius:8px; margin-bottom:15px; box-sizing:border-box; font-size:14px;">
          <button class="btn" id="btnChangePwd" style="background:#ff9d00; margin-top:0;">🔄 パスワードを変更</button>
          <div id="changeMsg" style="margin-top:15px; font-size:14px; font-weight:bold; text-align:center; display:none;"></div>
        </div>

        <div class="card" style="border-top: 4px solid #0056b3;">
          <h2>✉️ メールアドレス変更</h2>
          <p style="font-size:12px; color:#666; margin-bottom:15px;">現在登録中: <b id="currentEmail">確認中...</b></p>
          <input type="email" id="changeEmail" placeholder="新しいメールアドレスを入力カニ🦀" style="width:100%; padding:12px; border:1px solid #ccc; border-radius:8px; margin-bottom:15px; box-sizing:border-box; font-size:14px;">
          <button class="btn" id="btnChangeEmail" style="background:#0056b3; margin-top:0;">✉️ メールアドレスを変更</button>
          <div id="emailMsg" style="margin-top:15px; font-size:14px; font-weight:bold; text-align:center; display:none;"></div>
        </div>

        <div class="card" style="border-top: 4px solid #6f42c1;">
          <h2>🔐 ユーザー用パスワード設定</h2>
          <p style="font-size:12px; color:#666; margin-bottom:15px;">ここでパスワードを設定すると、スタッフが検索画面を利用する際に初回だけパスワード入力が必要になります。<br>空欄にして保存するとパスワードなし（今まで通り）に戻りますカニ🦀</p>
          <input type="text" id="changeUserPwd" placeholder="ユーザー用パスワード（未設定は空欄）" style="width:100%; padding:12px; border:1px solid #ccc; border-radius:8px; margin-bottom:15px; box-sizing:border-box; font-size:14px;">
          <button class="btn" id="btnChangeUserPwd" style="background:#6f42c1; margin-top:0;">🔐 ユーザーパスワードを保存</button>
          <div id="userPwdMsg" style="margin-top:15px; font-size:14px; font-weight:bold; text-align:center; display:none;"></div>
        </div>

        ${env.ASK_FORM_URL ? `
        <div class="card" style="border-top: 4px solid #6c757d;">
          <h2>📞 お問い合わせ</h2>
          <p style="font-size:12px; color:#666; margin-bottom:15px;">システムの不具合やご質問、ご要望、退会希望などはこちらからご連絡くださいカニ🦀</p>
          <a href="${env.ASK_FORM_URL}${env.ASK_FORM_URL.includes('?') ? '&' : '?'}${env.G_FORM_ID || ''}=${hospitalId}" target="_blank" class="btn" style="background:#6c757d; display:flex; align-items:center; justify-content:center; gap:8px; text-decoration:none; margin-top:0;">✉️ お問い合わせフォームを開く</a>
        </div>
        ` : ''}

        <div class="card" style="border-top: 4px solid #495057; display: none;">
          <h2>💳 契約変更・退会手続き</h2>
          <p style="font-size:12px; color:#666; margin-bottom:15px;">クレジットカード情報の変更や、メディカニ・プラスの解約（退会）はStripeの決済管理画面からお手続きできますカニ🦀</p>
          <a href="${env.STRIPE_PORTAL_URL || '#'}" target="_blank" class="btn" onclick="if(this.getAttribute('href')==='#'){alert('StripeポータルのURLが環境変数(STRIPE_PORTAL_URL)に設定されていませんカニ🦀'); return false;}" style="background:#495057; display:flex; align-items:center; justify-content:center; gap:8px; text-decoration:none; margin-top:0;">🚪 退会・変更はこちら</a>
        </div>

        <div style="text-align:center; margin-top:20px; margin-bottom:40px;"><a href="/${hospitalId}" style="color:#0056b3; font-weight:bold; text-decoration:none;">🌍 実際の検索画面へ戻る</a></div>
      </div>

      <div id="printArea">
        <img src="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/logo.png" class="poster-logo" alt="メディカニロゴ">
        <div class="poster-title">医薬品検索「メディカニ・プラス」導入のお知らせ</div>
        <div class="poster-desc">
          当施設専用の医薬品検索ツールがスマートフォンで使えるようになりました。<br>
          いつでもどこでも、施設の採用薬や代替薬をサクッと確認できます。
        </div>
        <div class="poster-box">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=https://medikani.com/${hospitalId}" class="poster-qr" alt="QRコード">
          <div class="poster-box-text">
            👈 スマホのカメラで<br>
            　 QRコードを読み取るだけ！<br>
            <span style="font-size:14px; font-weight:normal; margin-top:10px; display:block; color:#333;">URL: https://medikani.com/${hospitalId}</span>
          </div>
        </div>
        <div class="poster-freetext" id="posterOutputText"></div>
      </div>

      <script>
        const hId = "${hospitalId}";
        let currentEditKey = "";

        // === 新規追加: ポスター印刷機能 ===
        function printPoster() {
          const text = document.getElementById('posterInputText').value;
          document.getElementById('posterOutputText').innerText = text;
          window.print();
        }

        // ===== 🌟新規追加: メディカニレーダーの処理 =====
        async function runMedikaniRadar() {
          const btn = document.getElementById('btnRunRadar');
          const resDiv = document.getElementById('radarResults');
          
          // 連打防止のためにボタンを無効化してメッセージを変える
          btn.disabled = true;
          btn.innerText = "📡 レーダー探索中...💦";
          resDiv.style.display = "block";
          resDiv.innerHTML = "<p style='text-align:center; color:#888; font-weight:bold;'>GASと通信中カニ...🦀🔍<br>しばらくお待ちください</p>";

          try {
            // 【1ヶ所目】で作ったAPI窓口を叩く
            const res = await fetch('/api/admin/radar?h=' + hId, { method: 'POST' });
            const data = await res.json();
            
            if (data.success) {
              // GASが作成したHTML結果をそのまま画面の箱に流し込む
              resDiv.innerHTML = data.html || "<p style='color:#28a745; font-weight:bold;'>✅ 異常は検知されませんでしたカニ！🦀</p>";
            } else {
              resDiv.innerHTML = "<p style='color:#dc3545; font-weight:bold;'>❌ レーダーエラー:<br>" + (data.error || "不明なエラー") + "</p>";
            }
          } catch(e) {
            resDiv.innerHTML = "<p style='color:#dc3545; font-weight:bold;'>⚠️ 通信エラーが発生したカニ🦀💦<br>詳細: " + e.message + "</p>";
          }
          
          // 終わったらボタンを元に戻す
          btn.disabled = false;
          btn.innerText = "📡 レーダーを再起動する";
        }
        // ===============================================

        // === 新規追加: 報告リストの読み込み ===
        function loadReports() {
          fetch('/api/admin/reports?h=' + hId).then(r=>r.json()).then(data => {
            const list = document.getElementById('reportList');
            if(!data || data.length === 0) {
              list.innerHTML = '<p style="padding:15px; font-size:13px; color:#999;">報告はまだありませんカニ🦀</p>';
              return;
            }
            list.innerHTML = data.map(r => {
              const dt = new Date(r.timestamp);
              const dateStr = dt.toLocaleDateString('ja-JP') + ' ' + dt.toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit'});
              return \`
                <div class="admin-item report-item \${r.isDone ? 'done' : ''}" style="flex-direction:column; align-items:flex-start; border:1px solid #eee; margin-bottom:10px; border-radius:8px; padding:15px;">
                  <div style="display:flex; justify-content:space-between; width:100%; margin-bottom:8px;">
                    <span style="font-size:12px; font-weight:bold; color:#dc3545; background:#ffebeb; padding:2px 8px; border-radius:4px;">\${r.type}</span>
                    <span style="font-size:11px; color:#888;">\${dateStr}</span>
                  </div>
                  <div style="font-size:14px; font-weight:bold; color:#333; margin-bottom:4px;">\${r.drugName} <span style="font-size:11px; font-weight:normal; color:#666;">(\${r.yj || 'YJ未取得'})</span></div>
                  <div style="font-size:13px; background:#fff; border:1px dashed #ccc; padding:10px; border-radius:6px; width:100%; box-sizing:border-box; margin-bottom:8px; white-space:pre-wrap;">\${r.comment}</div>
                  <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
                    <span style="font-size:12px; color:#555;">🧑‍⚕️ 報告者: <b>\${r.name}</b></span>
                    \${r.isDone ? '<span style="font-size:12px; font-weight:bold; color:#17a2b8;">✅ 確認済</span>' : \`<button class="btn-small btn-done" onclick="markReportDone('\${r.key}')">確認済にする</button>\`}
                  </div>
                </div>
              \`;
            }).join('');
          });
        }
        
        async function markReportDone(key) {
          if (!confirm('この報告を「済」にしますか？')) return;
          const res = await fetch('/api/admin/report-done?h=' + hId, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ key })
          });
          if ((await res.json()).success) { loadReports(); }
        }
        loadReports();
        // === 新規追加: 報告リストの読み込み (ここまで) ===
// === 新規追加: ランキング読み込み (ここから) ===
        function loadRankings() {
          fetch('/api/admin/ranking?h=' + hId).then(r=>r.json()).then(data => {
            const fList = document.getElementById('favRankingList');
            const vList = document.getElementById('viewRankingList');
            
            fList.innerHTML = (!data.favRank || data.favRank.length === 0) 
              ? '<span style="color:#999;">データなし🦀</span>' 
              : data.favRank.map((r, i) => '<div><b style="color:#ff9800;">' + (i+1) + '位</b>: ' + r.name + ' <span style="color:#888;font-size:11px;">(' + r.count + ')</span></div>').join('');
            
            vList.innerHTML = (!data.viewRank || data.viewRank.length === 0) 
              ? '<span style="color:#999;">データなし🦀</span>' 
              : data.viewRank.map((r, i) => '<div><b style="color:#ff9800;">' + (i+1) + '位</b>: ' + r.name + ' <span style="color:#888;font-size:11px;">(' + r.count + '回)</span></div>').join('');
          }).catch(e => {
            document.getElementById('favRankingList').innerHTML = 'エラー🦀';
            document.getElementById('viewRankingList').innerHTML = 'エラー🦀';
          });
        }
        loadRankings();
        // === 新規追加: ランキング読み込み (ここまで) ===
        

        fetch('/api/admin/meta?h=' + hId).then(r=>r.json()).then(d => {
          document.getElementById('metaCount').innerText = d.count || 0;
          if(d.lastUpdated) {
            const dt = new Date(d.lastUpdated);
            document.getElementById('metaDate').innerText = dt.toLocaleDateString('ja-JP') + ' ' + dt.toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit'});
          } else { document.getElementById('metaDate').innerText = '未登録'; }
          document.getElementById('currentEmail').innerText = d.email || '未登録';
          document.getElementById('changeUserPwd').value = d.userPwd || '';
        });

        // 管理画面用検索（個別編集用：採用薬のみ）
        async function adminSearch() {
          const q = document.getElementById('adminSearchQ').value.trim();
          if(!q) return;
          const list = document.getElementById('adminSearchResults');
          list.innerHTML = '<p style="padding:15px; font-size:13px; color:#999;">検索中...🦀</p>';
          const res = await fetch(\`/api/search?c=all&q=\${encodeURIComponent(q)}&h=\${hId}\`);
          const data = await res.json();
          const adoptedData = data.filter(i => i.isAdopted);
          if(!adoptedData.length) { list.innerHTML = '<p style="padding:15px; font-size:13px; color:#999;">採用薬が見つかりませんでしたカニ🦀</p>'; return; }
      // 👇修正: 通常の検索結果と同じように、先発・薬価・成分名・規格をリッチに表示！
      list.innerHTML = adoptedData.map(i => \`
        <div class="admin-item" style="align-items:flex-start;">
          <div class="admin-item-info" style="line-height:1.5;">
            <b style="font-size:15px; color:#333;">\${i.name}</b>
            <div style="display:flex; gap:4px; margin:4px 0; flex-wrap:wrap; align-items:center;">
              \${i.isBrand ? '<span class="tag blue" style="font-size:10px; padding:2px 6px;">先発</span>' : ''}
              \${i.price && i.price !== '-' ? '<span class="tag" style="background:#fff3cd;color:#333;border:1px solid #ffe69c;font-size:10px; padding:2px 6px;"><span style="color:#e65100;">￥</span>' + i.price + '</span>' : ''}
              \${i.component ? '<span style="font-size:11px; color:#0056b3; background:#e3f2fd; padding:2px 6px; border-radius:4px; border:1px solid #bbdefb;">🧬 ' + i.component + '</span>' : ''}
            </div>
            <div style="font-size:12px; color:#666;">📦 \${i.spec} \${i.type ? '/ ' + i.type : ''}</div>
          </div>
          <div class="admin-item-actions" style="display:flex; flex-direction:column; gap:6px;">
            <button class="btn-small btn-edit" onclick="openAdminEdit('\${i.key.replace(/'/g, "\\\\'")}', '\${i.name.replace(/'/g, "\\\\'")}')">編集</button>
            <button class="btn-small btn-delete" onclick="adminDeleteItem('\${i.key.replace(/'/g, "\\\\'")}')">削除</button>
          </div>
        </div>
      \`).join('');
    }

        // 管理画面用検索（個別追加用：未採用マスターのみ）
        async function adminAddSearch() {
          const q = document.getElementById('adminAddSearchQ').value.trim();
          if(!q) return;
          const list = document.getElementById('adminAddSearchResults');
          list.innerHTML = '<p style="padding:15px; font-size:13px; color:#999;">検索中...🦀</p>';
          const res = await fetch(\`/api/search?c=all&q=\${encodeURIComponent(q)}&h=\${hId}\`);
          const data = await res.json();
          const masterData = data.filter(i => !i.isAdopted && !i.key.includes('[市販]'));
          if(!masterData.length) { list.innerHTML = '<p style="padding:15px; font-size:13px; color:#999;">追加できる未採用薬が見つかりませんでしたカニ🦀</p>'; return; }
      // 👇修正: こちらもリッチ表示に変更して、追加する薬の情報をわかりやすく！
      list.innerHTML = masterData.map(i => \`
        <div class="admin-item" style="align-items:flex-start;">
          <div class="admin-item-info" style="line-height:1.5;">
            <b style="font-size:15px; color:#333;">\${i.name}</b>
            <div style="display:flex; gap:4px; margin:4px 0; flex-wrap:wrap; align-items:center;">
              \${i.isBrand ? '<span class="tag blue" style="font-size:10px; padding:2px 6px;">先発</span>' : ''}
              \${i.price && i.price !== '-' ? '<span class="tag" style="background:#fff3cd;color:#333;border:1px solid #ffe69c;font-size:10px; padding:2px 6px;"><span style="color:#e65100;">￥</span>' + i.price + '</span>' : ''}
              \${i.component ? '<span style="font-size:11px; color:#0056b3; background:#e3f2fd; padding:2px 6px; border-radius:4px; border:1px solid #bbdefb;">🧬 ' + i.component + '</span>' : ''}
            </div>
            <div style="font-size:12px; color:#666;">📦 \${i.spec} \${i.type ? '/ ' + i.type : ''}</div>
          </div>
          <div class="admin-item-actions" style="display:flex; flex-direction:column; gap:6px;">
            <button class="btn-small" style="background:#28a745; color:#fff;" onclick="openAdminAdd('\${i.key.replace(/'/g, "\\\\'")}', '\${i.name.replace(/'/g, "\\\\'")}')">追加</button>
          </div>
        </div>
      \`).join('');
    }

        function openAdminEdit(key, name) {
          currentEditKey = key;
          document.getElementById('editDrugName').innerText = name;
          // 詳細を取得してメモをセット
          fetch(\`/api/detail?key=\${encodeURIComponent(key)}&h=\${hId}\`).then(r=>r.json()).then(d => {
            document.getElementById('editMemo').value = d.comment || "";
            document.getElementById('adminEditModal').style.display = 'flex';
          });
        }

        function closeAdminEdit() { document.getElementById('adminEditModal').style.display = 'none'; }

        async function saveAdminComment() {
          const comment = document.getElementById('editMemo').value.trim();
          const btn = document.getElementById('btnSaveAdmin');
          btn.disabled = true;
          const res = await fetch(\`/api/admin/save-comment?h=\${hId}\`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ key: currentEditKey, comment })
          });
          if((await res.json()).success) { alert('保存しましたカニ！🦀'); closeAdminEdit(); adminSearch(); }
          btn.disabled = false;
        }

        async function adminDeleteItem(key) {
          if(!confirm('本当に削除しますか？')) return;
          const res = await fetch(\`/api/admin/delete-item?h=\${hId}\`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ key })
          });
          if((await res.json()).success) { alert('削除しましたカニ🦀'); adminSearch(); }
        }

        // 個別追加用の処理
        let currentAddMasterKey = "";
        function openAdminAdd(key, name) {
          currentAddMasterKey = key;
          document.getElementById('addDrugName').innerText = name;
          document.getElementById('addMemo').value = "";
          document.getElementById('adminAddModal').style.display = 'flex';
        }
        function closeAdminAdd() { document.getElementById('adminAddModal').style.display = 'none'; }

        async function saveAdminAdd() {
          const comment = document.getElementById('addMemo').value.trim();
          const btn = document.getElementById('btnSaveAdd');
          btn.disabled = true;
          const res = await fetch(\`/api/admin/add-item?h=\${hId}\`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ masterKey: currentAddMasterKey, comment })
          });
          if((await res.json()).success) { 
            alert('採用薬に追加しましたカニ！🦀'); 
            closeAdminAdd(); 
            adminAddSearch(); 
            // もし編集検索で何か開いていたら再検索してあげる
            if (document.getElementById('adminSearchQ').value.trim()) {
              adminSearch();
            }
          } else {
            alert('追加に失敗しましたカニ🦀💦');
          }
          btn.disabled = false;
        }

        // --- 既存のCSV処理 ---
        let parsedData = []; let headers = [];
        document.getElementById('btnChangePwd').onclick = async () => {
          const newPwd = document.getElementById('changePwd').value.trim();
          if(!newPwd) return;
          const res = await fetch('/api/admin/changepwd?h=' + hId, {method: 'POST', body: JSON.stringify({ newPwd })});
          if((await res.json()).success) alert('変更完了カニ！🦀');
        };
        document.getElementById('btnChangeEmail').onclick = async () => {
          const newEmail = document.getElementById('changeEmail').value.trim();
          if(!newEmail) return;
          const res = await fetch('/api/admin/changemail?h=' + hId, {method: 'POST',headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newEmail })});
          const r = await res.json();
          if(r.success) { document.getElementById('currentEmail').innerText = newEmail; alert('変更完了カニ！🦀'); }
        };
        
        // 🔥ここを変更: エラー詳細をそのまま画面に出すようにしました🦀
        document.getElementById('btnChangeUserPwd').onclick = async () => {
          const newUserPwd = document.getElementById('changeUserPwd').value.trim();
          const btn = document.getElementById('btnChangeUserPwd');
          btn.disabled = true;
          try {
            const res = await fetch('/api/admin/changeuserpwd?h=' + hId, {method: 'POST',headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newUserPwd })});
            const r = await res.json();
            if(r.success) { 
                const msg = document.getElementById('userPwdMsg');
                msg.innerText = newUserPwd ? '✅ ユーザーパスワードを設定したカニ！🦀' : '✅ ユーザーパスワードを解除したカニ！🦀';
                msg.style.color = '#28a745';
                msg.style.display = 'block';
                setTimeout(() => msg.style.display = 'none', 3000);
            } else {
                alert('GAS連携エラー🦀\\n詳細: ' + (r.error || '不明なエラー'));
            }
          } catch(e) {
            alert('通信パースエラーカニ🦀💦\\n詳細: ' + e.message);
          }
          btn.disabled = false;
        };
        
        function parseCSV(text) {
          let rows = []; let row = []; let cell = ""; let q = false;
          for(let i=0; i<text.length; i++) {
            let c = text[i];
            if(q) { if(c==='"' && text[i+1]==='"') { cell+='"'; i++; } else if(c==='"') q=false; else cell+=c; }
            else { if(c==='"') q=true; else if(c===',') { row.push(cell.trim()); cell=""; } else if(c==='\\n' || c==='\\r') { row.push(cell.trim()); rows.push(row); row=[]; cell=""; if(c==='\\r'&&text[i+1]==='\\n') i++; } else cell+=c; }
          }
          if(cell||row.length) { row.push(cell.trim()); rows.push(row); }
          return rows.filter(r => r.join('').trim() !== '');
        }
document.getElementById('csvFile').onchange = (e) => {
          const file = e.target.files[0];
          if(!file) return;
          const fileName = file.name.toLowerCase();
          const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');

          const reader = new FileReader();
          reader.onload = (evt) => {
            const uint8Array = new Uint8Array(evt.target.result);
            let rows = [];

            if (isExcel) {
              // Excelの読み込み処理 (SheetJSを使用)
              const workbook = XLSX.read(uint8Array, {type: 'array'});
              const firstSheetName = workbook.SheetNames[0]; // 1番左のシートを取得
              const worksheet = workbook.Sheets[firstSheetName];
              // ヘッダーも含めた2次元配列として取得 (空白セルも詰める)
              rows = XLSX.utils.sheet_to_json(worksheet, {header: 1, defval: ""});
              // 空行を排除
              rows = rows.filter(r => r.join('').trim() !== '');
            } else {
              // 従来のCSV読み込み処理
              const unicodeArray = Encoding.convert(uint8Array, {
                  to: 'UNICODE',
                  from: 'AUTO'
              });
              const csvText = Encoding.codeToString(unicodeArray);
              rows = parseCSV(csvText);
            }

            headers = rows[0] || []; parsedData = rows.slice(1);
            ['mapName', 'mapSpec', 'mapYJ', 'mapC1'].forEach((sid, idx) => {
              const sel = document.getElementById(sid);
              
              
              sel.innerHTML = '<option value="-1">なし</option>' + headers.map((h, i) => {
                const colLabel = (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));
                // Excelのヘッダーが数値になる場合を考慮して String(h) にする
                return \`<option value="\${i}">\${colLabel}列：\${String(h)}</option>\`;
              }).join('');
              

              const mIdx = headers.findIndex(h => String(h).includes(['名', '規格', 'YJ', 'メモ'][idx]));
              if(mIdx !== -1) sel.value = mIdx;
            });
            document.getElementById('mappingArea').style.display = 'block';
          };
          reader.readAsArrayBuffer(file);
        };
        let uploadPayload = []; let keysToRemove = []; let finalCount = 0;
        document.getElementById('btnPreview').onclick = async () => {
          const iN = parseInt(document.getElementById('mapName').value), 
                iS = parseInt(document.getElementById('mapSpec').value), 
                iY = parseInt(document.getElementById('mapYJ').value), 
                iC1 = parseInt(document.getElementById('mapC1').value);
          if(iN===-1||iY===-1) return alert('必須列を選択してくださいカニ🦀');
          uploadPayload = []; const tbody = document.querySelector('#previewTable tbody'); tbody.innerHTML = ''; const csvKeys = new Set();
          parsedData.forEach(row => {
            const yj = row[iY]; if(!yj||yj.length<7) return;
            
            // YJコードの桁数での推測を廃止し、一時的に[内]をセットします。
            // （アップロード時にサーバー側でKVマスタを探し、正しい分類に上書きされます！）
            let cat = "[内]"; 
            
            const cleanName = row[iN] ? row[iN].replace(/,/g, '，') : "";
            const cleanSpec = iS !== -1 && row[iS] ? row[iS].replace(/,/g, '，') : "";
            const cleanMemo = iC1 !== -1 && row[iC1] ? row[iC1].replace(/,/g, '，') : "";
            const key = \`\${hId}_\${cat}\${cleanName}_\${yj}\`;
            const val = \`\${cleanName},\${cleanSpec},-,,\${yj},\${cleanMemo}\`;
            if(!csvKeys.has(key)) { 
              csvKeys.add(key); 
              uploadPayload.push({key, val}); 
              if(uploadPayload.length<=5) tbody.innerHTML += \`<tr><td>\${yj}</td><td>\${cleanName}</td><td>\${cleanSpec}</td><td>\${cleanMemo}</td></tr>\`; 
            }
          });
          const rK = await fetch('/api/admin/keys?h='+hId); const dK = await rK.json(); const eK = new Set(dK.keys || []);
          keysToRemove = []; 
          if(document.getElementById('chkFullSync').checked) {
            eK.forEach(k => { if(!csvKeys.has(k)) keysToRemove.push(k); });
            finalCount = csvKeys.size;
          } else {
            let finalKeys = new Set(eK);
            csvKeys.forEach(k => finalKeys.add(k));
            finalCount = finalKeys.size;
          }
          document.getElementById('previewStats').innerHTML = \`新規/更新: \${uploadPayload.length}件 / 削除: \${keysToRemove.length}件 (更新後の総件数: \${finalCount}件)\`;
          document.getElementById('previewArea').style.display = 'block';
        };
        document.getElementById('btnUpload').onclick = async () => {
          const btn = document.getElementById('btnUpload'); btn.disabled = true;
          const res = await fetch('/api/admin/upload?h='+hId, {method:'POST', body:JSON.stringify({items:uploadPayload, deletes:keysToRemove, finalCount})});
          if((await res.json()).success) alert('更新完了カニ！🦀');
          btn.disabled = false;
          location.reload();
        };

        // --- 新規追加: 掲示板機能 (ここから) ---

        // 👇ここから追加：掲示板用のお薬検索とリンク挿入機能
        async function boardDrugSearch() {
          const q = document.getElementById('boardDrugSearchQ').value.trim();
          if(!q) return;
          const list = document.getElementById('boardDrugSearchResults');
          list.innerHTML = '<p style="padding:15px; font-size:13px; color:#999;">検索中...🦀</p>';
          
          // 検索APIを叩く
    const res = await fetch(\`/api/search?c=all&q=\${encodeURIComponent(q)}&h=\${hId}\`);
          const data = await res.json();
          
          // 採用薬のみに絞り込み
          const adoptedData = data.filter(i => !i.key.includes('[市販]'));
      if(!adoptedData.length) { 
        list.innerHTML = '<p style="padding:15px; font-size:13px; color:#999;">お薬が見つかりませんでしたカニ🦀</p>'; 
        return; 
      }
      
      // 👇修正: 掲示板のお薬検索もリッチ表示に統一して見やすく！
      list.innerHTML = adoptedData.map(i => \`
        <div class="admin-item" style="align-items:flex-start;">
          <div class="admin-item-info" style="line-height:1.5;">
            <b style="font-size:15px; color:#333;">\${i.name}</b>
            <div style="display:flex; gap:4px; margin:4px 0; flex-wrap:wrap; align-items:center;">
              \${i.isBrand ? '<span class="tag blue" style="font-size:10px; padding:2px 6px;">先発</span>' : ''}
              \${i.price && i.price !== '-' ? '<span class="tag" style="background:#fff3cd;color:#333;border:1px solid #ffe69c;font-size:10px; padding:2px 6px;"><span style="color:#e65100;">￥</span>' + i.price + '</span>' : ''}
              \${i.component ? '<span style="font-size:11px; color:#0056b3; background:#e3f2fd; padding:2px 6px; border-radius:4px; border:1px solid #bbdefb;">🧬 ' + i.component + '</span>' : ''}
            </div>
            <div style="font-size:12px; color:#666;">📦 \${i.spec} \${i.type ? '/ ' + i.type : ''}</div>
          </div>
          <div class="admin-item-actions" style="display:flex; flex-direction:column; gap:6px;">
            <button class="btn-small" style="background:#28a745; color:#fff;" onclick="insertBoardLink('\${i.key.replace(/'/g, "\\\\'")}', '\${i.name.replace(/'/g, "\\\\'")}')">挿入</button>
          </div>
        </div>
      \`).join('');
    }

        function insertBoardLink(key, name) {
          const textarea = document.getElementById('boardMessage');
          
          // バッククォートをやめて通常の文字列結合に変更（サーバー側での誤展開を防止）
          const linkText = "[[[💊 " + name + "|" + key + "]]]";
          
          // カーソル位置を取得して、その場所にリンクテキストを挿入
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          const text = textarea.value;
          textarea.value = text.substring(0, start) + linkText + text.substring(end);
          
          // 挿入後にカーソルをリンクの後ろに移動してフォーカスを戻す
          textarea.focus();
          textarea.selectionStart = textarea.selectionEnd = start + linkText.length;
        }
        // 👆ここまで追加

              
        
        let currentBoardData = [];
        let currentEditBoardId = null;

        function loadBoard() {
          fetch('/api/board?h=' + hId).then(r=>r.json()).then(data => {
            currentBoardData = data || [];
            const list = document.getElementById('boardList');
            if(!data || data.length===0) { list.innerHTML = '<p style="padding:15px; font-size:13px; color:#999;">お知らせはまだありませんカニ🦀</p>'; return; }
            list.innerHTML = data.map(b => {
              // 画面表示用（正規表現のエスケープ）
              const parsedMessage = (b.message || "").replace(/\\[\\[\\[💊 (.*?)\\|(.*?)\\]\\]\\]/g, (match, name, key) => {
                const safeKey = String(key).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const safeName = String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return '<a href="#" onclick="showDetail(\\'' + safeKey + '\\'); return false;" style="color:#0056b3; font-weight:bold; text-decoration:underline;">💊 ' + safeName + '</a>';
              });
              
              // テンプレートリテラルのエラーを防ぐため通常の文字列結合を使用
              return '<div class="admin-item" style="flex-direction:column; align-items:flex-start;">' +
                '<div style="display:flex; justify-content:space-between; width:100%; align-items:center; margin-bottom:4px;">' +
                  '<div style="font-size:11px; color:#888;">' + b.date + '</div>' +
                  '<button class="btn-small" style="background:#ff9d00; color:#fff;" onclick="copyBoardAnnounce(' + b.id + ')">📋 案内コピー</button>' +
                '</div>' +
                '<div style="font-size:13px; margin-bottom:8px; white-space:pre-wrap; width:100%;">' + parsedMessage + '</div>' +
                '<div style="display:flex; gap:8px;">' +
                  '<button class="btn-small btn-edit" onclick="openBoardEdit(' + b.id + ')">編集</button>' +
                  '<button class="btn-small btn-delete" onclick="deleteBoard(' + b.id + ')">削除</button>' +
                '</div>' +
              '</div>';
            }).join('');
          });
        }
        
        function copyBoardAnnounce(id) {
          const target = currentBoardData.find(b => b.id === id);
          if (!target) return;
          // コピー用も正規表現のエスケープを修正
          const plainText = (target.message || "").replace(/\\[\\[\\[💊 (.*?)\\|(.*?)\\]\\]\\]/g, "$1");
          const copyText = plainText + "\\n\\nメディカニの掲示板をご覧下さい\\nhttps://medikani.com/" + hId;
          
          navigator.clipboard.writeText(copyText).then(() => {
            alert('案内文をクリップボードにコピーしましたカニ！🦀\\nメールやLINEなどに貼り付けてください。');
          }).catch(() => {
            alert('コピーに失敗しましたカニ🦀💦');
          });
        }

        function openBoardEdit(id) {
          const target = currentBoardData.find(b => b.id === id);
          if (!target) return;
          currentEditBoardId = id;
          document.getElementById('editBoardMessage').value = target.message;
          document.getElementById('boardEditModal').style.display = 'flex';
        }

        function closeBoardEdit() {
          document.getElementById('boardEditModal').style.display = 'none';
        }

        async function saveBoardEdit() {
          const message = document.getElementById('editBoardMessage').value.trim();
          if(!message) return;
          const btn = document.getElementById('btnSaveBoard');
          btn.disabled = true;
          const res = await fetch('/api/admin/board?h=' + hId, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ action: 'edit', id: currentEditBoardId, message })
          });
          if((await res.json()).success) {
            alert('編集を保存しましたカニ！🦀');
            closeBoardEdit();
            loadBoard();
          }
          btn.disabled = false;
        }

        async function postBoard() {
          const message = document.getElementById('boardMessage').value.trim();
          if(!message) return;
          const res = await fetch('/api/admin/board?h=' + hId, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ action: 'post', message })
          });
          if((await res.json()).success) {
            alert('投稿しましたカニ！🦀');
            document.getElementById('boardMessage').value = '';
            loadBoard();
          }
        }
        async function deleteBoard(id) {
          if(!confirm('削除しますか？')) return;
          const res = await fetch('/api/admin/board?h=' + hId, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ action: 'delete', id })
          });
          if((await res.json()).success) { loadBoard(); }
        }
        loadBoard();
        // --- 新規追加: 掲示板機能 (ここまで) ---
      </script></body></html>`;
  }
};
