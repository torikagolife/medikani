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
// ===== 🌟追加: KVキー一覧のメモリキャッシュ（全件listの連打を防ぐ） =====
// KVの list() は get() と違い cacheTtl が効かないため、アイソレート内の
// メモリに一定時間だけ保持して使い回す。TTL経過後は自動で取り直す。
// ⚠️ 採用薬を管理画面で更新した直後、最大 KEYLIST_TTL_MS の間は
//    古い一覧が使われる可能性がある（既定3分）。
const KEYLIST_CACHE = new Map();
const KEYLIST_TTL_MS = 180000; // 3分

async function listKeysCached(cacheKey, prefixes, env) {
  const now = Date.now();
  const hit = KEYLIST_CACHE.get(cacheKey);
  if (hit && (now - hit.at) < KEYLIST_TTL_MS) return hit.keys.slice();
  const keys = [];
  for (const p of prefixes) {
    let cursor = "";
    do {
      const list = await env.MEDI_KV.list({ prefix: p, limit: 1000, cursor: cursor || undefined });
      keys.push(...list.keys.map(k => k.name));
      cursor = list.list_complete ? "" : list.cursor;
    } while (cursor);
  }
  if (KEYLIST_CACHE.size > 30) KEYLIST_CACHE.clear(); // 施設が増えても膨らませない
  KEYLIST_CACHE.set(cacheKey, { at: now, keys: keys });
  return keys.slice(); // 呼び出し側が書き換えてもキャッシュを壊さないようコピーを返す
}

// マスタ3カテゴリ（[内][外][注]）のキー一覧
async function getMasterKeysCached(env) {
  return await listKeysCached("__MASTER__", ["[内]", "[外]", "[注]"], env);
}

// 施設の採用薬キー一覧（hIdが空なら空配列）
async function getAdoptedKeysCached(hId, env) {
  if (!hId) return [];
  return await listKeysCached("ADOPTED_" + hId, [`${hId}_[内]`, `${hId}_[外]`, `${hId}_[注]`], env);
}

// ===== 🌟追加: 検索用の正規化ヘルパー =====
// ⚠️ マスタのキー名は英数字が【全角】（例:「ロキソプロフェン錠６０ｍｇ」）。
//    クエリだけ半角にして素の includes で比べると規格入りの名前が絶対に当たらないため、
//    比較の前に必ず【両側】を同じルールで正規化する（鑑別の kanbetsuMatchNames と同じ考え方）。
function kvNormName(s) {
  return hiraToKata(
    String(s || "")
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/．/g, ".").replace(/，/g, ",").replace(/％/g, "%")
      .replace(/｢/g, "「").replace(/｣/g, "」")
  ).normalize("NFKC").toUpperCase().replace(/\s+/g, "");
}
// キーから薬品名部分／成分名部分を取り出す（本体検索と同じ切り出し）
function kvDrugNamePart(key) { return key.split("_").find(p => p.includes("[")) || key; }
function kvComponentPart(key) { const ps = key.split("_"); return ps.length > 2 ? ps[ps.length - 2] : ""; }

// 正規化済みの検索インデックス（キー一覧と同じTTLでメモリに保持）
// 返り値は共有オブジェクトなので、呼び出し側で書き換えないこと（読むだけ）。
const NAMEIDX_CACHE = new Map();
async function getNameIndexCached(hId, env) {
  const cacheKey = "NAMEIDX_" + (hId || "-");
  const now = Date.now();
  const hit = NAMEIDX_CACHE.get(cacheKey);
  if (hit && (now - hit.at) < KEYLIST_TTL_MS) return hit.idx;
  const masterKeys = await getMasterKeysCached(env);
  const adoptedKeys = await getAdoptedKeysCached(hId, env);
  const idx = [];
  // 採用薬を先に積む（同点なら採用薬が残るようにするため）
  for (const k of adoptedKeys) idx.push({ k: k, n: kvNormName(kvDrugNamePart(k)), c: kvNormName(kvComponentPart(k)), adopted: true });
  for (const k of masterKeys)  idx.push({ k: k, n: kvNormName(kvDrugNamePart(k)), c: kvNormName(kvComponentPart(k)), adopted: false });
  if (NAMEIDX_CACHE.size > 30) NAMEIDX_CACHE.clear();
  NAMEIDX_CACHE.set(cacheKey, { at: now, idx: idx });
  return idx;
}
// ==========================================================================

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
// ============================================================================
// 🦀メディカニ鑑別: 用法マスタ／単位／定型文のデフォルト定義 (ここから)
// ----------------------------------------------------------------------------
// 【採番ルール】区分ごとに「デフォルト帯」と「施設追加帯」を分けている。
//   コード昇順に並べるだけで 内服→頓服→外用… の順に綺麗に並ぶ。
//     内服      : デフォルト 100番台 / 施設追加  200番台
//     頓服      : デフォルト 300番台 / 施設追加  400番台
//     外用      : デフォルト 500番台 / 施設追加  600番台
//     外用(眼)  : デフォルト 700番台 / 施設追加  800番台
//     外用(鼻)  : デフォルト 900番台 / 施設追加 1000番台
//     外用(他)  : デフォルト1100番台 / 施設追加 1200番台
// ============================================================================
const YOHO_CAT_BLOCKS = [
  { cat: "内服",     def: 100,  add: 200 },
  { cat: "頓服",     def: 300,  add: 400 },
  { cat: "外用",     def: 500,  add: 600 },
  { cat: "外用(眼)", def: 700,  add: 800 },
  { cat: "外用(鼻)", def: 900,  add: 1000 },
  { cat: "外用(他)", def: 1100, add: 1200 }
];

// デフォルト用法マスタ（トリさん提供CSV＋現場で頻用のものを追加）
const YOHO_DEFAULT_LIST = [
  // --- 内服 (100番台) ---
  { code: 101, cat: "内服", name: "1日1回朝食後",          abbr: "1×朝後" },
  { code: 102, cat: "内服", name: "1日1回昼食後",          abbr: "1×昼後" },
  { code: 103, cat: "内服", name: "1日1回夕食後",          abbr: "1×夕後" },
  { code: 104, cat: "内服", name: "1日1回就寝前",          abbr: "1×眠前" },
  { code: 105, cat: "内服", name: "1日2回朝夕食後",        abbr: "2×朝夕後" },
  { code: 106, cat: "内服", name: "1日2回朝食後・就寝前",  abbr: "2×朝後・眠前" },
  { code: 107, cat: "内服", name: "1日3回毎食後",          abbr: "3×毎食後" },
  { code: 108, cat: "内服", name: "1日3回毎食前",          abbr: "3×毎食前" },
  { code: 109, cat: "内服", name: "1日4回毎食後・就寝前",  abbr: "4×毎食後・眠前" },
  { code: 110, cat: "内服", name: "1日1回起床時",          abbr: "1×起床時" },
  { code: 111, cat: "内服", name: "1日1回夕食直前",        abbr: "1×夕直前" },
  { code: 112, cat: "内服", name: "1日1回朝食前",          abbr: "1×朝前" },
  { code: 113, cat: "内服", name: "1日2回朝夕食前",        abbr: "2×朝夕前" },
  { code: 114, cat: "内服", name: "1日3回毎食直前",        abbr: "3×毎食直前" },
  { code: 115, cat: "内服", name: "週1回起床時",            abbr: "週1×起床時" },
  { code: 116, cat: "内服", name: "隔日1回朝食後",          abbr: "隔日1×朝後" },
  // --- 頓服 (300番台) ---
  { code: 301, cat: "頓服", name: "必要時に",       abbr: "必要時" },
  { code: 302, cat: "頓服", name: "発熱時に",       abbr: "発熱時" },
  { code: 303, cat: "頓服", name: "疼痛時に",       abbr: "疼痛時" },
  { code: 304, cat: "頓服", name: "不眠時に",       abbr: "不眠時" },
  { code: 305, cat: "頓服", name: "便秘時に",       abbr: "便秘時" },
  { code: 306, cat: "頓服", name: "発作時に",       abbr: "発作時" },
  { code: 307, cat: "頓服", name: "嘔気時に",       abbr: "嘔気時" },
  { code: 308, cat: "頓服", name: "めまい時に",     abbr: "めまい時" },
  { code: 309, cat: "頓服", name: "咳嗽時に",       abbr: "咳嗽時" },
  { code: 310, cat: "頓服", name: "下痢時に",       abbr: "下痢時" },
  { code: 311, cat: "頓服", name: "血圧高値時に",   abbr: "血圧高値時" },
  // --- 外用 (500番台) ---
  { code: 501, cat: "外用", name: "1日1回患部に塗布",   abbr: "1×塗布" },
  { code: 502, cat: "外用", name: "1日2回患部に塗布",   abbr: "2×塗布" },
  { code: 503, cat: "外用", name: "1日1回患部に貼付",   abbr: "1×貼付" },
  { code: 504, cat: "外用", name: "1日2回患部に貼付",   abbr: "2×貼付" },
  { code: 505, cat: "外用", name: "痛いところに塗布",   abbr: "痛時塗布" },
  { code: 506, cat: "外用", name: "痛いところに貼付",   abbr: "痛時貼付" },
  { code: 507, cat: "外用", name: "1日数回患部に塗布",  abbr: "数回塗布" },
  { code: 508, cat: "外用", name: "1日1回就寝前に貼付", abbr: "1×眠前貼付" },
  // --- 外用(眼) (700番台) ---
  { code: 701, cat: "外用(眼)", name: "1日1回右眼に点眼", abbr: "1×右点眼" },
  { code: 702, cat: "外用(眼)", name: "1日1回左眼に点眼", abbr: "1×左点眼" },
  { code: 703, cat: "外用(眼)", name: "1日1回両眼に点眼", abbr: "1×両点眼" },
  { code: 704, cat: "外用(眼)", name: "1日2回両眼に点眼", abbr: "2×両点眼" },
  { code: 705, cat: "外用(眼)", name: "1日4回両眼に点眼", abbr: "4×両点眼" },
  // --- 外用(鼻) (900番台) ---
  { code: 901, cat: "外用(鼻)", name: "1日1回両鼻に噴霧", abbr: "1×両鼻噴霧" },
  { code: 902, cat: "外用(鼻)", name: "1日2回両鼻に噴霧", abbr: "2×両鼻噴霧" },
  // --- 外用(他) (1100番台) ---
  { code: 1101, cat: "外用(他)", name: "1日1回肛門内に挿入",   abbr: "1×坐薬挿入" },
  { code: 1102, cat: "外用(他)", name: "発熱時に肛門内に挿入", abbr: "発熱時坐薬" },
  { code: 1103, cat: "外用(他)", name: "1日1回吸入",           abbr: "1×吸入" },
  { code: 1104, cat: "外用(他)", name: "1日2回吸入",           abbr: "2×吸入" }
];

// 単位プルダウンの初期値（管理画面で施設ごとに編集可）
const YOHO_UNIT_DEFAULT = ["錠", "カプセル", "包", "g", "mL", "滴", "枚", "個", "本", "吸入", "プッシュ", "単位"];
// 用量プルダウンの初期値
const YOHO_DOSE_DEFAULT = ["0.5", "1", "1.5", "2", "3", "4", "5", "6", "8", "10"];

// 帳票の定型テキスト／定型署名の初期値
const KANBETSU_TMPL_TEXT_DEFAULT = "上記持参薬について鑑別を行いました。継続・切替の可否および用法用量のご指示をお願いいたします。";
const KANBETSU_TMPL_SIGN_DEFAULT = "鑑別実施　薬剤師：＿＿＿＿＿＿＿＿\n確　　認　医　師：＿＿＿＿＿＿＿＿";

// 共通デフォルト（KVに KANBETSU_DEFAULT_json があればそちらを優先）
function kanbetsuBuiltinDefault() {
  return {
    version: 1,
    yoho: YOHO_DEFAULT_LIST.map(x => ({ ...x })),
    units: YOHO_UNIT_DEFAULT.slice(),
    doses: YOHO_DOSE_DEFAULT.slice(),
    tmplText: KANBETSU_TMPL_TEXT_DEFAULT,
    tmplSign: KANBETSU_TMPL_SIGN_DEFAULT
  };
}

// KVから共通デフォルトを読む（無ければコード内蔵の値）
async function loadKanbetsuDefault(env) {
  try {
    const s = await env.MEDI_KV.get("KANBETSU_DEFAULT_json", { cacheTtl: 300 });
    if (s) {
      const d = JSON.parse(s);
      const base = kanbetsuBuiltinDefault();
      return {
        version: d.version || 1,
        yoho: Array.isArray(d.yoho) && d.yoho.length ? d.yoho : base.yoho,
        units: Array.isArray(d.units) && d.units.length ? d.units : base.units,
        doses: Array.isArray(d.doses) && d.doses.length ? d.doses : base.doses,
        tmplText: typeof d.tmplText === "string" ? d.tmplText : base.tmplText,
        tmplSign: typeof d.tmplSign === "string" ? d.tmplSign : base.tmplSign
      };
    }
  } catch (e) { /* 壊れていたら内蔵デフォルトにフォールバック */ }
  return kanbetsuBuiltinDefault();
}

// 施設の上書き設定を読む（無ければ空の器）
async function loadKanbetsuOvr(hId, env) {
  const empty = { yohoAdd: [], yohoHide: [], units: null, doses: null, tmplText: null, tmplSign: null, updatedAt: "" };
  if (!hId) return empty;
  try {
    const s = await env.MEDI_KV.get(`${hId}_kanbetsu_json`);
    if (!s) return empty;
    const d = JSON.parse(s);
    return {
      yohoAdd: Array.isArray(d.yohoAdd) ? d.yohoAdd : [],
      yohoHide: Array.isArray(d.yohoHide) ? d.yohoHide : [],
      units: Array.isArray(d.units) && d.units.length ? d.units : null,
      doses: Array.isArray(d.doses) && d.doses.length ? d.doses : null,
      tmplText: typeof d.tmplText === "string" ? d.tmplText : null,
      tmplSign: typeof d.tmplSign === "string" ? d.tmplSign : null,
      updatedAt: d.updatedAt || ""
    };
  } catch (e) { return empty; }
}

// デフォルト＋施設追加をマージして、実際に画面で使う設定を作る
function mergeKanbetsuConfig(def, ovr) {
  const hide = new Set((ovr.yohoHide || []).map(Number));
  const list = [];
  for (const y of (def.yoho || [])) {
    if (hide.has(Number(y.code))) continue;
    list.push({ code: Number(y.code), cat: y.cat, name: y.name, abbr: y.abbr || y.name, own: false });
  }
  for (const y of (ovr.yohoAdd || [])) {
    list.push({ code: Number(y.code), cat: y.cat, name: y.name, abbr: y.abbr || y.name, own: true });
  }
  // コード昇順＝区分順（採番ルールでそうなるようにしてある）
  list.sort((a, b) => a.code - b.code);
  return {
    yoho: list,
    units: ovr.units || def.units,
    doses: ovr.doses || def.doses,
    tmplText: (ovr.tmplText !== null && ovr.tmplText !== undefined) ? ovr.tmplText : def.tmplText,
    tmplSign: (ovr.tmplSign !== null && ovr.tmplSign !== undefined) ? ovr.tmplSign : def.tmplSign,
    blocks: YOHO_CAT_BLOCKS
  };
}

// 施設の追加刻印を読む
async function loadKokuinOvr(hId, env) {
  if (!hId) return { items: [] };
  try {
    const s = await env.MEDI_KV.get(`${hId}_kokuin_json`);
    if (!s) return { items: [] };
    const d = JSON.parse(s);
    return { items: Array.isArray(d.items) ? d.items : [], updatedAt: d.updatedAt || "" };
  } catch (e) { return { items: [] }; }
}
// 🦀メディカニ鑑別: 用法マスタ／単位／定型文のデフォルト定義 (ここまで)
// ============================================================================

function kyuyakuAdminPage(hId, isSuper) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦀</text></svg>">
<title>休薬マスタ管理 🦀 メディカニ</title>
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
  <div id="statusBanner" class="banner red" style="display:none;">
    ⚠️ このマスタは<b>監修前のドラフト</b>です。薬剤師の監修が完了するまで臨床使用しないでください。
  </div>
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
  document.getElementById('statusBanner').style.display = (DEF.status === "DRAFT_UNREVIEWED") ? 'block' : 'none';

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
    (c.reviewedBy ? '<span class="tag ok">✔ 監修済 ' + esc(c.reviewedBy) + '</span>' : '<span class="tag ng">未監修</span>') +
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
// === 🦀休薬チェッカー: 利用ページ生成関数 (ここから) ===
// 患者の薬リストを作り（手入力／写真OCR）、休薬マスタと突合して帳票印刷する利用者向けページ。
// マスタ取得は既存 /api/kyuyaku/master、手入力照合は /api/kyuyaku/lookup、写真は既存 /api/kanbetsu-ocr を流用。
// === 🦀休薬チェッカー: 利用ページ生成関数 (ここから) ===
// 患者の薬リストを作り（検索して確定／写真OCR→チップ→検索して確定）、休薬マスタと突合して帳票印刷する。
// 候補検索は /api/kyuyaku/search、写真は /api/kyuyaku/ocr（お薬手帳・薬情の両対応）。
// 刻印検索と同じ「読み取る→候補を出す→人が確定する」フローで統一。
function kyuyakuCheckerPage(hId, isSuper) {
  return `<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" sizes="512x512" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/icon_kyu.png">
<link rel="apple-touch-icon" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/icon_kyu.png">
<meta name="apple-mobile-web-app-title" content="休薬チェッカー">
<title>メディカニ休薬チェッカー 🦀</title>
<style>
  :root { --pink:#e84c88; }
  * { box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN",sans-serif; margin:0; background:#faf7f8; color:#333; }
  .wrap { max-width:720px; margin:0 auto; padding:16px; }
  h1 { font-size:19px; margin:6px 0 2px; }
  .sub { font-size:12px; color:#888; margin-bottom:14px; }
  .card { background:#fff; border:1px solid #eee; border-radius:14px; padding:14px; margin-bottom:12px; }
  .set-row { display:flex; gap:10px; flex-wrap:wrap; }
  .set-row .fld { flex:1; min-width:130px; }
  label { display:block; font-size:12px; color:#666; margin-bottom:4px; font-weight:bold; }
  select, input[type=text], input[type=date] { width:100%; padding:11px; font-size:16px; border:1.5px solid #ddd; border-radius:10px; outline:none; }
  select:focus, input:focus { border-color:var(--pink); }
  .addrow { display:flex; gap:8px; margin-top:4px; }
  .addrow input { flex:1; }
  .btn { padding:12px 16px; border:none; border-radius:10px; font-weight:bold; font-size:14px; cursor:pointer; white-space:nowrap; }
  .btn.pink { background:var(--pink); color:#fff; }
  .btn.photo { width:100%; margin-top:8px; background:#fff; color:var(--pink); border:2px solid var(--pink); }
  .btn.print { width:100%; margin-top:6px; background:#2e7d32; color:#fff; padding:15px; font-size:16px; }
  .btn.ghost { background:#f4f4f4; color:#666; font-size:12px; padding:9px 12px; }
  #status { text-align:center; font-size:13px; color:#888; margin:8px 0; min-height:18px; }
  .empty { text-align:center; color:#aaa; font-size:13px; padding:18px; }
  /* OCRチップ */
  #chipBox { display:none; }
  .chiphead { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
  .chip { display:inline-block; background:#fff0f6; border:1.5px solid #ffc2da; color:#c2185b; border-radius:18px; padding:8px 14px; margin:0 6px 6px 0; font-size:13px; font-weight:bold; cursor:pointer; text-align:left; }
  .chip:active { background:#ffd9e6; }
  .chip.used { background:#f2f2f2; border-color:#e0e0e0; color:#aaa; }
  .chip .cu { display:block; font-size:10px; font-weight:normal; color:#999; margin-top:2px; }
  .chiptip { font-size:11px; color:#a06; margin-bottom:8px; }
  /* 検索候補 */
  #resultBox { display:none; }
  .cand { display:flex; align-items:center; gap:10px; padding:11px 8px; border-bottom:1px solid #f2f2f2; cursor:pointer; }
  .cand:active { background:#fff5f9; }
  .cinfo { flex:1; min-width:0; }
  .cname { font-weight:bold; font-size:14px; line-height:1.4; }
  .cbadges { display:flex; gap:4px; flex-wrap:wrap; margin:4px 0 2px; }
  .bd { font-size:10px; padding:2px 7px; border-radius:5px; border:1px solid #ddd; background:#fafafa; color:#666; }
  .bd.adopt { background:#e8f5e9; border-color:#a5d6a7; color:#2e7d32; font-weight:bold; }
  .bd.brand { background:#e3f2fd; border-color:#bbdefb; color:#0056b3; }
  .bd.price { background:#fff3cd; border-color:#ffe69c; color:#e65100; }
  .bd.comp { background:#f3e5f5; border-color:#e1bee7; color:#7b1fa2; }
  .cspec { font-size:11px; color:#888; }
  .mtag { display:inline-block; font-size:11px; font-weight:bold; margin-top:4px; padding:3px 8px; border-radius:6px; background:#fff8f0; border:1px solid #ffe0c0; }
  .cadd { flex-shrink:0; font-size:12px; font-weight:bold; color:var(--pink); border:1.5px solid var(--pink); border-radius:8px; padding:8px 10px; }
  /* リスト */
  .row { display:flex; align-items:center; gap:10px; padding:11px 6px; border-bottom:1px solid #f0f0f0; }
  .rname { flex:1; font-weight:bold; font-size:14px; }
  .rname .sub2 { display:block; font-size:11px; color:#e84c88; font-weight:normal; margin-top:2px; }
  .rjudge { font-size:13px; font-weight:bold; text-align:right; }
  .rjudge .sd { display:block; font-size:11px; font-weight:normal; color:#555; }
  .j-continue { color:#2e7d32; }
  .j-stop { color:#c62828; }
  .j-consult { color:#e65100; }
  .j-none { color:#999; }
  .j-unknown { color:#b8860b; }
  .rdel { background:#f2f2f2; border:none; border-radius:50%; width:26px; height:26px; font-size:15px; color:#888; cursor:pointer; flex-shrink:0; }
  .notice { font-size:11px; color:#a06; background:#fff3f7; border:1px solid #ffd9e6; border-radius:10px; padding:10px; margin-top:6px; }
  .footer { text-align:center; font-size:11px; color:#bbb; padding:20px 0; }
  /* 帳票（印刷用）*/
  #report { display:none; }
  @media print {
    body { background:#fff; }
    .no-print { display:none !important; }
    .wrap { max-width:none; padding:0; }
    #report { display:block; }
    #report h2 { text-align:center; font-size:18px; margin:0 0 10px; }
    #report table { width:100%; border-collapse:collapse; margin-bottom:10px; }
    #report .meta td { border:1px solid #999; padding:5px 8px; font-size:12px; }
    #report .meta td:nth-child(odd) { background:#f2f2f2; font-weight:bold; width:70px; white-space:nowrap; }
    #report .rep th, #report .rep td { border:1px solid #999; padding:5px 7px; font-size:12px; text-align:left; }
    #report .rep th { background:#f2f2f2; }
    #report .j-stop { color:#c62828; font-weight:bold; }
    #report .j-consult { color:#e65100; font-weight:bold; }
    #report .disc { font-size:10px; color:#333; border:1px solid #ccc; padding:8px; margin-top:6px; }
    #report .sign { display:flex; gap:30px; margin-top:16px; font-size:13px; }
  }
</style>
</head><body>
<div class="wrap">
  <div class="no-print">
    <h1>🦀 メディカニ休薬チェッカー</h1>
    <div class="sub">患者さんの薬を追加して、術式・検査ごとの休薬判定を確認・印刷できますカニ🦀</div>

    <div class="card">
      <div class="set-row">
        <div class="fld"><label>分類（術式・検査）</label><select id="catSel" onchange="onCatChange()"></select></div>
        <div class="fld"><label>手術予定日</label><input type="date" id="opDate" onchange="renderList()"></div>
      </div>
      <div class="fld" style="margin-top:10px;"><label>患者名・ID（任意・帳票用）</label><input type="text" id="ptName" placeholder="空欄でもOK" autocomplete="off"></div>
    </div>

    <div class="card">
      <label>薬を検索して追加</label>
      <div class="addrow">
        <input type="text" id="nameInput" placeholder="薬の名前・成分名（例：ワーファリン／アスピリン）" autocomplete="off">
        <button class="btn pink" onclick="doSearch()">🔍 検索</button>
      </div>
      <button class="btn photo" onclick="document.getElementById('photoFile').click()">📷 お薬手帳・薬情を撮って読み取る</button>
      <input type="file" id="photoFile" accept="image/*" style="display:none">
    </div>

    <div class="card" id="chipBox">
      <div class="chiphead">
        <label style="margin:0;">📷 写真から読み取った薬名</label>
        <button class="btn ghost" onclick="clearChips()">クリア</button>
      </div>
      <div class="chiptip">タップすると検索されますカニ🦀 候補から正しい薬を選んで確定してね。</div>
      <div id="chipList"></div>
    </div>

    <div id="status"></div>

    <div class="card" id="resultBox">
      <div class="chiphead">
        <label style="margin:0;">🔎 「<span id="resultQ"></span>」の検索結果</label>
        <button class="btn ghost" onclick="closeResults()">閉じる</button>
      </div>
      <div id="resultList"></div>
      <div id="rawAddBox" style="margin-top:10px; display:none;">
        <button class="btn ghost" style="width:100%;" onclick="addRaw()">見つからない → 入力した名前のまま追加（判定は行われません）</button>
      </div>
    </div>

    <div class="card">
      <label>薬リストと休薬判定</label>
      <div id="list"><div class="empty">まだ薬がありません。検索か写真で追加してくださいカニ🦀</div></div>
      <div class="notice">「リスト対象外」は休薬マスタの対象外という意味で、継続してよいかを保証するものではありませんカニ🦀 最終判断は必ず処方医・薬剤師へ。</div>
    </div>

    <button class="btn print" onclick="printReport()">🖨️ 休薬チェッカー確認票を印刷</button>
    <div class="footer">🦀 メディカニ休薬チェッカー</div>
  </div>

  <div id="report"></div>
</div>

<script>
const HID = "${hId}";
const HOSP = "${hId}";
const ACT = { continue:"継続可", stop:"休薬", consult:"処方元に照会" };
let MASTER = { cats:[], comps:[] };
let YJ7IDX = {};
let LIST = [];
let RESULTS = [];
let CHIPS = [];
let seq = 0;

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function currentCat(){ const el=document.getElementById('catSel'); return el ? el.value : ''; }
function onCatChange(){ renderList(); if (RESULTS.length) renderResults(document.getElementById('resultQ').textContent); }

async function loadMaster(){
  const st = document.getElementById('status');
  try {
    const res = await fetch('/api/kyuyaku/master?h=' + encodeURIComponent(HID));
    const data = await res.json();
    if (data.error){ st.textContent = '⚠️ 休薬マスタを取得できません（' + data.error + '）'; return; }
    const DEF = data.def || { categories:[], components:[] };
    const OVR = data.ovr || { components:[] };
    const ovrMap = {}; (OVR.components||[]).forEach(function(c){ ovrMap[c.id]=c; });
    const defIds = {}; (DEF.components||[]).forEach(function(c){ defIds[c.id]=1; });
    let comps = (DEF.components||[]).map(function(c){ return ovrMap[c.id] ? Object.assign({}, ovrMap[c.id]) : Object.assign({}, c); });
    (OVR.components||[]).forEach(function(c){ if(!defIds[c.id]) comps.push(Object.assign({}, c)); });
    MASTER.cats = DEF.categories || [];
    MASTER.comps = comps;
    YJ7IDX = {};
    comps.forEach(function(c){ (c.yj7List||[]).forEach(function(y){ YJ7IDX[String(y).slice(0,7)] = c; }); });
    const sel = document.getElementById('catSel');
    if (MASTER.cats.length) {
      sel.innerHTML = MASTER.cats.map(function(c){ return '<option value="'+esc(c.id)+'">'+esc(c.label)+'</option>'; }).join('');
    } else {
      sel.innerHTML = '<option value="">（分類が未設定です）</option>';
    }
    st.textContent = '';
    renderList();
  } catch(e){ st.textContent = '⚠️ 通信エラーが発生しましたカニ🦀'; }
}

function compOf(yj){ if(!yj) return null; return YJ7IDX[String(yj).slice(0,7)] || null; }

function computeStop(days){
  if (days==null) return '';
  const v = document.getElementById('opDate').value;
  if (!v) return '';
  const d = new Date(v + 'T00:00:00');
  d.setDate(d.getDate() - Number(days));
  const w = ['日','月','火','水','木','金','土'][d.getDay()];
  return (d.getMonth()+1) + '/' + d.getDate() + '（' + w + '）から';
}

function judge(item){
  if (!item.yj) return { label:'⚠️ 薬を特定できず', cls:'j-unknown', comp:'', comment:'', stopDate:'' };
  const comp = compOf(item.yj);
  if (!comp) return { label:'リスト対象外', cls:'j-none', comp:'', comment:'', stopDate:'' };
  const rule = (comp.rules||{})[currentCat()] || { action:'consult', days:null, comment:'' };
  const act = rule.action || 'consult';
  let label = ACT[act] || act;
  let stopDate = '';
  if (act === 'stop') {
    const dtxt = (rule.days===0) ? '当日から' : (rule.days!=null ? rule.days+'日前から' : '日数未設定');
    label = '休薬（' + dtxt + '）';
    stopDate = computeStop(rule.days);
  }
  return { label:label, cls:'j-'+act, comp:comp.name||comp.component||'', comment:rule.comment||'', stopDate:stopDate };
}

/* ===== 検索して確定するフロー ===== */
async function doSearch(){
  const q = document.getElementById('nameInput').value.trim();
  const st = document.getElementById('status');
  if (q.length < 2){ st.textContent = '2文字以上で入力してくださいカニ🦀'; return; }
  st.textContent = '🔍 メディカニで検索中...🦀';
  try {
    const res = await fetch('/api/kyuyaku/search?h=' + encodeURIComponent(HID) + '&q=' + encodeURIComponent(q));
    const data = await res.json();
    RESULTS = data.results || [];
    if (data.error && !RESULTS.length){ st.textContent = '⚠️ ' + data.error; }
    else if (!RESULTS.length){ st.textContent = '📭 該当する薬が見つかりませんでしたカニ🦀'; }
    else { st.textContent = '🔎 ' + RESULTS.length + '件の候補が見つかりましたカニ🦀 正しい薬をタップしてね'; }
    renderResults(q);
  } catch(e){ st.textContent = '⚠️ 通信エラーが発生しましたカニ🦀'; }
}

function renderResults(q){
  document.getElementById('resultQ').textContent = q;
  document.getElementById('resultBox').style.display = 'block';
  document.getElementById('rawAddBox').style.display = 'block';
  const list = document.getElementById('resultList');
  if (!RESULTS.length){
    list.innerHTML = '<div class="empty">該当する薬が見つかりませんでしたカニ🦀<br>表記を変えて再検索するか、下のボタンでそのまま追加できます。</div>';
    return;
  }
  list.innerHTML = RESULTS.map(function(r, i){
    const c = compOf(r.yj);
    let tag = '';
    if (c){
      const rule = (c.rules||{})[currentCat()] || {};
      const act = rule.action || 'consult';
      let lab = ACT[act] || act;
      if (act === 'stop'){
        const dtxt = (rule.days===0) ? '当日から' : (rule.days!=null ? rule.days+'日前から' : '日数未設定');
        lab = '休薬（' + dtxt + '）';
      }
      tag = '<div class="mtag ' + ('j-'+act) + '">🩸 休薬マスタ対象：' + esc(c.name||c.component||'') + ' → ' + esc(lab) + '</div>';
    }
    return '<div class="cand" onclick="addFromResult(' + i + ')">'
      + '<div class="cinfo">'
      +   '<div class="cname">' + esc(r.name) + '</div>'
      +   '<div class="cbadges">'
      +     (r.isAdopted ? '<span class="bd adopt">当院採用</span>' : '')
      +     (r.isBrand ? '<span class="bd brand">先発</span>' : '')
      +     (r.price && r.price !== '-' ? '<span class="bd price">￥' + esc(r.price) + '</span>' : '')
      +     (r.component ? '<span class="bd comp">🧬 ' + esc(r.component) + '</span>' : '')
      +   '</div>'
      +   (r.spec ? '<div class="cspec">📦 ' + esc(r.spec) + '</div>' : '')
      +   tag
      + '</div>'
      + '<div class="cadd">＋追加</div>'
      + '</div>';
  }).join('');
}

function addFromResult(i){
  const r = RESULTS[i];
  if (!r) return;
  seq++;
  LIST.push({ id:seq, name:r.name, yj:r.yj||'', spec:r.spec||'' });
  document.getElementById('status').textContent = '✅「' + r.name + '」を追加しましたカニ🦀';
  document.getElementById('nameInput').value = '';
  closeResults();
  renderList();
}

function addRaw(){
  const q = document.getElementById('nameInput').value.trim();
  if (q.length < 2) return;
  seq++;
  LIST.push({ id:seq, name:q, yj:'', spec:'' });
  document.getElementById('status').textContent = '⚠️「' + q + '」を名前のまま追加しました（判定は行われません）';
  document.getElementById('nameInput').value = '';
  closeResults();
  renderList();
}

function closeResults(){
  RESULTS = [];
  document.getElementById('resultBox').style.display = 'none';
}

/* ===== 写真OCR → チップ → 検索 → 確定 ===== */
function compressImage(file){
  return new Promise(function(resolve, reject){
    const img = new Image(); const fr = new FileReader();
    fr.onload = function(){ img.src = fr.result; }; fr.onerror = reject;
    img.onload = function(){
      let w = img.width, h = img.height; const maxDim = 1600;
      if (Math.max(w,h) > maxDim){ const sc = maxDim/Math.max(w,h); w=Math.round(w*sc); h=Math.round(h*sc); }
      const cv = document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      resolve(cv.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = reject; fr.readAsDataURL(file);
  });
}

document.getElementById('photoFile').addEventListener('change', async function(e){
  const files = Array.from(e.target.files || []); e.target.value = '';
  if (!files.length) return;
  const st = document.getElementById('status');
  st.textContent = '📷 写真から薬名を読み取り中...🦀（少し時間がかかります）';
  try {
    const dataUrl = await compressImage(files[0]);
    const r = await fetch('/api/kyuyaku/ocr', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ h:HID, image:dataUrl }) });
    const data = await r.json();
    if (data.error){ st.textContent = '⚠️ ' + data.error; return; }
    const names = data.names || [];
    if (!names.length){ st.textContent = '📭 この写真からは薬名を読み取れませんでしたカニ🦀💦 明るい場所で、薬名の列がまっすぐ入るように撮ってみてね'; return; }
    names.forEach(function(n){ CHIPS.push({ name:n.name, usage:n.usage||'', used:false }); });
    st.textContent = '✅ ' + names.length + '件の薬名を読み取りましたカニ🦀 タップして検索→確定してね';
    renderChips();
    document.getElementById('chipBox').scrollIntoView({ behavior:'smooth', block:'center' });
  } catch(e){ st.textContent = '⚠️ 通信エラーが発生しましたカニ🦀'; }
});

function renderChips(){
  const box = document.getElementById('chipBox');
  if (!CHIPS.length){ box.style.display = 'none'; return; }
  box.style.display = 'block';
  document.getElementById('chipList').innerHTML = CHIPS.map(function(c, i){
    return '<button class="chip' + (c.used ? ' used' : '') + '" onclick="chipTap(' + i + ')">'
      + esc(c.name)
      + (c.usage ? '<span class="cu">' + esc(c.usage) + '</span>' : '')
      + '</button>';
  }).join('');
}

function chipTap(i){
  const c = CHIPS[i];
  if (!c) return;
  document.getElementById('nameInput').value = c.name;
  c.used = true;
  renderChips();
  doSearch();
}

function clearChips(){ CHIPS = []; renderChips(); }

/* ===== リストと帳票 ===== */
function renderList(){
  const box = document.getElementById('list');
  if (!LIST.length){ box.innerHTML = '<div class="empty">まだ薬がありません。検索か写真で追加してくださいカニ🦀</div>'; return; }
  box.innerHTML = LIST.map(function(it){
    const j = judge(it);
    return '<div class="row">'
      + '<div class="rname">' + esc(it.name) + (j.comp ? '<span class="sub2">' + esc(j.comp) + '</span>' : '') + '</div>'
      + '<div class="rjudge ' + j.cls + '">' + esc(j.label) + (j.stopDate ? '<span class="sd">→ ' + esc(j.stopDate) + '</span>' : '') + '</div>'
      + '<button class="rdel" onclick="removeItem(' + it.id + ')">×</button>'
      + '</div>';
  }).join('');
}
function removeItem(id){ LIST = LIST.filter(function(x){ return x.id!==id; }); renderList(); }

function printReport(){
  if (!LIST.length){ alert('先に薬を追加してくださいカニ🦀'); return; }
  const cat = MASTER.cats.filter(function(c){ return c.id===currentCat(); })[0];
  const catLabel = cat ? cat.label : '';
  const op = document.getElementById('opDate').value;
  const pt = document.getElementById('ptName').value.trim();
  const rows = LIST.map(function(it){
    const j = judge(it);
    return '<tr><td>' + esc(it.name) + '</td><td>' + esc(j.comp||'') + '</td><td class="' + j.cls + '">' + esc(j.label) + '</td><td>' + esc(j.stopDate||'') + '</td><td>' + esc(j.comment||'') + '</td></tr>';
  }).join('');
  const t = new Date();
  const td = t.getFullYear() + '/' + (t.getMonth()+1) + '/' + t.getDate();
  document.getElementById('report').innerHTML =
    '<h2>🦀メディカニ休薬チェッカー 確認票</h2>'
    + '<table class="meta"><tr><td>施設</td><td>' + esc(HOSP) + '</td><td>作成日</td><td>' + td + '</td></tr>'
    + '<tr><td>患者</td><td>' + esc(pt||'　') + '</td><td>手術予定日</td><td>' + esc(op||'　') + '</td></tr>'
    + '<tr><td>分類</td><td colspan="3">' + esc(catLabel||'　') + '</td></tr></table>'
    + '<table class="rep"><thead><tr><th>薬剤</th><th>成分</th><th>判定</th><th>休薬開始</th><th>備考</th></tr></thead><tbody>' + rows + '</tbody></table>'
    + '<div class="disc">※本票の判定は休薬マスタに基づく参考情報です。最終的な休薬の可否・時期は必ず処方医・薬剤師がご確認ください。「リスト対象外」は休薬マスタの対象外を示すもので、継続の可否を保証するものではありません。</div>'
    + '<div class="sign"><div>確認者：＿＿＿＿＿＿＿＿＿＿</div></div>';
  window.print();
}

document.getElementById('nameInput').addEventListener('keydown', function(e){ if (e.key==='Enter') doSearch(); });
loadMaster();
</script>
</body></html>`;
}
// === 🦀休薬チェッカー: 利用ページ生成関数 (ここまで) ===　

// === 🦀メディカニ鑑別（持参薬サポート）: ページ生成関数 (ここから) ===
function jisanPage(hId, hospitalName) {
  const facilityBadge = hospitalName
    ? '<div style="display:inline-block; background:#fff; color:#d63384; font-size:12px; font-weight:bold; padding:4px 14px; border-radius:20px; border:1.5px solid #ffb6c1; margin-top:8px;">🏥 ' + hospitalName + '</div>'
    : '';
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦀</text></svg>">
<link rel="icon" type="image/png" sizes="512x512" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/icon_kan.png">
<link rel="apple-touch-icon" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/icon_kan.png">
<meta name="apple-mobile-web-app-title" content="メディカニ鑑別">
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
  /* ▼ 🧪裸錠の刻印OCR（試験中）追加分 */
  .btn-kokuin { width:100%; margin-top:10px; padding:14px 10px; background:#fff; color:var(--pink); border:2px solid var(--pink); border-radius:12px; font-weight:bold; font-size:14px; cursor:pointer; }
  .btn-kokuin:active { transform:scale(0.97); }
  .btn-kokuin .beta { font-size:11px; background:var(--pink); color:#fff; border-radius:8px; padding:1px 7px; margin-left:6px; vertical-align:middle; }
  #kokuinChips { display:none; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .kchip { display:inline-block; background:#fff; border:1.5px solid var(--pink); color:var(--pink); border-radius:20px; padding:9px 14px; font-size:14px; font-weight:bold; cursor:pointer; line-height:1.2; }
  .kchip:active { transform:scale(0.96); }
  .kchip.low { border-style:dashed; border-color:#e0a800; color:#b8860b; }
  .kchip.used { background:#f2fff2; border-color:#a5d6a7; color:#2e7d32; }
  .kchip.noimp { background:#f5f5f5; border-color:#ddd; color:#aaa; cursor:default; }
  .kchip .knote { font-size:10px; font-weight:normal; color:#999; margin-left:4px; }
  #kokuinStatus { text-align:center; font-size:13px; color:#888; margin-top:10px; }
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
      <div class="hint">💡 英数字2文字以上で検索できます。全角半角違いは気にしなくてOKカニ🦀 一部だけでも検索できます（例:「211」）。</div>
      <button class="btn-kokuin" onclick="document.getElementById('kokuinFile').click()">🧪 裸錠の刻印OCR<span class="beta">試験中</span></button>
      <input type="file" id="kokuinFile" accept="image/*" style="display:none">
      <div id="kokuinChips"></div>
      <div id="kokuinStatus"></div>
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

    // ===== 🧪 裸錠の刻印OCR（試験中）: 撮影→刻印チップ→タップで検索窓に入れて検索 =====
    var jKokuinChips = [];

    function jCompress(file, maxDim, quality) {
      return new Promise(function(resolve, reject){
        const img = new Image();
        const fr = new FileReader();
        fr.onload = function(){ img.src = fr.result; };
        fr.onerror = reject;
        img.onload = function(){
          let w = img.width, h = img.height;
          if (Math.max(w, h) > maxDim) { const sc = maxDim / Math.max(w, h); w = Math.round(w*sc); h = Math.round(h*sc); }
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        fr.readAsDataURL(file);
      });
    }

    async function jPostKokuin(file, st) {
      const plans = [ {dim:1600,q:0.8}, {dim:1280,q:0.75}, {dim:1000,q:0.7} ];
      let lastErr = null;
      for (let a = 0; a < plans.length; a++) {
        const dataUrl = await jCompress(file, plans[a].dim, plans[a].q);
        if (a > 0) st.textContent = '📶 電波が弱いので軽量化して再送信中(' + (a+1) + '回目)...🦀';
        try {
          const r = await fetch('/api/kokuin-ocr', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ h: HID, image: dataUrl })
          });
          const raw = await r.text();
          try { return JSON.parse(raw); }
          catch (pe) { throw new Error('HTTP ' + r.status + ' 非JSON応答'); }
        } catch (err) { lastErr = err; }
      }
      throw lastErr;
    }

    function jRenderKokuinChips() {
      const box = document.getElementById('kokuinChips');
      if (!jKokuinChips.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.style.display = 'flex';
      let html = '';
      for (const c of jKokuinChips) {
        if (!c.imprint) {
          html += '<span class="kchip noimp">（刻印なし）' + (c.note ? '<span class="knote">' + escHtml(c.note) + '</span>' : '') + '</span>';
        } else {
          const cls = c.used ? 'kchip used' : (c.confidence === '低' ? 'kchip low' : 'kchip');
          html += '<span class="' + cls + '" data-jchip="' + c.i + '">' + (c.used ? '✅ ' : '🔍 ') + escHtml(c.imprint)
            + (c.confidence === '低' ? '<span class="knote">自信なし</span>' : '')
            + (c.note ? '<span class="knote">' + escHtml(c.note) + '</span>' : '')
            + '</span>';
        }
      }
      box.innerHTML = html;
    }

    async function jHandleKokuinFile(e) {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;
      const st = document.getElementById('kokuinStatus');
      st.textContent = '💊 錠剤の刻印を読み取り中...🦀（少し時間がかかります）';
      try {
        const data = await jPostKokuin(files[0], st);
        if (data.error) { st.textContent = '⚠️ 読み取りエラー: ' + data.error; return; }
        if (!data.pills || !data.pills.length) { st.textContent = '📭 この写真からは錠剤が読み取れませんでしたカニ🦀💦 明るい場所で錠剤同士を離して撮ってみてね！'; return; }
        for (const ppp of data.pills) {
          jKokuinChips.push({ i: jKokuinChips.length, imprint: ppp.imprint || '', confidence: ppp.confidence || '中', note: ppp.note || '', used: false });
        }
        st.textContent = '✅ ' + data.pills.length + '錠分の刻印を読み取りましたカニ🦀 チップをタップすると検索できます！';
        jRenderKokuinChips();
      } catch (err) {
        st.textContent = '⚠️ 電波が不安定で送信できませんでしたカニ🦀💦（3回試しました）電波の良い場所で再度お試しください。';
      }
    }

    function jHandleChipTap(e) {
      const ch = e.target.closest('[data-jchip]');
      if (!ch) return;
      const c = jKokuinChips[Number(ch.getAttribute('data-jchip'))];
      if (!c || !c.imprint) return;
      inp.value = String(c.imprint).replace(/【[^】]*】/g, '').trim();
      c.used = true;
      jRenderKokuinChips();
      doSearch();
      document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ページ読み込み時にリスナーを登録（★doSearchの外で登録するのが重要）
    (function bindKokuinOcr(){
      const fileEl = document.getElementById('kokuinFile');
      const chipsEl = document.getElementById('kokuinChips');
      if (fileEl) fileEl.addEventListener('change', jHandleKokuinFile);
      if (chipsEl) chipsEl.addEventListener('click', jHandleChipTap);
    })();

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
              + (i.own ? '<span class="code-chip" style="border-style:solid; background:#e8f5e9; color:#2e7d32; border-color:#c8e6c9;">🏥 施設登録</span>' : '')
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

// === 🦀持参薬鑑別: KV照合ヘルパー（薬品名の配列→マスタ/採用とマッチング） (ここから) ===
async function kanbetsuMatchNames(names, hId, env) {
  // 正規化: 手動で全角英数・記号→半角に変換してから NFKC・大文字化・空白除去
  // ※マスタの薬品名は数字が全角（０．５ｍｇ等）なので、NFKCが効かない環境でも確実に揃うよう二重に変換する
  const z2h = (s) => String(s || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, ".").replace(/，/g, ",").replace(/％/g, "%")
    .replace(/｢/g, "「").replace(/｣/g, "」");
  const norm = (s) => z2h(s).normalize("NFKC").toUpperCase().replace(/\s+/g, "");
  // キーから薬品名部分を取り出す（採用キーは hId_ を剥がし、[カテゴリ]の後〜最初の_まで）
  const keyName = (k, isAdopted) => {
    let s = isAdopted ? k.substring(hId.length + 1) : k;
    const m = s.match(/^\[(内|外|注)\]([^_]+)/);
    return m ? m[2] : "";
  };

  // マスタ3カテゴリ＋施設の採用薬キーを1回だけ全リスト
  // 🌟変更: 毎回の全件list（4万件×3カテゴリ）をやめ、メモリキャッシュから取得する
  const masterKeys = await getMasterKeysCached(env);
  const adoptedKeys = await getAdoptedKeysCached(hId, env);
  const adoptedYJset = new Set(adoptedKeys.map(k => { const t = k.split("_").pop(); return t; }));

  // 🌟規格(用量)を名前から取り出す: 「エチゾラム錠0.5MG「NP」」→「0.5MG」。無ければ空文字
  const doseOf = (s) => {
    const m = String(s || "").match(/([0-9]+(?:\.[0-9]+)?)(MG|ΜG|MCG|G|ML|%)/);
    return m ? (m[1] + m[2]) : "";
  };
  // 🌟メーカー名「〇〇」を名前から取り出す: 「…「トーワ」」→「トーワ」。無ければ空文字
  const makerOf = (s) => {
    const m = String(s || "").match(/「([^」]+)」/);
    return m ? m[1] : "";
  };

  // 事前に正規化名リストを作っておく（毎クエリで再計算しない）
  const masterIndex = masterKeys.map(k => { const n = norm(keyName(k, false)); return { k: k, n: n, dose: doseOf(n), maker: makerOf(n), adopted: false }; });
  const adoptedIndex = adoptedKeys.map(k => { const n = norm(keyName(k, true)); return { k: k, n: n, dose: doseOf(n), maker: makerOf(n), adopted: true }; });
  const allIndex = [...adoptedIndex, ...masterIndex];

  const results = [];
  for (const rawName of names) {
    const qn = norm(rawName);
    if (qn.length < 2) { results.push({ found: false }); continue; }
    const qDose = doseOf(qn);
    const qMaker = makerOf(qn);
    // メーカー名を除いた版（「トーワ」付きで完全一致が無い時の再挑戦用）
    const qnNoMaker = qn.replace(/「[^」]*」/g, "");

    // スコアリング: 規格ガード → 採用優先 → 一致の強さ → 規格一致/メーカー一致の加点 → 名前の長さ
    let best = null;
    let bestScore = 0;
    for (const e of allIndex) {
      if (!e.n) continue;
      // 🌟規格ガード: クエリと候補の両方に規格があり、それが違うなら候補から除外する。
      //   （0.5mgの薬が1mgに化けるのは調剤事故に直結するため、規格違いは絶対にマッチさせない）
      if (qDose && e.dose && qDose !== e.dose) continue;
      let s = 0;
      if (e.n === qn) s = 500;
      else if (e.n.includes(qn)) s = 300;
      else if (qn.includes(e.n)) s = 200;
      else if (e.n.includes(qnNoMaker) && qnNoMaker.length >= 4) s = 250;
      else if (qDose && e.dose && qDose === e.dose && e.n.substring(0, 4) === qn.substring(0, 4)) s = 150;
      else if (qn.length >= 6 && e.n.startsWith(qn.substring(0, 6))) s = 100;
      if (s === 0) continue;
      if (e.adopted) s += 1000;
      if (qDose && e.dose && qDose === e.dose) s += 150;  // 🌟同じ規格なら加点
      if (qMaker && e.maker && qMaker === e.maker) s += 80; // 🌟同じメーカー「」なら加点
      s += Math.min(e.n.length, 50);
      if (s > bestScore) { bestScore = s; best = e; }
    }
    if (!best) { results.push({ found: false }); continue; }

    // ベスト1件のvalueを取得して詳細情報を組み立てる
    const val = await env.MEDI_KV.get(best.k);
    if (!val) { results.push({ found: false }); continue; }
    let parts = String(val).split(/[,\uFF0C]/);
    const yj = getBestYJ(best.k, parts);
    const isAdopted = best.adopted || (yj && adoptedYJset.has(yj));
    // 採用キーだった場合はマスタ情報で上書きして先発マーク・薬価を復活（通常検索と同じ）
    if (best.adopted && yj && yj !== "NONE") {
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
    const extracted = extractDrugData(parts, yj);
    const isBrand = parts.some(p => String(p).includes("先発"));
    results.push({ found: true, key: best.k, name: extracted.name, spec: extracted.spec, price: extracted.price, isBrand: isBrand, isAdopted: isAdopted, yj: yj });
  }
  return results;
}
// === 🦀持参薬鑑別: KV照合ヘルパー (ここまで) ===

// === 🦀持参薬鑑別(開発版): ページ生成関数 (ここから) ===
function kanbetsuPage(hId, hospitalName) {
  const facilityBadge = hospitalName
    ? '<div style="display:inline-block; background:#fff; color:#d63384; font-size:12px; font-weight:bold; padding:4px 14px; border-radius:20px; border:1.5px solid #ffb6c1; margin-top:8px;">🏥 ' + hospitalName + '</div>'
    : '';
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦀</text></svg>">
<link rel="icon" type="image/png" sizes="512x512" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/icon_kan.png">
<link rel="apple-touch-icon" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/icon_kan.png">
<meta name="apple-mobile-web-app-title" content="メディカニ鑑別">
<title>メディカニ鑑別（開発版）</title>
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
  /* ▼ 🌟追加: 検索モード切替（🔍刻印 ／ 🔍薬名） */
  .mode-row { display:flex; gap:8px; margin-top:8px; }
  .mode-btn { flex:1; padding:13px 10px; background:#fff; color:var(--pink); border:2px solid var(--pink); border-radius:12px; font-weight:bold; font-size:14px; cursor:pointer; }
  .mode-btn.on { background:var(--pink); color:#fff; }
  .mode-btn:active { transform:scale(0.97); }
  /* ▼ 🌟追加: 結果カードの「鑑別リストに追加」 */
  .card-actions { display:flex; gap:8px; margin-top:10px; }
  .btn-add { flex:1; background:var(--pink); color:#fff; border:none; border-radius:10px; padding:11px 12px; font-size:13px; font-weight:bold; cursor:pointer; }
  .btn-add:active { transform:scale(0.97); }
  .btn-add.done { background:#e8f5e9; color:#1b5e20; border:1px solid #a5d6a7; }
  .card.added { border-left-color:var(--pink); background:#fffafc; }
  /* ▼ 🌟追加: 外用・注射も含めて再検索 */
  .btn-widen { display:block; width:100%; margin-top:12px; padding:12px; background:#fff; color:#0056b3; border:1.5px dashed #90caf9; border-radius:10px; font-size:13px; font-weight:bold; cursor:pointer; }
  .btn-widen:active { transform:scale(0.98); }
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
  /* ▼ 持参薬鑑別(開発版) 追加分 */
  .ocr-row { display:flex; gap:8px; margin-top:12px; }
  .btn-ocr { flex:1; padding:14px 10px; background:#d63384; color:#fff; border:none; border-radius:12px; font-weight:bold; font-size:14px; cursor:pointer; }
  .btn-ocr:active { transform:scale(0.97); }
  .btn-phone { flex:1; padding:14px 10px; background:#e9ecef; color:#adb5bd; border:1px solid #dee2e6; border-radius:12px; font-weight:bold; font-size:13px; cursor:not-allowed; }
  /* ▼ 📱手帳QR（JAHIS）追加分 */
  .btn-qr { flex:1; padding:14px 10px; background:#fff; color:var(--pink); border:2px solid var(--pink); border-radius:12px; font-weight:bold; font-size:13px; cursor:pointer; }
  .btn-qr:active { transform:scale(0.97); }
  #qrOverlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); display:none; z-index:1400; flex-direction:column; justify-content:center; align-items:center; padding:16px; box-sizing:border-box; }
  #qrVideoWrap { position:relative; width:100%; max-width:360px; aspect-ratio:1/1; background:#000; border-radius:16px; overflow:hidden; }
  #qrVideo { width:100%; height:100%; object-fit:cover; }
  #qrFrame { position:absolute; inset:12%; border:3px solid #fff; border-radius:12px; pointer-events:none; }
  #qrCount { color:#fff; font-weight:bold; font-size:15px; margin:14px 0 4px; text-align:center; }
  #qrHint { color:#ddd; font-size:12px; text-align:center; margin-bottom:14px; }
  .qr-btn { width:100%; max-width:360px; padding:14px; border:none; border-radius:12px; font-weight:bold; font-size:15px; cursor:pointer; margin-top:8px; }
  .qr-btn.go { background:var(--pink); color:#fff; }
  .qr-btn.cancel { background:#555; color:#fff; }
  /* ▼ 💊裸錠まとめ撮り→刻印OCR 追加分 */
  .btn-kokuin { width:100%; margin-top:8px; padding:14px 10px; background:#fff; color:var(--pink); border:2px solid var(--pink); border-radius:12px; font-weight:bold; font-size:14px; cursor:pointer; }
  .btn-kokuin:active { transform:scale(0.97); }
  #kokuinChips { display:none; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .kchip { display:inline-block; background:#fff; border:1.5px solid var(--pink); color:var(--pink); border-radius:20px; padding:9px 14px; font-size:14px; font-weight:bold; cursor:pointer; line-height:1.2; }
  .kchip:active { transform:scale(0.96); }
  .kchip.low { border-style:dashed; border-color:#e0a800; color:#b8860b; }
  .kchip.used { background:#f2fff2; border-color:#a5d6a7; color:#2e7d32; }
  .kchip.noimp { background:#f5f5f5; border-color:#bbb; border-style:dashed; color:#888; cursor:pointer; }
  .btn-addmed { width:100%; margin-top:8px; padding:13px 10px; background:#f0fafd; color:#00838f; border:1.5px dashed #4dd0e1; border-radius:12px; font-weight:bold; font-size:13px; cursor:pointer; }
  .btn-addmed:active { transform:scale(0.97); }
  .kchip .knote { font-size:10px; font-weight:normal; color:#999; margin-left:4px; }
  /* ▼ kpモーダル（刻印からお薬を特定）の入力欄・検索ボタンを大きく */
  #kpQ { font-size:19px !important; font-weight:bold; padding:12px 10px !important; letter-spacing:0.5px; flex:1 1 auto; min-width:0 !important; width:auto !important; box-sizing:border-box; }
  #kpSearchBtn { font-size:16px !important; font-weight:bold; padding:12px 16px !important; flex:0 0 auto; white-space:nowrap; }
  .jlist-title { font-weight:bold; font-size:14px; color:#555; margin:18px 0 10px; }
  .jitem { background:#fff; border-radius:15px; padding:14px 16px; margin-bottom:12px; box-shadow:0 4px 10px rgba(0,0,0,0.03); border-left:6px solid #ccc; position:relative; }
  .jitem.adopted { border-left-color:#28a745; }
  .jitem.unmatched { border-left-color:#ffc107; background:#fffdf5; }
  .jitem .del { position:absolute; top:8px; right:10px; background:none; border:none; color:#ccc; font-size:16px; cursor:pointer; padding:4px; }
  .usage-line { font-size:13px; color:#555; margin-top:8px; background:#f8f9fa; border:1px dashed #ddd; border-radius:8px; padding:7px 10px; cursor:pointer; }
  .usage-line .lbl { color:#0d6efd; font-weight:bold; font-size:11px; }
  .ocr-src { font-size:10px; color:#bbb; margin-top:6px; }
  .name-edit { cursor:pointer; text-decoration:underline dotted #ffc107; }
  #editModalOverlay { position: fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:none; z-index:3000; justify-content:center; align-items:center; }
  .edit-modal { background:#fff; width:90%; max-width:380px; border-radius:20px; padding:20px; }
  .edit-modal textarea { width:100%; min-height:70px; padding:10px; font-size:15px; border:1.5px solid #ddd; border-radius:10px; outline:none; box-sizing:border-box; }
  .edit-modal textarea:focus { border-color:#d63384; }
  .edit-btns { display:flex; gap:8px; margin-top:12px; }
  .edit-btns button { flex:1; padding:11px; border:none; border-radius:10px; font-weight:bold; font-size:14px; cursor:pointer; }
  #pickerOverlay { position: fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:none; z-index:1200; justify-content:center; align-items:center; }
  .picker-modal { background:#fff; width:92%; max-width:400px; border-radius:20px; padding:18px; max-height:85vh; overflow-y:auto; }
  .picker-cats { display:flex; gap:6px; margin-bottom:10px; }
  .picker-cats button { flex:1; padding:8px 4px; border-radius:10px; font-size:12px; font-weight:bold; cursor:pointer; border:1.5px dashed #4dd0e1; background:#f0fafd; color:#00838f; }
  .picker-cats button.on { background:#4dd0e1; border-style:solid; color:#fff; }
  .picker-row { display:flex; gap:6px; }
  #pickerQ { flex:1; min-width:0; padding:11px 12px; font-size:15px; border:1.5px solid #ddd; border-radius:10px; outline:none; }
  #pickerQ:focus { border-color:#d63384; }
  #pickerSearchBtn { padding:11px 14px; background:#d63384; color:#fff; border:none; border-radius:10px; font-weight:bold; cursor:pointer; white-space:nowrap; }
  .pick-item { background:#f8f9fa; border:1px solid #eee; border-radius:12px; padding:11px 12px; margin-top:8px; cursor:pointer; }
  .pick-item.adopted { background:#f2fff2; border-color:#d1ffd1; }
  .pick-item:active { background:#e9ecef; }
  .decide-box { border:1.5px solid #eee; border-radius:12px; padding:10px 12px; margin-top:10px; background:#fafafa; }
  .decide-box.keep { border-color:#c8e6c9; background:#f2fff2; }
  .decide-box.switch { border-color:#ffd9a8; background:#fff8f0; }
  .decide-label { font-weight:bold; font-size:13px; cursor:pointer; text-decoration:underline dotted; }
  .decide-box.keep .decide-label { color:#28a745; }
  .decide-box.switch .decide-label { color:#e65100; }
  .btn-report { width:100%; margin-top:14px; padding:15px; background:#00838f; color:#fff; border:none; border-radius:12px; font-weight:bold; font-size:15px; cursor:pointer; }
  .btn-report:active { transform:scale(0.98); }
  #reportView { position:fixed; top:0; left:0; width:100%; height:100%; background:#fffaf5; z-index:2000; display:none; overflow-y:auto; }
  .rv-inner { max-width:640px; margin:0 auto; padding:7px 14px 20px; }
  .rv-btns { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:5px; }
  .rv-btns button { padding:12px 4px; border:none; border-radius:12px; font-weight:bold; font-size:13px; cursor:pointer; }
  .rv-head { background:#ffe4e1; border:2px solid #ffd1dc; border-radius:14px; text-align:center; padding:4px 10px; margin-bottom:4px; }
  .rv-kani { width:30px; height:30px; vertical-align:middle; margin-right:7px; }
  .rv-title { font-size:16px; font-weight:bold; color:#d63384; letter-spacing:1px; vertical-align:middle; }
  .rv-metabox { background:#fff; border:1.5px solid #ffd1dc; border-radius:10px; padding:4px 10px; margin-bottom:4px; font-size:12px; color:#333; line-height:1.5; }
  .rv-editrow { cursor:pointer; background:#fdf7fa; border:1.5px dashed #f3a9c9; border-radius:8px; padding:5px 10px; margin-top:3px; font-size:12px; }
  .rv-edithint { font-size:10px; color:#d63384; }
  .rv-card { background:#fff; border-radius:10px; padding:5px 10px; margin-bottom:3px; border-left:5px solid #ccc; box-shadow:0 1px 3px rgba(0,0,0,0.04); font-size:12px; color:#222; }
  .rv-card.keep { border-left-color:#28a745; }
  .rv-card.switch { border-left-color:#fd7e14; }
  .rv-card.undecided { border-left-color:#adb5bd; }
  .rv-card.unmatched { border-left-color:#ffc107; background:#fffdf5; }
  .rv-lbl { display:inline-block; font-size:10px; font-weight:bold; padding:2px 8px; border-radius:10px; margin-right:6px; vertical-align:middle; }
  .rv-lbl.src { background:#e3f2fd; color:#0d47a1; }
  .rv-lbl.keep { background:#d1ffd1; color:#155724; }
  .rv-lbl.switch { background:#ffe6cc; color:#b35900; }
  .rv-dname { font-weight:bold; font-size:13px; line-height:1.45; }
  .rv-usage { font-size:11px; color:#555; margin-top:1px; margin-left:4px; }
  .rv-dst { margin-top:3px; padding-top:3px; border-top:1px dashed #eee; }
  .rv-undecided { font-size:11px; color:#999; margin-top:4px; }
  .rv-note { font-size:9px; color:#999; margin-top:4px; line-height:1.5; text-align:center; }
  .rv-footer { text-align:center; margin-top:4px; padding:4px 10px; background:#fff0f5; border-radius:10px; }
  .rv-footer .t1 { font-size:12px; font-weight:bold; color:#d63384; }
  .rv-footer .fac { font-size:11px; font-weight:bold; color:#a05070; margin-left:8px; }
  .rv-footer .t2 { font-size:9px; color:#aa8899; margin-top:2px; }
  /* ===== 🌟追加: 用法選択モーダル ===== */
  #yohoOverlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:none; z-index:1400; justify-content:center; align-items:center; }
  .yoho-modal { background:#fff; border-radius:16px; padding:14px; width:92%; max-width:460px; max-height:88vh; overflow-y:auto; }
  .yoho-ttl { font-weight:bold; font-size:14px; color:#555; margin-bottom:8px; }
  .yoho-dose { display:flex; gap:6px; align-items:center; background:#fff6fa; border:1.5px solid #ffd1dc; border-radius:10px; padding:8px 10px; margin-bottom:8px; }
  .yoho-dose span { font-size:13px; color:#a05070; font-weight:bold; white-space:nowrap; }
  .yoho-dose select { flex:1; min-width:0; padding:8px; font-size:15px; border:1.5px solid #ffd1dc; border-radius:8px; background:#fff; }
  .yoho-find { width:100%; padding:9px 10px; font-size:14px; border:1.5px solid #ddd; border-radius:9px; margin-bottom:8px; }
  .yoho-list { max-height:34vh; overflow-y:auto; border:1px solid #f0e0e8; border-radius:10px; padding:6px; background:#fffdfe; }
  .yoho-cat { font-size:11px; font-weight:bold; color:#a05070; background:#ffeef5; border-radius:5px; padding:2px 8px; display:inline-block; margin:6px 0 4px; }
  .yoho-btn { display:inline-block; background:#fff; border:1.5px solid #ffd1dc; color:#333; border-radius:16px; padding:7px 12px; margin:0 5px 5px 0; font-size:12.5px; cursor:pointer; }
  .yoho-btn:active { background:#ffeef5; }
  .yoho-btn.on { background:#d63384; border-color:#d63384; color:#fff; font-weight:bold; }
  .yoho-btn .ab { font-size:10px; color:#aaa; margin-left:5px; }
  .yoho-btn.on .ab { color:#ffd9e8; }
  .yoho-own { font-size:9px; background:#e8f5e9; color:#2e7d32; border-radius:4px; padding:1px 4px; margin-left:4px; }
  .yoho-free { width:100%; padding:9px 10px; font-size:15px; border:1.5px solid #ddd; border-radius:9px; margin-top:8px; }
  .yoho-prev { background:#f7f7f7; border-radius:9px; padding:8px 10px; margin-top:8px; font-size:13px; color:#333; word-break:break-all; }
  .yoho-prev .pl { font-size:10px; color:#999; display:block; }
  .yoho-prev .pa { font-size:11px; color:#888; margin-top:3px; display:block; }
  .yoho-btns { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-top:10px; }
  .yoho-btns button { padding:11px 4px; border:none; border-radius:10px; font-weight:bold; font-size:13px; cursor:pointer; }
  /* ===== 🌟追加: 帳票の定型テキスト／署名 ===== */
  .rv-tmpl { background:#fff; border:1.5px solid #ffd1dc; border-radius:10px; padding:6px 10px; margin-bottom:4px; font-size:12px; color:#222; line-height:1.6; white-space:pre-wrap; }
  .rv-sign { text-align:right; font-size:12px; color:#222; line-height:1.9; padding:4px 10px 0; margin-bottom:4px; white-space:pre-wrap; }
  @media print {
    body > *:not(#reportView) { display:none !important; }
    body { background:#fff !important; height:auto !important; }
    #reportView { display:block !important; position:static !important; width:auto; height:auto !important; overflow:visible !important; background:#fff; }
    .no-print { display:none !important; }
    .rv-editrow { border:none; background:none; padding:3px 0; }
    .rv-edithint { display:none; }
    .rv-card { box-shadow:none; border:1px solid #eee; page-break-inside:avoid; }
    .rv-card.keep { border-left:5px solid #28a745; }
    .rv-card.switch { border-left:5px solid #fd7e14; }
    .rv-card.undecided { border-left:5px solid #adb5bd; }
    .rv-card.unmatched { border-left:5px solid #ffc107; }
    /* 🌟変更: ※本結果は… と施設フッターを【全ページの下端】に固定する */
    @page { margin: 10mm 8mm 26mm; }
    .rv-inner { padding-bottom:0 !important; }
    .rv-pfoot { position:fixed; bottom:0; left:0; right:0; background:#fff; padding-top:3px; }
    .rv-tmpl { border:1px solid #eee; page-break-inside:avoid; }
    .rv-sign { page-break-inside:avoid; }
    * { -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
  }
</style></head>
<body>
  <div class="header">
    <h1>🦀 メディカニ鑑別 <span style="font-size:11px; color:#a58; font-weight:normal;">開発版</span></h1>
    <div class="sub">お薬手帳のOCRと刻印検索で持参薬を鑑別するツールですカニ🦀</div>
    ${facilityBadge}
  </div>
  <div class="container">
    <div class="search-box">
      <div class="search-row">
        <input type="text" id="kokuin" placeholder="刻印・薬名を入力（例：HP211、タケキャブ）" autocomplete="off" inputmode="latin">
      </div>
      <div class="mode-row">
        <button class="mode-btn on" id="btnModeKokuin" onclick="doSearch('kokuin')">🔍 刻印</button>
        <button class="mode-btn" id="btnModeName" onclick="doSearch('name')">🔍 薬名</button>
      </div>
      <div class="hint" id="searchHint">💡 英数字2文字以上で検索できます。大文字小文字・全角半角・スペースの違いは気にしなくてOKカニ🦀 一部だけでも検索できます（例:「211」）。</div>
    </div>
    <div class="ocr-row">
      <button class="btn-ocr" onclick="document.getElementById('ocrFile').click()">📷 手帳OCR</button>
      <button class="btn-qr" onclick="openQrScanner()">📱 手帳QR</button>
    </div>
    <input type="file" id="ocrFile" accept="image/*" multiple style="display:none">
    <button class="btn-kokuin" onclick="document.getElementById('kokuinFile').click()">💊 裸錠の刻印OCR（まとめ撮り対応）</button>
    <input type="file" id="kokuinFile" accept="image/*" style="display:none">
    <div id="kokuinChips"></div>
    <!-- 🌟撤去: ➕お薬名で検索して追加 → 検索窓の「🔍 薬名」に統合。openPickerForAdd() は刻印なしチップから使うので関数は残す -->
    <div id="ocrStatus" style="text-align:center; font-size:13px; color:#888; margin-top:10px;"></div>
    <div id="qrOverlay">
      <div id="qrVideoWrap"><video id="qrVideo" playsinline muted></video><div id="qrFrame"></div></div>
      <div id="qrCount">お薬手帳のQRを枠に合わせてね🦀</div>
      <div id="qrHint">QRが複数あるときは1個ずつ順番にかざしてください</div>
      <button class="qr-btn go" id="qrGoBtn" onclick="analyzeQr()" style="display:none;">この内容で解析する</button>
      <button class="qr-btn cancel" onclick="closeQrScanner()">閉じる</button>
    </div>
    <!-- 🌟変更: 検索候補（status／results）を持参薬リストより【上】に移動 -->
    <div id="status"></div>
    <div id="results"></div>
    <div id="jlistArea" style="display:none;">
      <div class="jlist-title">📋 持参薬リスト <span id="jlistCount" style="font-weight:normal; color:#999; font-size:12px;"></span></div>
      <div id="jlist"></div>
      <button class="btn-report" onclick="openReport()">📄 メディカニ鑑別結果を作成する 🦀</button>
    </div>
    <div class="notice">
      ⚠️ 本ツールは添付文書の識別コード情報をもとに候補を絞り込む<b>補助ツール</b>です。刻印情報が登録されていない製剤もあります。<b>最終的な同定は必ず現物・添付文書でご確認ください。</b>
    </div>
  </div>
  <div class="footer">
    🦀 メディカニ鑑別（β）<br>© 2026 🐔トリの巣ワークス メディカニ運営事務局
  </div>

  <div id="modalOverlay"><div class="modal" onclick="event.stopPropagation()">
    <button class="modal-close" onclick="closeModal()">×</button>
    <div id="modalBody"></div>
  </div></div>

  <div id="editModalOverlay"><div class="edit-modal" onclick="event.stopPropagation()">
    <div id="editModalTitle" style="font-weight:bold; font-size:14px; color:#555; margin-bottom:10px;">✏️ 編集</div>
    <textarea id="editModalText"></textarea>
    <div class="edit-btns">
      <button style="background:#eee; color:#666;" onclick="closeEditModal()">キャンセル</button>
      <button style="background:#d63384; color:#fff;" onclick="saveEditModal()">保存</button>
    </div>
  </div></div>

  <div id="pickerOverlay"><div class="picker-modal" onclick="event.stopPropagation()">
    <div style="font-weight:bold; font-size:14px; color:#555; margin-bottom:10px;">🔍 メディカニ検索から薬を選ぶ</div>
    <div class="picker-cats">
      <button data-pcat="[内]" class="on">💊 内服</button>
      <button data-pcat="[外]">🩹 外用</button>
      <button data-pcat="[注]">💉 注射</button>
    </div>
    <div class="picker-row">
      <input type="text" id="pickerQ" placeholder="お薬名（かな・カナ）...">
      <button id="pickerSearchBtn" onclick="pickerSearch()">検索</button>
    </div>
    <div id="pickerStatus" style="text-align:center; font-size:12px; color:#888; margin-top:10px;"></div>
    <div id="pickerResults"></div>
    <button style="width:100%; margin-top:12px; padding:11px; background:#eee; color:#666; border:none; border-radius:10px; font-weight:bold; cursor:pointer;" onclick="closePicker()">閉じる</button>
  </div></div>

  <div id="kpOverlay" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:none; z-index:1300; justify-content:center; align-items:center;"><div class="picker-modal" onclick="event.stopPropagation()">
    <div style="font-weight:bold; font-size:14px; color:#555; margin-bottom:4px;">💊 刻印からお薬を特定</div>
    <div style="font-size:11px; color:#999; margin-bottom:10px;">読み取った刻印で検索します。文字を直して再検索もできるカニ🦀</div>
    <div class="picker-row">
      <input type="text" id="kpQ" placeholder="刻印（例：HP211）" autocomplete="off">
      <button id="kpSearchBtn" onclick="kpSearch()">検索</button>
    </div>
    <div id="kpStatus" style="text-align:center; font-size:12px; color:#888; margin-top:10px;"></div>
    <div id="kpResults"></div>
    <button style="width:100%; margin-top:12px; padding:11px; background:#eee; color:#666; border:none; border-radius:10px; font-weight:bold; cursor:pointer;" onclick="closeKp()">閉じる</button>
  </div></div>

  <!-- 🌟追加: 用法選択モーダル（用量プルダウン＋単位プルダウン＋用法マスタ＋自由入力） -->
  <div id="yohoOverlay"><div class="yoho-modal" onclick="event.stopPropagation()">
    <div class="yoho-ttl" id="yohoTitle">📝 用法を入力</div>
    <div class="yoho-dose">
      <span>1回</span>
      <select id="yohoDose"></select>
      <select id="yohoUnit"></select>
    </div>
    <input type="text" class="yoho-find" id="yohoFind" placeholder="用法をしぼり込み（例：毎食後、就寝前）" autocomplete="off">
    <div class="yoho-list" id="yohoList"></div>
    <input type="text" class="yoho-free" id="yohoFree" placeholder="自由入力（用法を選ぶとここに入ります。直接書き換えもOK）">
    <div class="yoho-prev" id="yohoPrev"></div>
    <div class="yoho-btns">
      <button style="background:#eee; color:#666;" onclick="closeYoho()">キャンセル</button>
      <button style="background:#fff0f5; color:#d63384; border:1.5px solid #ffd1dc;" onclick="clearYoho()">クリア</button>
      <button style="background:#d63384; color:#fff;" onclick="saveYoho()">決定</button>
    </div>
  </div></div>

  <div id="reportView"><div class="rv-inner">
    <div class="rv-btns no-print">
      <button style="background:#eee; color:#555;" onclick="closeReport()">← 戻る</button>
      <button style="background:#0d6efd; color:#fff;" onclick="copyReport()">📋 コピー</button>
      <button style="background:#00838f; color:#fff;" onclick="printReport()">🖨️ 印刷</button>
      <button style="background:#d63384; color:#fff;" onclick="pdfReport()">📄 PDF</button>
    </div>
    <div id="rvHint" class="no-print" style="text-align:center; font-size:11px; color:#888; margin-bottom:10px;"></div>
    <div id="reportBody"></div>
  </div></div>

  <script>
    const HID = "${hId}";
    const HNAME = "${(hospitalName || '').replace(/"/g, '')}";
    const inp = document.getElementById('kokuin');
    inp.addEventListener('keydown', function(e){ if (e.key === 'Enter') doSearch(); });
    // 🖼️画像検索は委譲、カードタップは詳細モーダルを開く（ボタン優先）
    document.getElementById('results').addEventListener('click', function(e){
      // 🌟追加: カードタップ（詳細モーダル）より先に「➕追加」を拾う
      const a = e.target.closest('.btn-add');
      if (a) { e.stopPropagation(); addFromSearch(Number(a.getAttribute('data-add')), a); return; }
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

    // ===== 🌟追加: 検索モード管理（🔍刻印 ／ 🔍薬名） =====
    var searchMode = 'kokuin';   // 'kokuin' | 'name'
    window._searchList = [];     // 追加処理から参照するため検索結果を保持

    function setSearchMode(mode) {
      searchMode = mode;
      document.getElementById('btnModeKokuin').classList.toggle('on', mode === 'kokuin');
      document.getElementById('btnModeName').classList.toggle('on', mode === 'name');
      const el = document.getElementById('kokuin');
      if (mode === 'kokuin') {
        el.placeholder = '刻印や薬名を入力（例：HP211、タケキャブ)';
        el.setAttribute('inputmode', 'latin');
        document.getElementById('searchHint').innerHTML = '💡 英数字2文字以上で検索できます。大文字小文字・全角半角・スペースの違いは気にしなくてOKカニ🦀 一部だけでも検索できます（例:「211」）。';
      } else {
        el.placeholder = 'お薬名を入力（例：ロキソプロフェン、ばいあすぴりん）';
        el.setAttribute('inputmode', 'text');
        document.getElementById('searchHint').innerHTML = '💡 2文字以上で検索できます。ひらがなでもOKカニ🦀 まずは<b>内服薬</b>から探します。見つからないときは外用・注射も再検索できます。';
      }
      // 刻印の結果と薬名の結果が混ざると危険なので、モード切替では必ずクリアする
      document.getElementById('results').innerHTML = '';
      document.getElementById('status').textContent = '';
      window._searchList = [];
    }

    // 引数なし（Enterキー）のときは現在のモードで検索する
    async function doSearch(mode) {
      if (mode && mode !== searchMode) setSearchMode(mode);
      const q = inp.value.trim();
      const st = document.getElementById('status');
      const res = document.getElementById('results');
      res.innerHTML = '';
      window._searchList = [];
      if (q.replace(/\s/g,'').length < 2) {
        st.textContent = '2文字以上入力してくださいカニ🦀';
        return;
      }
      if (searchMode === 'kokuin') { await runKokuinSearch(q); }
      else { await runNameSearch(q, false); }
    }

    // ----- 🔍刻印: PMDA識別コード索引から検索 -----
    async function runKokuinSearch(q) {
      const st = document.getElementById('status');
      const res = document.getElementById('results');
      st.textContent = '検索中...🦀';
      try {
        const r = await fetch('/api/jisan-search?h=' + encodeURIComponent(HID) + '&q=' + encodeURIComponent(q));
        const data = await r.json();
        if (data.error === 'index_not_found') { st.textContent = '刻印データが未登録です。管理者にお問い合わせください。'; return; }
        if (data.error) { st.textContent = 'エラーが発生しました（' + data.error + '）'; return; }
        const list = data.results || [];
        if (!list.length) {
          st.textContent = '';
          res.innerHTML = '<div class="no-results">📭 「' + escHtml(q) + '」に一致する刻印は見つかりませんでしたカニ🦀💦<br><span style="font-size:12px;color:#aaa;">刻印の一部だけで再検索してみてね！</span></div>';
          return;
        }
        st.textContent = list.length + '件の候補が見つかりました' + (list.length >= 50 ? '（上位50件を表示。文字を足して絞り込めます）' : '') + 'カニ🦀';
        window._searchList = list;
        res.innerHTML = list.map(function(i, idx){ return searchCardHtml(i, idx, 'kokuin'); }).join('');
      } catch (e) {
        st.textContent = '通信エラーが発生したカニ🦀💦 少し待ってからもう一度お試しください。';
      }
    }

    // ----- 🔍薬名: メディカニ本体の検索。既定は内服のみ、ヒットゼロなら外用・注射に広げる -----
    async function runNameSearch(q, wide) {
      const st = document.getElementById('status');
      const res = document.getElementById('results');
      st.textContent = wide ? '外用・注射も含めて検索中...🦀' : '内服薬を検索中...🦀';
      try {
        const cat = wide ? 'all' : '[内]';
        const r = await fetch('/api/search?q=' + encodeURIComponent(q) + '&c=' + encodeURIComponent(cat) + '&h=' + encodeURIComponent(HID));
        const data = await r.json();
        if (data && data.error) { st.textContent = 'エラーが発生しました（' + data.error + '）'; return; }
        const list = Array.isArray(data) ? data : [];
        if (!list.length) {
          st.textContent = '';
          res.innerHTML = '<div class="no-results">📭 「' + escHtml(q) + '」に一致する' + (wide ? 'お薬' : '内服薬') + 'は見つかりませんでしたカニ🦀💦</div>'
            + (wide ? '' : '<button class="btn-widen" onclick="widenNameSearch()">🔎 外用・注射も含めて再検索する（湿布・点眼・軟膏など）</button>');
          return;
        }
        st.textContent = list.length + '件の候補が見つかりましたカニ🦀' + (wide ? '（外用・注射を含む）' : '（内服薬）');
        window._searchList = list;
        res.innerHTML = list.map(function(i, idx){ return searchCardHtml(i, idx, 'name'); }).join('');
      } catch (e) {
        st.textContent = '通信エラーが発生したカニ🦀💦';
      }
    }

    function widenNameSearch() {
      const q = inp.value.trim();
      if (q.replace(/\s/g,'').length >= 2) runNameSearch(q, true);
    }

    // ----- 結果カード（刻印・薬名で見た目を統一。どちらも「追加」できる）-----
    function searchCardHtml(i, idx, mode) {
      const nameForImg = String(i.name || '');
      const chip = (mode === 'kokuin')
        ? '<span class="code-chip">刻印: ' + escHtml(i.code || '') + '</span>'
            + (i.own ? '<span class="code-chip" style="border-style:solid; background:#e8f5e9; color:#2e7d32; border-color:#c8e6c9;">🏥 施設登録</span>' : '')
        : (i.component
            ? '<span class="code-chip" style="border-style:solid; background:#f3e5f5; color:#7b1fa2; border-color:#e1bee7;">🧬 ' + escHtml(i.component) + '</span>'
            : '<span></span>');
      return '<div class="card ' + (i.isAdopted ? 'adopted' : '') + '"' + (i.key ? ' data-key="' + escHtml(i.key) + '"' : '') + '>'
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
        + '<div class="code-row">' + chip + '<button class="btn-img" data-name="' + escHtml(nameForImg) + '">🖼️ 画像検索</button></div>'
        + '<div class="card-actions"><button class="btn-add" data-add="' + idx + '">➕ 鑑別リストに追加</button></div>'
        + (i.key
            ? '<div class="tap-hint">👆 カードをタップでお薬詳細・切替候補を表示カニ🦀</div>'
            : '<div style="margin-top:8px;"><span class="tag red" style="font-size:10px;">薬価マスタ未収載</span> <a class="pmda-link" href="https://www.pmda.go.jp/PmdaSearch/rdSearch/02/' + escHtml(i.yj) + '?user=1" target="_blank" onclick="event.stopPropagation()">📄 添付文書等のお薬詳細を見る（PMDA公式）</a></div>')
        + '</div>';
    }

    // ----- 検索結果 → 持参薬リストに追加（刻印・薬名 共通の出口）-----
    function addFromSearch(idx, btnEl) {
      const it = (window._searchList || [])[idx];
      if (!it) return;
      const dup = kanbetsuList.some(function(x){ return x.m && x.m.yj && it.yj && x.m.yj === it.yj; });
      kanbetsuSeq++;
      kanbetsuList.push({
        id: kanbetsuSeq,
        ocrName: (searchMode === 'kokuin') ? ('刻印 ' + (it.code || '')) : '薬名検索',
        name: it.name,
        usage: '',
        m: { found: true, key: it.key || '', name: it.name, spec: it.spec || '', price: it.price || '', isBrand: !!it.isBrand, isAdopted: !!it.isAdopted, yj: it.yj || '' }
      });
      const card = btnEl.closest('.card');
      if (card) card.classList.add('added');
      btnEl.textContent = '✅ 追加済み（もう一度押すと再追加）';
      btnEl.classList.add('done');
      renderJList();
      const msg = (dup ? '⚠️ 同じ薬がすでにリストにあります：' : '✅ ') + '「' + it.name + '」を持参薬リストに追加しましたカニ🦀';
      document.getElementById('status').textContent = msg;
      document.getElementById('ocrStatus').textContent = msg;
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

    // ===== 📷 持参薬鑑別: OCR＆持参薬リスト（フェーズ1） =====
    let kanbetsuList = [];   // {id, ocrName, name, usage, m:{found,key,name,spec,price,isBrand,isAdopted,yj}|null}
    let kanbetsuSeq = 0;
    let editTarget = null;   // {id, field}

    // 🔧DEBUG: 通信エラーの原因特定用ヘルパー（原因判明後に削除予定）
    function dbgSec(t0){ return Math.round((Date.now() - t0) / 100) / 10; }
    function dbgErr(err){
      if (!err) return '不明なエラー';
      let s = (err.name ? err.name + ': ' : '') + (err.message || String(err));
      if (err.name === 'TypeError' && /fetch|network|load/i.test(err.message || '')) s += '（回線切断・電波不安定の可能性大）';
      if (err.name === 'AbortError') s += '（タイムアウト/中断）';
      return s.slice(0, 200);
    }

    // 📶 弱い回線対策: 段階圧縮付きリトライ送信
    // 指定サイズ・画質で圧縮（compressImage/HQのパラメータ版）
    function compressTo(file, maxDim, quality) {
      return new Promise(function(resolve, reject){
        const img = new Image();
        const fr = new FileReader();
        fr.onload = function(){ img.src = fr.result; };
        fr.onerror = reject;
        img.onload = function(){
          let w = img.width, h = img.height;
          if (Math.max(w, h) > maxDim) {
            const scale = maxDim / Math.max(w, h);
            w = Math.round(w * scale); h = Math.round(h * scale);
          }
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        fr.readAsDataURL(file);
      });
    }

    // 送信失敗したらひと回り小さい画像で自動再送（plansの順に最大len回試行）
    // 成功: { data, mb, attempt } を返す / 全滅: 最後のエラーをthrow
    async function postImageWithRetry(apiUrl, file, plans, st, label) {
      let lastErr = null;
      for (let a = 0; a < plans.length; a++) {
        const dataUrl = await compressTo(file, plans[a].dim, plans[a].q);  // 圧縮失敗は即throw（リトライ無意味）
        const mb = (dataUrl.length / 1048576).toFixed(1);
        if (a > 0) st.textContent = label + ' 電波が弱いので軽量化して再送信中(' + (a+1) + '回目・' + mb + 'MB)...🦀';
        try {
          const r = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ h: HID, image: dataUrl })
          });
          const raw = await r.text();
          let data;
          try { data = JSON.parse(raw); }
          catch (pe) { throw new Error('HTTP ' + r.status + ' 非JSON応答: ' + raw.slice(0, 80)); }
          return { data: data, mb: mb, attempt: a + 1 };
        } catch (err) {
          lastErr = err;  // → 次のプラン（より小さい画像）で再試行
        }
      }
      throw lastErr;
    }

    document.getElementById('ocrFile').addEventListener('change', async function(e){
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;
      const st = document.getElementById('ocrStatus');
      for (let i = 0; i < files.length; i++) {
        st.textContent = '📷 ' + (i+1) + '/' + files.length + ' 枚目を読み取り中...🦀（少し時間がかかります）';
        try {
          const res = await postImageWithRetry('/api/kanbetsu-ocr', files[i],
            [ {dim:1600, q:0.8}, {dim:1200, q:0.7}, {dim:900, q:0.6} ],
            st, '📷 ' + (i+1) + '/' + files.length + ' 枚目');
          const data = res.data;
          if (data.error) { st.textContent = '⚠️ 読み取りエラー: ' + data.error; continue; }
          if (!data.drugs || !data.drugs.length) { st.textContent = '📭 この写真からは薬が読み取れませんでしたカニ🦀💦'; continue; }
          for (const d of data.drugs) {
            kanbetsuSeq++;
            kanbetsuList.push({ id: kanbetsuSeq, ocrName: d.name, name: d.name, usage: d.usage || '', m: (d.match && d.match.found) ? d.match : null });
          }
          st.textContent = '✅ ' + data.drugs.length + '件の薬を読み取りましたカニ🦀 続けて撮影もできます。';
        } catch (err) {
          st.textContent = '⚠️ 電波が不安定で送信できませんでしたカニ🦀💦（3回試しました）電波の良い場所で再度お試しください。詳細: ' + dbgErr(err);
        }
        renderJList();
      }
    });

    // 画像を長辺1600pxのJPEGに圧縮（通信量とOCRコストの節約）
    // ===== 📱 手帳QR（JAHIS規格）: 1個ずつスキャンして貯める =====
    var qrStream = null, qrScanning = false, qrTexts = [], qrSeen = null, qrLibLoading = null;

    function loadJsQR() {
      if (window.jsQR) return Promise.resolve();
      if (qrLibLoading) return qrLibLoading;
      qrLibLoading = new Promise(function(resolve, reject){
        var sc = document.createElement('script');
        sc.src = '/vendor/jsqr.js';
        sc.onload = resolve;
        sc.onerror = function(){ reject(new Error('QRライブラリの読み込みに失敗')); };
        document.head.appendChild(sc);
      });
      return qrLibLoading;
    }

    async function openQrScanner() {
      const ov = document.getElementById('qrOverlay');
      qrTexts = []; qrSeen = {};
      document.getElementById('qrGoBtn').style.display = 'none';
      document.getElementById('qrCount').textContent = 'カメラを起動中...🦀';
      ov.style.display = 'flex';
      try {
        await loadJsQR();
        qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const v = document.getElementById('qrVideo');
        v.srcObject = qrStream; v.setAttribute('playsinline', ''); await v.play();
        document.getElementById('qrCount').textContent = 'QRを枠に合わせてね🦀';
        qrScanning = true;
        requestAnimationFrame(qrTick);
      } catch (e) {
        document.getElementById('qrCount').textContent = '⚠️ カメラを起動できませんでした（' + (e && e.message ? e.message : e) + '）';
      }
    }

    function qrTick() {
      if (!qrScanning) return;
      const v = document.getElementById('qrVideo');
      if (v && v.readyState === v.HAVE_ENOUGH_DATA && window.jsQR) {
        const cv = document.createElement('canvas');
        cv.width = v.videoWidth; cv.height = v.videoHeight;
        const ctx = cv.getContext('2d');
        ctx.drawImage(v, 0, 0, cv.width, cv.height);
        const img = ctx.getImageData(0, 0, cv.width, cv.height);
        const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
        if (code) {
          var text = '';
          try { text = new TextDecoder('shift-jis').decode(new Uint8Array(code.binaryData)); }
          catch (e) { text = code.data || ''; }
          const key = text.slice(0, 40) + '|' + text.length;
          if (text && !qrSeen[key]) {
            qrSeen[key] = 1; qrTexts.push(text);
            document.getElementById('qrCount').textContent = '✅ ' + qrTexts.length + '個 読み取り済み';
            document.getElementById('qrGoBtn').style.display = 'block';
            if (navigator.vibrate) navigator.vibrate(60);
          }
        }
      }
      requestAnimationFrame(qrTick);
    }

    function stopQrCamera() {
      qrScanning = false;
      if (qrStream) { qrStream.getTracks().forEach(function(t){ t.stop(); }); qrStream = null; }
    }
    function closeQrScanner() {
      stopQrCamera();
      document.getElementById('qrOverlay').style.display = 'none';
    }

    async function analyzeQr() {
      if (!qrTexts.length) return;
      stopQrCamera();
      document.getElementById('qrOverlay').style.display = 'none';
      const st = document.getElementById('ocrStatus');
      st.textContent = '📱 手帳QRを解析中...🦀';
      try {
        const r = await fetch('/api/techo-qr', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ h: HID, texts: qrTexts })
        });
        const data = await r.json();
        if (data.error) { st.textContent = '⚠️ 解析エラー: ' + data.error; return; }
        if (!data.drugs || !data.drugs.length) { st.textContent = '📭 QRから薬を読み取れませんでしたカニ🦀💦 QRが全部揃っているか確認してね'; return; }
        for (const d of data.drugs) {
          kanbetsuSeq++;
          kanbetsuList.push({ id: kanbetsuSeq, ocrName: d.name, name: d.name, usage: d.usage || '', m: (d.match && d.match.found) ? d.match : null });
        }
        st.textContent = '✅ 手帳QRから ' + data.drugs.length + '件の薬を取り込みましたカニ🦀';
        renderJList();
      } catch (e) {
        st.textContent = '⚠️ 通信エラーが発生したカニ🦀💦 もう一度お試しください。';
      }
    }

    function compressImage(file) {
      return new Promise(function(resolve, reject){
        const img = new Image();
        const fr = new FileReader();
        fr.onload = function(){ img.src = fr.result; };
        fr.onerror = reject;
        img.onload = function(){
          const maxDim = 1600;
          let w = img.width, h = img.height;
          if (Math.max(w, h) > maxDim) {
            const scale = maxDim / Math.max(w, h);
            w = Math.round(w * scale); h = Math.round(h * scale);
          }
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', 0.8));
        };
        img.onerror = reject;
        fr.readAsDataURL(file);
      });
    }

    // ===== 💊 裸錠まとめ撮り→刻印OCR（追加分） =====
    // チップ { i, imprint, kind, confidence, note, used }
    var kokuinChipList = [];
    var kpTargetIdx = null;

    // 刻印は小さいので高めの解像度で圧縮（長辺2000px・JPEG0.85）
    function compressImageHQ(file) {
      return new Promise(function(resolve, reject){
        const img = new Image();
        const fr = new FileReader();
        fr.onload = function(){ img.src = fr.result; };
        fr.onerror = reject;
        img.onload = function(){
          const maxDim = 2000;
          let w = img.width, h = img.height;
          if (Math.max(w, h) > maxDim) {
            const scale = maxDim / Math.max(w, h);
            w = Math.round(w * scale); h = Math.round(h * scale);
          }
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = reject;
        fr.readAsDataURL(file);
      });
    }

    document.getElementById('kokuinFile').addEventListener('change', async function(e){
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;
      const st = document.getElementById('ocrStatus');
      st.textContent = '💊 錠剤の刻印を読み取り中...🦀（少し時間がかかります）';
      try {
        const res = await postImageWithRetry('/api/kokuin-ocr', files[0],
          [ {dim:1600, q:0.8}, {dim:1280, q:0.75}, {dim:1000, q:0.7} ],
          st, '💊 刻印OCR');
        const data = res.data;
        if (data.error) { st.textContent = '⚠️ 読み取りエラー: ' + data.error; return; }
        if (!data.pills || !data.pills.length) { st.textContent = '📭 この写真からは錠剤が読み取れませんでしたカニ🦀💦 明るい場所で錠剤同士を離して撮ってみてね！'; return; }
        for (const p of data.pills) {
          kokuinChipList.push({ i: kokuinChipList.length, imprint: p.imprint || '', kind: p.kind || '', confidence: p.confidence || '中', note: p.note || '', used: false });
        }
        st.textContent = '✅ ' + data.pills.length + '錠分の刻印を読み取りましたカニ🦀 チップをタップしてお薬を特定してね！';
        renderKokuinChips();
      } catch (err) {
        st.textContent = '⚠️ 電波が不安定で送信できませんでしたカニ🦀💦（3回試しました）電波の良い場所で再度お試しください。詳細: ' + dbgErr(err);
      }
    });

    function renderKokuinChips() {
      const box = document.getElementById('kokuinChips');
      if (!kokuinChipList.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.style.display = 'flex';
      let html = '';
      for (const c of kokuinChipList) {
        if (!c.imprint) {
          const ncls = c.used ? 'kchip used' : 'kchip noimp';
          html += '<span class="' + ncls + '" data-knoimp="' + c.i + '">' + (c.used ? '✅ ' : '') + '（刻印なし）'
            + (c.note ? '<span class="knote">' + escHtml(c.note) + '</span>' : '')
            + (c.used ? '' : '<span class="knote">👆タップで手入力検索</span>')
            + '</span>';
        } else {
          const cls = c.used ? 'kchip used' : (c.confidence === '低' ? 'kchip low' : 'kchip');
          html += '<span class="' + cls + '" data-kchip="' + c.i + '">' + (c.used ? '✅ ' : '🔍 ') + escHtml(c.imprint)
            + (c.confidence === '低' ? '<span class="knote">自信なし</span>' : '')
            + (c.note ? '<span class="knote">' + escHtml(c.note) + '</span>' : '')
            + '</span>';
        }
      }
      box.innerHTML = html;
    }

    document.getElementById('kokuinChips').addEventListener('click', function(e){
      const nc = e.target.closest('[data-knoimp]');
      if (nc) { openPickerForAdd(Number(nc.getAttribute('data-knoimp'))); return; }
      const ch = e.target.closest('[data-kchip]');
      if (!ch) return;
      openKp(Number(ch.getAttribute('data-kchip')));
    });

    function openKp(i) {
      const c = kokuinChipList[i];
      if (!c) return;
      kpTargetIdx = i;
      // 【】付きのロゴ補足は検索語から除外する
      document.getElementById('kpQ').value = String(c.imprint || '').replace(/【[^】]*】/g, '').trim();
      document.getElementById('kpResults').innerHTML = '';
      document.getElementById('kpStatus').textContent = '';
      document.getElementById('kpOverlay').style.display = 'flex';
      kpSearch();
    }
    function closeKp() {
      document.getElementById('kpOverlay').style.display = 'none';
      kpTargetIdx = null;
    }
    document.getElementById('kpOverlay').addEventListener('click', closeKp);
    document.getElementById('kpQ').addEventListener('keydown', function(e){ if (e.key === 'Enter') kpSearch(); });

    async function kpSearch() {
      const q = document.getElementById('kpQ').value.trim();
      const st = document.getElementById('kpStatus');
      const res = document.getElementById('kpResults');
      res.innerHTML = '';
      if (q.replace(/\s/g,'').length < 2) { st.textContent = '2文字以上で検索してくださいカニ🦀'; return; }
      st.textContent = '検索中...🦀';
      try {
        const r = await fetch('/api/jisan-search?h=' + encodeURIComponent(HID) + '&q=' + encodeURIComponent(q));
        const data = await r.json();
        if (data.error === 'index_not_found') { st.textContent = '刻印データが未登録です。管理者にお問い合わせください。'; return; }
        if (data.error) { st.textContent = 'エラーが発生しました（' + data.error + '）'; return; }
        const list = data.results || [];
        if (!list.length) {
          st.textContent = '';
          res.innerHTML = '<div class="no-results" style="padding:20px 10px;">📭 「' + escHtml(q) + '」に一致する刻印は見つかりませんでしたカニ🦀💦<br><span style="font-size:12px;color:#aaa;">刻印の一部だけで再検索してみてね！</span></div>';
          return;
        }
        st.textContent = list.length + '件ヒット。正しいお薬をタップして選んでくださいカニ🦀';
        let html = '';
        const cap = Math.min(list.length, 30);
        for (let i = 0; i < cap; i++) {
          const it = list[i];
          html += '<div class="pick-item ' + (it.isAdopted ? 'adopted' : '') + '" data-kpick="' + i + '">'
            + '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">'
              + '<div style="font-weight:bold; font-size:13px; line-height:1.4; flex:1;">' + formEmoji(it.key) + ' ' + escHtml(it.name || '') + '</div>'
              + '<div style="flex-shrink:0; display:flex; gap:3px;">'
                + (it.isBrand ? '<span class="tag blue" style="font-size:10px; padding:2px 6px;">先</span>' : '')
                + (it.isAdopted ? '<span class="tag green" style="font-size:10px; padding:2px 6px;">🏥 採用</span>' : '')
              + '</div>'
            + '</div>'
            + (it.spec ? '<div style="font-size:11px; color:#888; margin-top:4px;">📦 ' + escHtml(it.spec) + '</div>' : '')
            + '<div style="font-size:11px; color:#d63384; margin-top:4px;">刻印: ' + escHtml(it.code || '') + (it.key ? '' : ' <span style="color:#aaa;">（マスタ未収載・継続/切替選択はできません）</span>') + '</div>'
            + '</div>';
        }
        res.innerHTML = html;
        window._kpList = list;
      } catch (e) {
        st.textContent = '通信エラーが発生したカニ🦀💦';
      }
    }

    // 候補タップ→持参薬リストに追加（以降は既存の継続/切替・報告書フローに合流）
    document.getElementById('kpResults').addEventListener('click', function(e){
      const p = e.target.closest('[data-kpick]');
      if (!p || kpTargetIdx === null) return;
      const chosen = (window._kpList || [])[Number(p.getAttribute('data-kpick'))];
      const c = kokuinChipList[kpTargetIdx];
      if (!chosen || !c) return;
      kanbetsuSeq++;
      kanbetsuList.push({
        id: kanbetsuSeq,
        ocrName: '刻印 ' + (c.imprint || ''),
        name: chosen.name,
        usage: '',
        m: { found: true, key: chosen.key || '', name: chosen.name, spec: chosen.spec || '', price: chosen.price || '', isBrand: !!chosen.isBrand, isAdopted: !!chosen.isAdopted, yj: chosen.yj || '' }
      });
      c.used = true;
      closeKp();
      renderKokuinChips();
      renderJList();
      document.getElementById('ocrStatus').textContent = '✅ 「' + chosen.name + '」を持参薬リストに追加しましたカニ🦀';
    });

    // ===== ➕ 手入力検索でお薬追加（刻印なし錠・OCR外のお薬用） =====
    var pickerAddMode = false;
    var pickerAddChipIdx = null;

    function openPickerForAdd(chipIdx) {
      pickerTargetId = null;          // 既存の紐付けリスナーを無効化（null時は既存側がreturnする）
      pickerAddMode = true;
      pickerAddChipIdx = (chipIdx === null || chipIdx === undefined) ? null : chipIdx;
      document.getElementById('pickerQ').value = '';
      document.getElementById('pickerResults').innerHTML = '';
      document.getElementById('pickerStatus').textContent = 'お薬名（かな・カナ）で検索して、追加するお薬を選んでくださいカニ🦀';
      document.getElementById('pickerOverlay').style.display = 'flex';
      setTimeout(function(){ document.getElementById('pickerQ').focus(); }, 50);
    }

    // 既存のpickerResultsリスナーとは別に、新規追加モード専用のリスナーを重ねる
    // （既存リスナーは pickerTargetId === null のとき何もしないので二重処理にはならない）
    document.getElementById('pickerResults').addEventListener('click', function(e){
      if (!pickerAddMode || pickerTargetId !== null) return;
      const p = e.target.closest('[data-pick]');
      if (!p) return;
      const chosen = (window._pickerList || [])[Number(p.getAttribute('data-pick'))];
      if (!chosen) return;
      kanbetsuSeq++;
      kanbetsuList.push({
        id: kanbetsuSeq,
        ocrName: pickerAddChipIdx !== null ? '刻印なし（手入力検索）' : '手入力検索',
        name: chosen.name,
        usage: '',
        m: { found: true, key: chosen.key || '', name: chosen.name, spec: chosen.spec || '', price: chosen.price || '', isBrand: !!chosen.isBrand, isAdopted: !!chosen.isAdopted, yj: chosen.yj || '' }
      });
      if (pickerAddChipIdx !== null && kokuinChipList[pickerAddChipIdx]) {
        kokuinChipList[pickerAddChipIdx].used = true;
      }
      pickerAddMode = false;
      pickerAddChipIdx = null;
      closePicker();
      renderKokuinChips();
      renderJList();
      document.getElementById('ocrStatus').textContent = '✅ 「' + chosen.name + '」を持参薬リストに追加しましたカニ🦀';
    });

    // ピッカーを閉じたら追加モードは解除（既存closePickerは変更しない）
    document.getElementById('pickerOverlay').addEventListener('click', function(){
      pickerAddMode = false;
      pickerAddChipIdx = null;
    });

    function renderJList() {
      const area = document.getElementById('jlistArea');
      const list = document.getElementById('jlist');
      const cnt = document.getElementById('jlistCount');
      if (!kanbetsuList.length) { area.style.display = 'none'; list.innerHTML = ''; return; }
      area.style.display = 'block';
      cnt.textContent = '（' + kanbetsuList.length + '件）';
      let html = '';
      for (const it of kanbetsuList) {
        if (it.m) {
          // ✅ KV照合ヒット: 通常検索と同じカード風
          html += '<div class="jitem ' + (it.m.isAdopted ? 'adopted' : '') + '" data-jid="' + it.id + '" data-decide="' + it.id + '">'
            + '<button class="del" data-del="' + it.id + '">✕</button>'
            + '<div style="display:flex; justify-content:space-between; align-items:flex-start; font-weight:bold; font-size:15px; gap:8px; padding-right:22px;">'
              + '<div style="flex:1; line-height:1.4;">' + formEmoji(it.m.key) + ' ' + escHtml(it.m.name) + '</div>'
              + '<div style="flex-shrink:0; display:flex; gap:4px; margin-top:2px;">'
                + (it.m.isBrand ? '<span class="tag blue">先</span>' : '')
                + (it.m.price && it.m.price !== '-' ? '<span class="tag" style="background:#fff3cd;color:#333;border:1px solid #ffe69c;"><span style="color:#e65100;">￥</span>' + escHtml(it.m.price) + '</span>' : '')
                + (it.m.yj && it.m.yj.indexOf('8') === 0 ? '<span class="tag red">麻</span>' : '')
                + (it.m.isAdopted ? '<span class="tag green">🏥 採用</span>' : '<span class="tag">未採用</span>')
              + '</div>'
            + '</div>'
            + (it.m.spec ? '<div style="font-size:12px; color:#888; margin-top:6px;">📦 ' + escHtml(it.m.spec) + '</div>' : '')
            + '<div class="usage-line" data-editusage="' + it.id + '"><span class="lbl">📝 用法（タップで編集）:</span> ' + (it.usage ? escHtml(it.usage) : '<span style="color:#bbb;">未入力</span>') + '</div>'
            + '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;">'
              + '<span class="ocr-src" style="margin-top:0;">' + (norm2(it.ocrName) !== norm2(it.m.name) ? 'OCR読み取り: ' + escHtml(it.ocrName) : '') + '</span>'
              + '<span data-repick="' + it.id + '" style="font-size:11px; color:#0d6efd; cursor:pointer; text-decoration:underline dotted; white-space:nowrap;">🔁 別の薬に変更</span>'
            + '</div>'
            + decisionHTML(it)
            + '</div>';
        } else {
          // ⚠️ 未照合: 名前タップで編集→自動再照合
          html += '<div class="jitem unmatched" data-jid="' + it.id + '">'
            + '<button class="del" data-del="' + it.id + '">✕</button>'
            + '<div style="font-weight:bold; font-size:15px; padding-right:22px;">⚠️ <span class="name-edit" data-editname="' + it.id + '">' + escHtml(it.name) + '</span> <span style="font-size:11px; color:#e0a800; font-weight:normal;">未照合（名前をタップして検索から選べます）</span></div>'
            + '<div class="usage-line" data-editusage="' + it.id + '"><span class="lbl">📝 用法（タップで編集）:</span> ' + (it.usage ? escHtml(it.usage) : '<span style="color:#bbb;">未入力</span>') + '</div>'
            + '</div>';
        }
      }
      list.innerHTML = html;
    }
    function norm2(s){ return String(s||'').normalize('NFKC').toUpperCase().replace(/\s+/g,''); }

    // ===== 🌟フェーズ2: 継続/切替の決定表示 =====
    function decisionHTML(it) {
      if (!it.d) {
        return '<div class="tap-hint">👆 カードをタップして【継続 / 切替】を選ぶカニ🦀</div>';
      }
      const d = it.d;
      const isKeep = d.type === 'keep';
      return '<div class="decide-box ' + (isKeep ? 'keep' : 'switch') + '">'
        + '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">'
          + '<div style="flex:1; line-height:1.4; font-size:13px;">'
            + '<span class="decide-label" data-redecide="' + it.id + '">' + (isKeep ? '✅ 継続' : '🔄 切替') + ' →</span> '
            + '<b>' + escHtml(d.name) + '</b>'
            + (d.spec ? ' <span style="color:#888; font-size:11px;">' + escHtml(d.spec) + '</span>' : '')
          + '</div>'
          + '<div style="flex-shrink:0; display:flex; gap:3px;">'
            + (d.isBrand ? '<span class="tag blue" style="font-size:10px; padding:2px 6px;">先</span>' : '')
            + (d.isAdopted ? '<span class="tag green" style="font-size:10px; padding:2px 6px;">🏥 採用</span>' : '')
          + '</div>'
        + '</div>'
        + '<div class="usage-line" data-editdusage="' + it.id + '" style="margin-top:8px;"><span class="lbl">📝 ' + (isKeep ? '継続後' : '切替後') + 'の用法（タップで編集）:</span> ' + (d.usage ? escHtml(d.usage) : '<span style="color:#bbb;">未入力</span>') + '</div>'
        + '</div>';
    }

    // ===== 🌟フェーズ2: 継続/切替を選ぶモーダル =====
    let decideTargetId = null;
    async function openDecide(id) {
      const it = kanbetsuList.find(function(x){ return x.id === id; });
      // 🌟変更: keyが無くてもYJがあれば切替候補を出す（薬価マスタ未収載の薬に対応）
      if (!it || !it.m || (!it.m.key && !it.m.yj)) return;
      decideTargetId = id;
      const ov = document.getElementById('modalOverlay');
      const body = document.getElementById('modalBody');
      body.innerHTML = '<div style="text-align:center; padding:30px; color:#888;">切替候補を読み込み中...🦀</div>';
      ov.style.display = 'flex';
      try {
        // 🌟変更: keyがあれば従来どおり、無ければYJで問い合わせる
        const dq = it.m.key
          ? ('key=' + encodeURIComponent(it.m.key))
          : ('yj=' + encodeURIComponent(it.m.yj || '') + '&spec=' + encodeURIComponent(it.m.spec || ''));
        const r = await fetch('/api/detail?' + dq + '&h=' + encodeURIComponent(HID));
        const d = await r.json();
        if (!d || d.error) { body.innerHTML = '<div style="text-align:center; padding:30px; color:#888;">候補を取得できませんでしたカニ🦀💦</div>'; return; }

        let html = '';
        html += '<div style="font-weight:bold; font-size:15px; color:#0056b3; line-height:1.4; margin-bottom:4px; padding-right:20px;">' + formEmoji(it.m.key) + ' ' + escHtml(it.m.name) + '</div>';
        html += '<div style="font-size:12px; color:#888; margin-bottom:12px;">この持参薬をどうしますか？（切替先の用法は持参薬の用法をコピーします。後から編集できますカニ🦀）</div>';

        // 【継続】: 同じ薬を一番上に
        html += '<div class="alt-item ' + (it.m.isAdopted ? 'adopted' : '') + '" data-dc="keep" style="border-width:2px;">'
          + '<div style="display:flex; justify-content:space-between; align-items:flex-start;">'
            + '<span style="font-weight:bold; line-height:1.3;"><span style="background:#28a745; color:#fff; font-size:10px; padding:2px 8px; border-radius:10px; margin-right:6px;">継続</span>' + formEmoji(it.m.key) + ' ' + escHtml(it.m.name) + ' <span style="font-weight:normal;color:#666;font-size:11px;">' + escHtml(it.m.spec || '') + '</span></span>'
            + '<span style="font-weight:bold;color:' + (it.m.isAdopted ? '#28a745' : '#aaa') + '; white-space:nowrap; margin-left:8px;">' + (it.m.isAdopted ? '🏥 採用' : '') + ' ❯</span>'
          + '</div>'
          + '<div style="font-size:11px; color:#888; margin-top:4px;">このまま同じ薬を続ける場合はこちらカニ🦀</div>'
        + '</div>';

        // 切替候補（採用×同mgソート済み）
        html += '<div style="font-weight:bold; font-size:13px; color:#555; margin:12px 0 8px;">🔄 切替する場合はこちらから選択</div>';
        if (d.alts && d.alts.length) {
          window._decideAlts = d.alts;
          for (let i = 0; i < d.alts.length; i++) {
            const a = d.alts[i];
            html += '<div class="alt-item ' + (a.isAdopted ? 'adopted' : '') + '" data-dc="alt" data-ai="' + i + '">'
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
          window._decideAlts = [];
          html += '<div style="font-size:12px; color:#999; text-align:center; padding:10px;">切替候補が見つかりませんでしたカニ🦀</div>';
        }
        body.innerHTML = html;
      } catch (e) {
        body.innerHTML = '<div style="text-align:center; padding:30px; color:#888;">通信エラーが発生したカニ🦀💦</div>';
      }
    }

    // 決定モーダル内のタップ（継続 / 切替候補）
    document.getElementById('modalBody').addEventListener('click', function(e){
      const dc = e.target.closest('[data-dc]');
      if (!dc || decideTargetId === null) return;
      const it = kanbetsuList.find(function(x){ return x.id === decideTargetId; });
      if (!it) return;
      // 🌟変更: 持参薬の用法（用量・単位も含む）をコピーして引き継ぐ
      const carry = { usage: it.usage || '', usageA: it.usageA || '', dose: it.dose || '', unit: it.unit || '', uname: it.uname || '' };
      if (dc.getAttribute('data-dc') === 'keep') {
        it.d = { type: 'keep', key: it.m.key, name: it.m.name, spec: it.m.spec || '', price: it.m.price || '', isBrand: !!it.m.isBrand, isAdopted: !!it.m.isAdopted, yj: it.m.yj || '', ...carry };
      } else {
        const a = (window._decideAlts || [])[Number(dc.getAttribute('data-ai'))];
        if (!a) return;
        it.d = { type: 'switch', key: a.key, name: a.name, spec: a.spec || '', price: a.price || '', isBrand: !!a.isBrand, isAdopted: !!a.isAdopted, yj: a.yj || '', ...carry };
      }
      const decidedId = it.id;
      decideTargetId = null;
      closeModal();
      renderJList();
      // 🌟追加: 持参薬の用法をコピーした状態で、そのまま用法窓を開く
      setTimeout(function(){ openYoho(decidedId, 'dusage'); }, 120);
    });

    // ===== 🌟フェーズ3: 持参薬鑑別報告書 =====
    let reportMemo = '';
    let reportBiko = '';
    let reportDate = '';
    let reportTmpl = null;   // 🌟追加: 定型テキスト（nullのうちは設定値で初期化される）
    let reportSign = null;   // 🌟追加: 定型署名

    // ===== 🌟追加: 用法選択機能（用法マスタ＋用量＋単位、自由入力も可） =====
    // 設定は /api/kanbetsu/config から取得（共通デフォルト＋施設の追加をマージ済み）
    var YOHO_CFG = { yoho: [], units: ['錠'], doses: ['1'], tmplText: '', tmplSign: '' };
    var yohoTarget = null;   // { id, field } field: 'usage' | 'dusage'
    var yohoSel = null;      // 選択中の用法エントリ

    async function loadKanbetsuCfg() {
      try {
        const r = await fetch('/api/kanbetsu/config?h=' + encodeURIComponent(HID));
        const d = await r.json();
        if (d && Array.isArray(d.yoho)) {
          YOHO_CFG = d;
          reportTmpl = (reportTmpl === null) ? (d.tmplText || '') : reportTmpl;
          reportSign = (reportSign === null) ? (d.tmplSign || '') : reportSign;
        }
      } catch (e) { /* 取得できなくても自由入力で使えるので黙って続行 */ }
    }

    // 表示用（帳票・画面）: 「1回1錠　1日3回毎食後」
    function fmtYohoDisp(dose, unit, name) {
      if (!name) return '';
      if (!dose || !unit) return name;
      return '1回' + dose + unit + '　' + name;
    }
    // コピー用（電カル貼り付け）: 「1錠 3×毎食後」
    function fmtYohoAbbr(dose, unit, abbr) {
      if (!abbr) return '';
      if (!dose || !unit) return abbr;
      return dose + unit + ' ' + abbr;
    }

    // 剤形にあわせて区分の並び順を変える（外用薬なら外用系を先頭に）
    function yohoCatOrder(it) {
      const k = (it && it.m && it.m.key) ? it.m.key : '';
      if (k.indexOf('[外]') !== -1) return ['外用', '外用(眼)', '外用(鼻)', '外用(他)', '内服', '頓服'];
      return ['内服', '頓服', '外用', '外用(眼)', '外用(鼻)', '外用(他)'];
    }

    function openYoho(id, field) {
      const it = kanbetsuList.find(function(x){ return x.id === id; });
      if (!it) return;
      if (field === 'dusage' && !it.d) return;
      yohoTarget = { id: id, field: field };
      yohoSel = null;
      const cur = (field === 'dusage') ? (it.d.usage || '') : (it.usage || '');
      const curD = (field === 'dusage') ? (it.d.dose || '') : (it.dose || '');
      const curU = (field === 'dusage') ? (it.d.unit || '') : (it.unit || '');
      const curN = (field === 'dusage') ? (it.d.uname || '') : (it.uname || '');

      let ttl = '📝 持参薬の用法を入力';
      if (field === 'dusage') ttl = '📝 ' + (it.d.type === 'keep' ? '継続後' : '切替後') + 'の用法を入力';
      document.getElementById('yohoTitle').textContent = ttl;

      // 用量・単位のプルダウンを組み立て
      const dsel = document.getElementById('yohoDose');
      const usel = document.getElementById('yohoUnit');
      dsel.innerHTML = (YOHO_CFG.doses || ['1']).map(function(d){ return '<option value="' + escHtml(d) + '">' + escHtml(d) + '</option>'; }).join('');
      usel.innerHTML = (YOHO_CFG.units || ['錠']).map(function(u){ return '<option value="' + escHtml(u) + '">' + escHtml(u) + '</option>'; }).join('');
      // デフォルトは「1」「錠」。前回値があればそれを復元
      dsel.value = curD || ((YOHO_CFG.doses || []).indexOf('1') !== -1 ? '1' : (YOHO_CFG.doses || ['1'])[0]);
      usel.value = curU || ((YOHO_CFG.units || []).indexOf('錠') !== -1 ? '錠' : (YOHO_CFG.units || ['錠'])[0]);
      if (!dsel.value) dsel.selectedIndex = 0;
      if (!usel.value) usel.selectedIndex = 0;

      // 自由入力欄には「用法名だけ」を入れる（用量・単位はプルダウン側で持つ）
      document.getElementById('yohoFree').value = curN || (curD ? '' : cur);
      document.getElementById('yohoFind').value = '';
      renderYohoList('');
      updateYohoPrev();
      document.getElementById('yohoOverlay').style.display = 'flex';
    }
    function closeYoho() {
      document.getElementById('yohoOverlay').style.display = 'none';
      yohoTarget = null; yohoSel = null;
    }
    function clearYoho() {
      yohoSel = null;
      document.getElementById('yohoFree').value = '';
      renderYohoList(document.getElementById('yohoFind').value);
      updateYohoPrev();
    }

    function renderYohoList(filter) {
      const it = yohoTarget ? kanbetsuList.find(function(x){ return x.id === yohoTarget.id; }) : null;
      const order = yohoCatOrder(it);
      const f = String(filter || '').trim();
      const all = (YOHO_CFG.yoho || []).filter(function(y){
        if (!f) return true;
        return (y.name.indexOf(f) !== -1) || (String(y.abbr || '').indexOf(f) !== -1);
      });
      let html = '';
      for (const cat of order) {
        const items = all.filter(function(y){ return y.cat === cat; });
        if (!items.length) continue;
        html += '<div class="yoho-cat">' + escHtml(cat) + '</div><div>';
        for (const y of items) {
          const on = (yohoSel && yohoSel.code === y.code) ? ' on' : '';
          html += '<span class="yoho-btn' + on + '" data-yoho="' + y.code + '">' + escHtml(y.name)
            + '<span class="ab">' + escHtml(y.abbr || '') + '</span>'
            + (y.own ? '<span class="yoho-own">施設</span>' : '')
            + '</span>';
        }
        html += '</div>';
      }
      // マージ結果に無い区分（施設が独自区分を作った場合）も拾う
      const rest = all.filter(function(y){ return order.indexOf(y.cat) === -1; });
      if (rest.length) {
        html += '<div class="yoho-cat">その他</div><div>';
        for (const y of rest) {
          const on = (yohoSel && yohoSel.code === y.code) ? ' on' : '';
          html += '<span class="yoho-btn' + on + '" data-yoho="' + y.code + '">' + escHtml(y.name) + '</span>';
        }
        html += '</div>';
      }
      if (!html) html = '<div style="font-size:12px; color:#999; text-align:center; padding:14px;">該当する用法がありません。下の自由入力に直接書けますカニ🦀</div>';
      document.getElementById('yohoList').innerHTML = html;
    }

    function updateYohoPrev() {
      const dose = document.getElementById('yohoDose').value;
      const unit = document.getElementById('yohoUnit').value;
      const free = document.getElementById('yohoFree').value.trim();
      const name = free || (yohoSel ? yohoSel.name : '');
      // 自由入力が選択中の用法名から書き換えられていたら略称も自由入力を使う
      const abbr = (yohoSel && free === yohoSel.name) ? (yohoSel.abbr || yohoSel.name) : name;
      const disp = fmtYohoDisp(dose, unit, name);
      const ab = fmtYohoAbbr(dose, unit, abbr);
      document.getElementById('yohoPrev').innerHTML = name
        ? '<span class="pl">帳票・画面の表示</span>' + escHtml(disp) + '<span class="pa">📋コピー時：' + escHtml(ab) + '</span>'
        : '<span class="pl">帳票・画面の表示</span><span style="color:#bbb;">用法を選ぶか、自由入力してくださいカニ🦀</span>';
    }

    document.getElementById('yohoList').addEventListener('click', function(e){
      const b = e.target.closest('[data-yoho]');
      if (!b) return;
      const code = Number(b.getAttribute('data-yoho'));
      const y = (YOHO_CFG.yoho || []).find(function(x){ return x.code === code; });
      if (!y) return;
      yohoSel = (yohoSel && yohoSel.code === code) ? null : y;
      document.getElementById('yohoFree').value = yohoSel ? yohoSel.name : '';
      renderYohoList(document.getElementById('yohoFind').value);
      updateYohoPrev();
    });
    document.getElementById('yohoFind').addEventListener('input', function(){ renderYohoList(this.value); });
    document.getElementById('yohoFree').addEventListener('input', updateYohoPrev);
    document.getElementById('yohoDose').addEventListener('change', updateYohoPrev);
    document.getElementById('yohoUnit').addEventListener('change', updateYohoPrev);
    document.getElementById('yohoOverlay').addEventListener('click', closeYoho);

    function saveYoho() {
      if (!yohoTarget) return;
      const it = kanbetsuList.find(function(x){ return x.id === yohoTarget.id; });
      if (!it) { closeYoho(); return; }
      const dose = document.getElementById('yohoDose').value;
      const unit = document.getElementById('yohoUnit').value;
      const free = document.getElementById('yohoFree').value.trim();
      const name = free || (yohoSel ? yohoSel.name : '');
      const abbr = (yohoSel && free === yohoSel.name) ? (yohoSel.abbr || yohoSel.name) : name;
      const disp = name ? fmtYohoDisp(dose, unit, name) : '';
      const ab = name ? fmtYohoAbbr(dose, unit, abbr) : '';
      if (yohoTarget.field === 'dusage') {
        if (it.d) { it.d.usage = disp; it.d.usageA = ab; it.d.dose = name ? dose : ''; it.d.unit = name ? unit : ''; it.d.uname = name; }
      } else {
        it.usage = disp; it.usageA = ab; it.dose = name ? dose : ''; it.unit = name ? unit : ''; it.uname = name;
      }
      closeYoho();
      renderJList();
    }


    function fmtNow() {
      const d = new Date();
      const p = function(n){ return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '/' + p(d.getMonth()+1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function openReport() {
      if (!kanbetsuList.length) return;
      reportDate = fmtNow();
      renderReport();
      document.getElementById('rvHint').textContent = '';
      document.getElementById('reportView').style.display = 'block';
      window.scrollTo(0, 0);
    }
    function closeReport() { document.getElementById('reportView').style.display = 'none'; }

    function renderReport() {
      const BR = String.fromCharCode(10);
      let html = '';
      // ヘッダー: カニアイコン + タイトル（施設名はフッターへ移動）
      html += '<div class="rv-head"><img class="rv-kani" src="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani.png" alt=""><span class="rv-title">メディカニ鑑別結果</span></div>';
      html += '<div class="rv-metabox">'
        + '<div>🗓️ <b>日時：</b>' + escHtml(reportDate) + '</div>'
        + '<div class="rv-editrow" data-redit="rmemo">🆔 <b>ID等メモ：</b>' + (reportMemo ? escHtml(reportMemo) : '<span style="color:#bbb;">未入力</span>') + ' <span class="rv-edithint">（タップで編集）</span></div>'
        + '</div>';
      for (const it of kanbetsuList) {
        const cls = it.d ? (it.d.type === 'keep' ? 'keep' : 'switch') : (it.m ? 'undecided' : 'unmatched');
        const srcName = it.m ? it.m.name : it.name;
        html += '<div class="rv-card ' + cls + '">';
        html += '<div><span class="rv-lbl src">持参薬</span><span class="rv-dname">💊 ' + escHtml(srcName) + (it.m ? '' : '（未照合）') + '</span></div>';
        html += '<div class="rv-usage">📝 ' + (it.usage ? escHtml(it.usage) : '用法未入力') + '</div>';
        if (it.d) {
          const isKeep = it.d.type === 'keep';
          // 🌟継続/切替ラベルを2段目の薬品名の前にインラインで表示
          html += '<div class="rv-dst"><span class="rv-lbl ' + (isKeep ? 'keep' : 'switch') + '">' + (isKeep ? '継続 →' : '切替 →') + '</span><span class="rv-dname">💊 ' + escHtml(it.d.name) + '</span>' + (it.d.isAdopted ? ' <span class="tag green" style="font-size:10px; padding:1px 6px;">🏥 採用</span>' : '') + '</div>';
          html += '<div class="rv-usage">📝 ' + (it.d.usage ? escHtml(it.d.usage) : '用法未入力') + '</div>';
        } else if (it.m) {
          html += '<div class="rv-undecided">（継続／切替 未決定）</div>';
        }
        html += '</div>';
      }
      html += '<div class="rv-metabox"><div class="rv-editrow" data-redit="rbiko">📝 <b>備考：</b>' + (reportBiko ? escHtml(reportBiko).split(BR).join('<br>') : '<span style="color:#bbb;">未入力</span>') + ' <span class="rv-edithint">（タップで編集）</span></div></div>';
      // 🌟追加: 定型テキスト（備考の下・注意書きの上）
      html += '<div class="rv-tmpl rv-editrow" data-redit="rtmpl" style="border-style:solid;">' + (reportTmpl ? escHtml(reportTmpl).split(BR).join('<br>') : '<span style="color:#bbb;">定型テキスト未設定</span>') + ' <span class="rv-edithint">（タップで編集）</span></div>';
      // 🌟追加: 定型署名（右寄せ）
      html += '<div class="rv-sign rv-editrow" data-redit="rsign" style="border:none; background:none;">' + (reportSign ? escHtml(reportSign).split(BR).join('<br>') : '<span style="color:#bbb;">定型署名未設定</span>') + '</div>';
      // 🌟変更: 注意書きと施設フッターは1つの箱にまとめ、印刷時は全ページの下端に固定する
      html += '<div class="rv-pfoot">';
      html += '<div class="rv-note">※本結果はメディカニ鑑別（β）による補助資料です。内容の最終確認は薬剤師が行ってください。</div>';
      // フッター: タイトルの右側に施設名
      html += '<div class="rv-footer"><span class="t1">🦀 メディカニ 医薬品検索</span>' + (HNAME ? '<span class="fac">🏥 ' + escHtml(HNAME) + '</span>' : '') + '</div>';
      html += '</div>';
      document.getElementById('reportBody').innerHTML = html;
    }

    // 報告書内のタップ編集（ID等メモ・備考）
    document.getElementById('reportBody').addEventListener('click', function(e){
      const r = e.target.closest('[data-redit]');
      if (!r) return;
      openReportEdit(r.getAttribute('data-redit'));
    });
    function openReportEdit(field) {
      editTarget = { id: null, field: field };
      // 🌟追加: 定型テキスト・定型署名もその場で編集できる（保存先は管理画面ではなくこの帳票だけ）
      const titles = { rmemo: '✏️ ID等メモを編集', rbiko: '✏️ 備考を編集', rtmpl: '✏️ 定型テキストを編集（この帳票のみ）', rsign: '✏️ 定型署名を編集（この帳票のみ）' };
      const vals = { rmemo: reportMemo, rbiko: reportBiko, rtmpl: (reportTmpl || ''), rsign: (reportSign || '') };
      document.getElementById('editModalTitle').textContent = titles[field] || '✏️ 編集';
      document.getElementById('editModalText').value = vals[field] || '';
      document.getElementById('editModalOverlay').style.display = 'flex';
      setTimeout(function(){ document.getElementById('editModalText').focus(); }, 50);
    }

    // 📋 コピー: テキスト整形してクリップボードへ
    function buildReportText() {
      const NL = String.fromCharCode(10);
      let t = '🦀 メディカニ鑑別結果' + NL;
      if (HNAME) t += HNAME + NL;
      t += '日時：' + reportDate + NL;
      t += 'ID等メモ：' + (reportMemo || '') + NL + NL;
      for (const it of kanbetsuList) {
        const srcName = (it.m ? it.m.name : it.name + '（未照合）');
        // 🌟変更: コピーは略称版（1錠 3×毎食後）を優先。無ければ表示用をそのまま使う。
        t += '■ 持参薬：' + srcName + '　用法：' + (it.usageA || it.usage || '') + NL;
        if (it.d) {
          t += '　 ' + (it.d.type === 'keep' ? '継続' : '切替') + ' → ' + it.d.name + '　用法：' + (it.d.usageA || it.d.usage || '') + NL;
        } else if (it.m) {
          t += '　 （継続／切替 未決定）' + NL;
        }
      }
      t += NL + '備考：' + (reportBiko || '') + NL;
      if (reportTmpl) t += NL + reportTmpl + NL;                    // 🌟追加: 定型テキスト
      if (reportSign) t += NL + reportSign + NL;                    // 🌟追加: 定型署名
      t += NL + '※本結果はメディカニ鑑別（β）による補助資料です。内容の最終確認は薬剤師が行ってください。' + NL;
      return t;
    }
    async function copyReport() {
      const text = buildReportText();
      const hint = document.getElementById('rvHint');
      try {
        await navigator.clipboard.writeText(text);
        hint.textContent = '📋 コピーしましたカニ🦀 電子カルテ等に貼り付けできます。';
      } catch (e) {
        // クリップボードAPIが使えない環境向けフォールバック
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); hint.textContent = '📋 コピーしましたカニ🦀'; }
        catch (e2) { hint.textContent = '⚠️ コピーできませんでした。印刷をご利用ください。'; }
        document.body.removeChild(ta);
      }
    }
    function printReport() { window.print(); }
    function pdfReport() {
      document.getElementById('rvHint').textContent = '📄 印刷画面で送信先を「PDFに保存」にするとPDFで保存できますカニ🦀';
      setTimeout(function(){ window.print(); }, 300);
    }

    // 持参薬リストのクリック委譲（削除・用法編集・名前編集）
    document.getElementById('jlist').addEventListener('click', function(e){
      const del = e.target.closest('[data-del]');
      if (del) {
        const id = Number(del.getAttribute('data-del'));
        kanbetsuList = kanbetsuList.filter(function(x){ return x.id !== id; });
        renderJList();
        return;
      }
      const eu = e.target.closest('[data-editusage]');
      if (eu) { openYoho(Number(eu.getAttribute('data-editusage')), 'usage'); return; }   // 🌟変更: 用法選択モーダルへ
      const en = e.target.closest('[data-editname]');
      if (en) { openPicker(Number(en.getAttribute('data-editname'))); return; }
      const rp = e.target.closest('[data-repick]');
      if (rp) { openPicker(Number(rp.getAttribute('data-repick'))); return; }
      const ed = e.target.closest('[data-editdusage]');
      if (ed) { openYoho(Number(ed.getAttribute('data-editdusage')), 'dusage'); return; }  // 🌟変更: 用法選択モーダルへ
      const rd = e.target.closest('[data-redecide]');
      if (rd) { openDecide(Number(rd.getAttribute('data-redecide'))); return; }
      const dc = e.target.closest('.jitem[data-decide]');
      if (dc) { openDecide(Number(dc.getAttribute('data-decide'))); return; }
    });

    function openEditModal(id, field) {
      const it = kanbetsuList.find(function(x){ return x.id === id; });
      if (!it) return;
      editTarget = { id: id, field: field };
      let t = '✏️ 薬品名を編集（保存すると再照合します）';
      let v = it.name;
      if (field === 'usage') { t = '✏️ 用法を編集'; v = it.usage; }
      if (field === 'dusage') { t = '✏️ ' + (it.d && it.d.type === 'keep' ? '継続後' : '切替後') + 'の用法を編集'; v = it.d ? it.d.usage : ''; }
      document.getElementById('editModalTitle').textContent = t;
      document.getElementById('editModalText').value = v;
      document.getElementById('editModalOverlay').style.display = 'flex';
      setTimeout(function(){ document.getElementById('editModalText').focus(); }, 50);
    }
    function closeEditModal() {
      document.getElementById('editModalOverlay').style.display = 'none';
      editTarget = null;
    }
    async function saveEditModal() {
      if (!editTarget) return;
      const val = document.getElementById('editModalText').value.trim();
      // 🌟報告書のID等メモ・備考（リストの薬とは無関係のフィールド）
      if (editTarget.field === 'rmemo' || editTarget.field === 'rbiko' || editTarget.field === 'rtmpl' || editTarget.field === 'rsign') {
        if (editTarget.field === 'rmemo') reportMemo = val;
        else if (editTarget.field === 'rbiko') reportBiko = val;
        else if (editTarget.field === 'rtmpl') reportTmpl = val;   // 🌟追加
        else reportSign = val;                                      // 🌟追加
        closeEditModal();
        renderReport();
        return;
      }
      const it = kanbetsuList.find(function(x){ return x.id === editTarget.id; });
      if (!it) { closeEditModal(); return; }
      if (editTarget.field === 'usage') {
        it.usage = val;
        closeEditModal();
        renderJList();
        return;
      }
      if (editTarget.field === 'dusage') {
        if (it.d) it.d.usage = val;
        closeEditModal();
        renderJList();
        return;
      }
      // 名前編集 → 保存後に自動で再照合
      it.name = val;
      closeEditModal();
      renderJList();
      if (!val) return;
      const st = document.getElementById('ocrStatus');
      st.textContent = '🔄 「' + val + '」を照合中...🦀';
      try {
        const r = await fetch('/api/kanbetsu-rematch?h=' + encodeURIComponent(HID) + '&q=' + encodeURIComponent(val));
        const data = await r.json();
        if (data.match && data.match.found) {
          it.m = data.match;
          st.textContent = '✅ 照合できましたカニ🦀';
        } else {
          it.m = null;
          st.textContent = '📭 「' + val + '」は照合できませんでした。名前をもう少し正確にしてみてくださいカニ🦀';
        }
      } catch (e) {
        st.textContent = '⚠️ 照合の通信エラーが発生したカニ🦀💦';
      }
      renderJList();
    }
    document.getElementById('editModalOverlay').addEventListener('click', closeEditModal);

    // ===== 🔍 メディカニ検索ピッカー（未照合の紐付け・誤マッチの変更） =====
    let pickerTargetId = null;
    let pickerCat = '[内]';

    function openPicker(id) {
      const it = kanbetsuList.find(function(x){ return x.id === id; });
      if (!it) return;
      pickerTargetId = id;
      // 初期検索語: 薬品名の先頭のかな漢字部分（数字・規格の手前まで）→メディカニ通常検索に馴染む形
      const base = String(it.name || it.ocrName || '');
      const m = base.match(/^[ぁ-んァ-ヶー一-龠Ａ-Ｚａ-ｚA-Za-z]+/);
      document.getElementById('pickerQ').value = m ? m[0] : base;
      document.getElementById('pickerResults').innerHTML = '';
      document.getElementById('pickerStatus').textContent = 'そのまま検索するか、名前を編集して検索してくださいカニ🦀';
      document.getElementById('pickerOverlay').style.display = 'flex';
      pickerSearch();
    }
    function closePicker() {
      document.getElementById('pickerOverlay').style.display = 'none';
      pickerTargetId = null;
    }
    document.getElementById('pickerOverlay').addEventListener('click', closePicker);
    document.getElementById('pickerQ').addEventListener('keydown', function(e){ if (e.key === 'Enter') pickerSearch(); });
    // カテゴリ切替
    document.querySelectorAll('[data-pcat]').forEach(function(b){
      b.addEventListener('click', function(){
        pickerCat = b.getAttribute('data-pcat');
        document.querySelectorAll('[data-pcat]').forEach(function(x){ x.classList.remove('on'); });
        b.classList.add('on');
        pickerSearch();
      });
    });

    async function pickerSearch() {
      const q = document.getElementById('pickerQ').value.trim();
      const st = document.getElementById('pickerStatus');
      const res = document.getElementById('pickerResults');
      res.innerHTML = '';
      if (q.length < 2) { st.textContent = '2文字以上で検索してくださいカニ🦀'; return; }
      st.textContent = '検索中...🦀';
      try {
        const r = await fetch('/api/search?q=' + encodeURIComponent(q) + '&c=' + encodeURIComponent(pickerCat) + '&h=' + encodeURIComponent(HID));
        const data = await r.json();
        const list = Array.isArray(data) ? data : [];
        if (!list.length) { st.textContent = '見つかりませんでした。名前を短くして再検索してみてカニ🦀'; return; }
        // 採用薬を上に
        list.sort(function(a,b){ return (b.isAdopted?1:0) - (a.isAdopted?1:0); });
        st.textContent = list.length + '件ヒット。正しい薬をタップして選んでくださいカニ🦀';
        let html = '';
        const cap = Math.min(list.length, 30);
        for (let i = 0; i < cap; i++) {
          const it = list[i];
          html += '<div class="pick-item ' + (it.isAdopted ? 'adopted' : '') + '" data-pick="' + i + '">'
            + '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">'
              + '<div style="font-weight:bold; font-size:13px; line-height:1.4; flex:1;">' + formEmoji(it.key) + ' ' + escHtml(it.name || '') + '</div>'
              + '<div style="flex-shrink:0; display:flex; gap:3px;">'
                + (it.isBrand ? '<span class="tag blue" style="font-size:10px; padding:2px 6px;">先</span>' : '')
                + (it.isAdopted ? '<span class="tag green" style="font-size:10px; padding:2px 6px;">🏥 採用</span>' : '')
              + '</div>'
            + '</div>'
            + (it.spec ? '<div style="font-size:11px; color:#888; margin-top:4px;">📦 ' + escHtml(it.spec) + '</div>' : '')
            + '</div>';
        }
        res.innerHTML = html;
        window._pickerList = list;
      } catch (e) {
        st.textContent = '通信エラーが発生したカニ🦀💦';
      }
    }
    // 候補タップで紐付け
    document.getElementById('pickerResults').addEventListener('click', function(e){
      const p = e.target.closest('[data-pick]');
      if (!p || pickerTargetId === null) return;
      const chosen = (window._pickerList || [])[Number(p.getAttribute('data-pick'))];
      const it = kanbetsuList.find(function(x){ return x.id === pickerTargetId; });
      if (!chosen || !it) return;
      it.m = { found: true, key: chosen.key, name: chosen.name, spec: chosen.spec || '', price: chosen.price || '', isBrand: !!chosen.isBrand, isAdopted: !!chosen.isAdopted, yj: chosen.yj || '' };
      it.name = chosen.name;
      closePicker();
      renderJList();
      document.getElementById('ocrStatus').textContent = '✅ 「' + chosen.name + '」に紐付けましたカニ🦀';
    });

    // 🌟追加: 用法マスタ・単位・定型文を読み込む（管理画面 /kanbetsu-admin で設定した内容）
    loadKanbetsuCfg();
  </script>
</body></html>`;
}

// === 🦀持参薬鑑別(開発版): ページ生成関数 (ここまで) ===

// === 🦀メディカニ鑑別: 管理画面 生成関数 (ここから) ===
// /{hId}/kanbetsu-admin。用法マスタ・単位・追加刻印・定型テキスト/署名を編集する。
// 保存は施設管理パスワード必須（kyu-admin と同じ方式）。既存の /admin には一切手を入れていない。
function kanbetsuAdminPage(hId, isSuper) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦀</text></svg>">
<link rel="apple-touch-icon" href="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/icon_kan.png">
<meta name="apple-mobile-web-app-title" content="鑑別マスタ管理">
<title>メディカニ鑑別 マスタ管理</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif; background:#fffaf5; color:#333; padding-bottom:130px; }
  .header { background:linear-gradient(135deg,#d63384,#c02a72); color:#fff; padding:14px 16px; position:sticky; top:0; z-index:50; box-shadow:0 2px 8px rgba(0,0,0,.15); }
  .header h1 { font-size:17px; }
  .header .sub { font-size:11px; opacity:.9; margin-top:2px; }
  .wrap { max-width:860px; margin:0 auto; padding:12px; }
  .banner { background:#fff3cd; border:1px solid #ffe69c; color:#7a5c00; border-radius:10px; padding:10px 12px; font-size:12px; line-height:1.6; margin-bottom:12px; }
  .card { background:#fff; border-radius:12px; box-shadow:0 1px 4px rgba(0,0,0,.08); padding:12px; margin-bottom:12px; }
  .card h2 { font-size:14px; color:#d63384; margin-bottom:8px; }
  .card .desc { font-size:11px; color:#999; line-height:1.6; margin-bottom:10px; }
  label { display:block; font-size:12px; color:#666; font-weight:bold; margin-bottom:4px; }
  input[type=text], textarea, select { width:100%; padding:10px; font-size:15px; border:1.5px solid #ddd; border-radius:9px; outline:none; font-family:inherit; }
  input[type=text]:focus, textarea:focus, select:focus { border-color:#d63384; }
  textarea { min-height:80px; line-height:1.6; resize:vertical; }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
  .row .fld { flex:1; min-width:120px; }
  .btn { border:none; border-radius:9px; padding:10px 14px; font-size:13px; font-weight:bold; cursor:pointer; }
  .btn.pink { background:#d63384; color:#fff; }
  .btn.gray { background:#eee; color:#666; }
  .btn.green { background:#28a745; color:#fff; }
  .btn.small { padding:6px 10px; font-size:11px; }
  .btn.red { background:#fdecec; color:#c62828; border:1px solid #f5b5b5; }
  .ycat { font-size:12px; font-weight:bold; color:#a05070; background:#ffeef5; border-radius:6px; padding:4px 10px; margin:12px 0 6px; display:flex; justify-content:space-between; align-items:center; }
  .ycat .cnt { font-weight:normal; color:#c090a8; font-size:11px; }
  .yrow { display:flex; align-items:center; gap:8px; padding:7px 4px; border-bottom:1px solid #f4f4f4; font-size:13px; }
  .yrow.hid { opacity:.4; }
  .yrow .cd { font-size:10px; color:#aaa; width:42px; flex-shrink:0; font-variant-numeric:tabular-nums; }
  .yrow .nm { flex:1; min-width:0; }
  .yrow .nm .ab { font-size:10px; color:#aaa; margin-left:6px; }
  .yrow .own { font-size:9px; background:#e8f5e9; color:#2e7d32; border-radius:4px; padding:1px 5px; margin-left:5px; }
  .yrow .acts { flex-shrink:0; display:flex; gap:5px; }
  .chip { display:inline-block; background:#fff0f5; border:1.5px solid #ffd1dc; color:#d63384; border-radius:16px; padding:5px 10px; margin:0 5px 5px 0; font-size:12px; }
  .chip b { cursor:pointer; margin-left:6px; color:#c62828; }
  .kres { border:1px solid #f0e0e8; border-radius:9px; max-height:230px; overflow-y:auto; margin-top:8px; }
  .kitem { padding:9px 10px; border-bottom:1px solid #f6f6f6; cursor:pointer; font-size:13px; }
  .kitem:active { background:#fff5f9; }
  .kitem .sp { font-size:11px; color:#888; display:block; margin-top:2px; }
  .kbox { border:1.5px solid #ffd1dc; border-radius:10px; padding:10px; margin-top:8px; background:#fffdfe; }
  .savebar { position:fixed; bottom:0; left:0; right:0; background:#fff; border-top:1.5px solid #ffd1dc; padding:10px 12px; box-shadow:0 -2px 10px rgba(0,0,0,.08); z-index:60; }
  .savebar .inner { max-width:860px; margin:0 auto; display:flex; gap:8px; align-items:center; }
  .savebar input { flex:1; min-width:0; }
  .msg { font-size:12px; text-align:center; padding:6px; color:#666; }
</style></head><body>
  <div class="header">
    <h1>🦀 メディカニ鑑別 マスタ管理</h1>
    <div class="sub">用法マスタ・追加刻印・帳票の定型文を設定できますカニ🦀</div>
  </div>
  <div class="wrap">
    <div class="banner">
      ここでの変更は <b>この施設のメディカニ鑑別</b>にだけ反映されます。保存には施設の<b>管理パスワード</b>が必要カニ🦀<br>
      ※採用薬の追加・削除は従来どおり <b>/${hId}/admin</b> で行ってください。
    </div>

    <!-- ① 用法マスタ -->
    <div class="card">
      <h2>📝 用法マスタ</h2>
      <div class="desc">
        鑑別画面の「用法」ボタンに出てくる選択肢です。デフォルトは非表示にでき、施設独自の用法を追加できます。<br>
        コードは区分ごとに帯が決まっていて（内服=100番台／追加200番台、頓服=300／400…）、番号順に並びます。
      </div>
      <div id="yohoArea"></div>
      <div style="border-top:1px dashed #e8d0dc; margin-top:14px; padding-top:12px;">
        <label>➕ 用法を追加</label>
        <div class="row">
          <div class="fld" style="max-width:150px;"><select id="addCat"></select></div>
          <div class="fld"><input type="text" id="addName" placeholder="用法名（例：1日2回朝・夕）"></div>
          <div class="fld"><input type="text" id="addAbbr" placeholder="略称（例：2×朝夕）"></div>
          <button class="btn green" onclick="addYoho()">追加</button>
        </div>
        <div style="font-size:11px; color:#999; margin-top:6px;">略称は📋コピー時の短い表記に使われます（空欄なら用法名をそのまま使用）。</div>
      </div>
    </div>

    <!-- ② 用量・単位 -->
    <div class="card">
      <h2>🔢 用量・単位のプルダウン</h2>
      <div class="desc">用法編集窓の「1回 ◯ ◯◯」のプルダウンの中身です。カンマ区切りで書いてください。</div>
      <label>単位（先頭がデフォルト選択…ではなく「錠」があれば錠が初期選択されます）</label>
      <input type="text" id="unitsIn" placeholder="錠, カプセル, 包, g, mL">
      <label style="margin-top:10px;">用量</label>
      <input type="text" id="dosesIn" placeholder="0.5, 1, 1.5, 2, 3">
    </div>

    <!-- ③ 追加刻印 -->
    <div class="card">
      <h2>🔎 追加刻印（採用薬）</h2>
      <div class="desc">
        PMDAの識別コードに載っていない刻印を、採用薬に自分で足せます。ここで登録した刻印は<b>刻印検索でヒットするようになります</b>。<br>
        ※PMDA由来の索引とは別に保存されるので、マスタ更新で消えることはありません。
      </div>
      <input type="text" id="drugQ" placeholder="採用薬を名前でしぼり込み（例：アムロジピン）" oninput="renderDrugs()">
      <div class="kres" id="drugRes"></div>
      <div id="kokuinEdit"></div>
      <div style="border-top:1px dashed #e8d0dc; margin-top:14px; padding-top:12px;">
        <label>登録済みの追加刻印</label>
        <div id="kokuinList"></div>
      </div>
    </div>

    <!-- ④ 定型テキスト -->
    <div class="card">
      <h2>💬 帳票の定型テキスト</h2>
      <div class="desc">鑑別結果の「備考」の下に印刷される定型文です。現場で毎回書く決まり文句をここに入れておけます。</div>
      <textarea id="tmplTextIn" placeholder="例：上記持参薬について鑑別を行いました。継続・切替の可否および用法用量のご指示をお願いいたします。"></textarea>
      <button class="btn gray small" style="margin-top:8px;" onclick="resetTmpl('text')">デフォルトに戻す</button>
    </div>

    <!-- ⑤ 定型署名 -->
    <div class="card">
      <h2>✍️ 帳票の定型署名</h2>
      <div class="desc">定型テキストのさらに下、印刷時に<b>右寄せ</b>で出ます。改行するとそのまま複数行になります。</div>
      <textarea id="tmplSignIn" placeholder="例：鑑別実施　薬剤師：＿＿＿＿＿＿＿＿"></textarea>
      <button class="btn gray small" style="margin-top:8px;" onclick="resetTmpl('sign')">デフォルトに戻す</button>
    </div>

    <div class="msg" id="msg"></div>
    <div style="text-align:center; font-size:11px; color:#bbb; padding:10px 0 20px;">
      🦀 メディカニ鑑別 マスタ管理<br>© 2026 🐔トリの巣ワークス メディカニ運営事務局
    </div>
  </div>

  <div class="savebar">
    <div class="inner">
      <input type="password" id="adminPwd" placeholder="施設の管理パスワード">
      <button class="btn pink" onclick="saveAll('facility')">💾 保存</button>
      ${isSuper ? '<button class="btn gray" onclick="saveAll(&quot;default&quot;)">共通デフォルトに保存</button>' : ''}
    </div>
  </div>

<script>
const HID = "${hId}";
const IS_SUPER = ${isSuper ? "true" : "false"};
let DEF = null;          // 共通デフォルト
let OVR = null;          // 施設の上書き
let BLOCKS = [];         // 区分ごとの採番帯
let KOKUIN = { items: [] };
let ADOPTED = [];        // 採用薬一覧
let pickedDrug = null;   // 追加刻印の編集対象

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function setMsg(t, ok){ const m=document.getElementById('msg'); m.textContent=t; m.style.color = ok ? '#28a745' : '#666'; }

async function load(){
  setMsg('読み込み中...🦀');
  try {
    const r = await fetch('/api/kanbetsu/admin-config?h=' + encodeURIComponent(HID));
    const d = await r.json();
    if (d.error){ setMsg('⚠️ ' + d.error); return; }
    DEF = d.def; OVR = d.ovr; BLOCKS = d.blocks || []; KOKUIN = d.kokuin || { items: [] };
    document.getElementById('unitsIn').value = (OVR.units || DEF.units || []).join(', ');
    document.getElementById('dosesIn').value = (OVR.doses || DEF.doses || []).join(', ');
    document.getElementById('tmplTextIn').value = (OVR.tmplText !== null && OVR.tmplText !== undefined) ? OVR.tmplText : (DEF.tmplText || '');
    document.getElementById('tmplSignIn').value = (OVR.tmplSign !== null && OVR.tmplSign !== undefined) ? OVR.tmplSign : (DEF.tmplSign || '');
    document.getElementById('addCat').innerHTML = BLOCKS.map(function(b){ return '<option value="' + esc(b.cat) + '">' + esc(b.cat) + '</option>'; }).join('');
    renderYoho();
    renderKokuinList();
    setMsg('');
  } catch(e){ setMsg('⚠️ 読み込みに失敗しましたカニ🦀💦'); }
  try {
    const r2 = await fetch('/api/adopted-list?h=' + encodeURIComponent(HID));
    ADOPTED = await r2.json();
    renderDrugs();
  } catch(e){ ADOPTED = []; }
}

/* ===== 用法マスタ ===== */
function hideSet(){ return new Set((OVR.yohoHide || []).map(Number)); }

function renderYoho(){
  const hs = hideSet();
  let html = '';
  for (const b of BLOCKS){
    const defs = (DEF.yoho || []).filter(function(y){ return y.cat === b.cat; }).sort(function(a,c){ return a.code - c.code; });
    const adds = (OVR.yohoAdd || []).filter(function(y){ return y.cat === b.cat; }).sort(function(a,c){ return a.code - c.code; });
    if (!defs.length && !adds.length) continue;
    const live = defs.filter(function(y){ return !hs.has(Number(y.code)); }).length + adds.length;
    html += '<div class="ycat"><span>' + esc(b.cat) + '</span><span class="cnt">デフォルト ' + b.def + '番台 / 追加 ' + b.add + '番台　（有効 ' + live + '件）</span></div>';
    for (const y of defs){
      const hid = hs.has(Number(y.code));
      html += '<div class="yrow' + (hid ? ' hid' : '') + '">'
        + '<span class="cd">' + y.code + '</span>'
        + '<span class="nm">' + esc(y.name) + '<span class="ab">' + esc(y.abbr||'') + '</span></span>'
        + '<span class="acts"><button class="btn small ' + (hid ? 'green' : 'gray') + '" onclick="toggleHide(' + y.code + ')">' + (hid ? '表示に戻す' : '非表示') + '</button></span>'
        + '</div>';
    }
    for (const y of adds){
      html += '<div class="yrow">'
        + '<span class="cd">' + y.code + '</span>'
        + '<span class="nm">' + esc(y.name) + '<span class="ab">' + esc(y.abbr||'') + '</span><span class="own">施設</span></span>'
        + '<span class="acts">'
        +   '<button class="btn small gray" onclick="editYoho(' + y.code + ')">編集</button>'
        +   '<button class="btn small red" onclick="delYoho(' + y.code + ')">削除</button>'
        + '</span></div>';
    }
  }
  document.getElementById('yohoArea').innerHTML = html || '<div style="font-size:12px; color:#999; padding:10px;">用法マスタが空です。</div>';
}

function toggleHide(code){
  const hs = hideSet();
  if (hs.has(Number(code))) hs.delete(Number(code)); else hs.add(Number(code));
  OVR.yohoHide = Array.from(hs);
  renderYoho();
  setMsg('変更しました（まだ保存されていません。下の保存ボタンを押してください）');
}

function nextCode(cat){
  const b = BLOCKS.find(function(x){ return x.cat === cat; });
  if (!b) return 9001;
  const used = (OVR.yohoAdd || []).filter(function(y){ return y.cat === cat; }).map(function(y){ return Number(y.code); });
  let c = b.add + 1;
  while (used.indexOf(c) !== -1) c++;
  return c;
}

function addYoho(){
  const cat = document.getElementById('addCat').value;
  const name = document.getElementById('addName').value.trim();
  const abbr = document.getElementById('addAbbr').value.trim();
  if (!name){ alert('用法名を入力してくださいカニ🦀'); return; }
  OVR.yohoAdd = OVR.yohoAdd || [];
  OVR.yohoAdd.push({ code: nextCode(cat), cat: cat, name: name, abbr: abbr || name });
  document.getElementById('addName').value = '';
  document.getElementById('addAbbr').value = '';
  renderYoho();
  setMsg('追加しました（まだ保存されていません）');
}

function editYoho(code){
  const y = (OVR.yohoAdd || []).find(function(x){ return Number(x.code) === Number(code); });
  if (!y) return;
  const n = prompt('用法名', y.name);
  if (n === null) return;
  const a = prompt('略称（📋コピー用の短い表記）', y.abbr || '');
  if (a === null) return;
  y.name = n.trim() || y.name;
  y.abbr = a.trim() || y.name;
  renderYoho();
  setMsg('変更しました（まだ保存されていません）');
}

function delYoho(code){
  if (!confirm('この用法を削除しますか？')) return;
  OVR.yohoAdd = (OVR.yohoAdd || []).filter(function(x){ return Number(x.code) !== Number(code); });
  renderYoho();
  setMsg('削除しました（まだ保存されていません）');
}

/* ===== 定型文 ===== */
function resetTmpl(which){
  if (which === 'text') document.getElementById('tmplTextIn').value = DEF.tmplText || '';
  else document.getElementById('tmplSignIn').value = DEF.tmplSign || '';
  setMsg('デフォルトに戻しました（まだ保存されていません）');
}

/* ===== 追加刻印 ===== */
function renderDrugs(){
  const q = document.getElementById('drugQ').value.trim();
  const box = document.getElementById('drugRes');
  if (!ADOPTED.length){ box.innerHTML = '<div style="padding:12px; font-size:12px; color:#999;">採用薬が読み込めませんでした。/' + esc(HID) + '/admin で採用薬を登録してくださいカニ🦀</div>'; return; }
  if (!q){ box.innerHTML = '<div style="padding:12px; font-size:12px; color:#999;">薬名を入力すると採用薬がしぼり込まれます（' + ADOPTED.length + '件登録済み）</div>'; return; }
  const hit = ADOPTED.filter(function(d){ return String(d.name||'').indexOf(q) !== -1 || String(d.component||'').indexOf(q) !== -1; }).slice(0, 40);
  if (!hit.length){ box.innerHTML = '<div style="padding:12px; font-size:12px; color:#999;">該当なしカニ🦀</div>'; return; }
  box.innerHTML = hit.map(function(d, i){
    return '<div class="kitem" onclick="pickDrug(\\'' + esc(d.yj) + '\\')">' + esc(d.name)
      + '<span class="sp">' + esc(d.cat||'') + ' ' + esc(d.spec||'') + ' ／ ' + esc(d.component||'') + '</span></div>';
  }).join('');
}

function pickDrug(yj){
  const d = ADOPTED.find(function(x){ return String(x.yj) === String(yj); });
  if (!d) return;
  pickedDrug = d;
  renderKokuinEdit();
}

function itemFor(yj){
  KOKUIN.items = KOKUIN.items || [];
  let it = KOKUIN.items.find(function(x){ return String(x.yj) === String(yj); });
  if (!it){ it = { yj: String(yj), name: pickedDrug ? pickedDrug.name : '', codes: [] }; KOKUIN.items.push(it); }
  return it;
}

function renderKokuinEdit(){
  const box = document.getElementById('kokuinEdit');
  if (!pickedDrug){ box.innerHTML = ''; return; }
  const it = (KOKUIN.items || []).find(function(x){ return String(x.yj) === String(pickedDrug.yj); });
  const codes = it ? (it.codes || []) : [];
  box.innerHTML = '<div class="kbox">'
    + '<div style="font-weight:bold; font-size:13px; margin-bottom:6px;">💊 ' + esc(pickedDrug.name) + '</div>'
    + '<div style="font-size:11px; color:#999; margin-bottom:8px;">YJ: ' + esc(pickedDrug.yj) + '</div>'
    + '<div>' + (codes.length ? codes.map(function(c, i){ return '<span class="chip">' + esc(c) + '<b onclick="delCode(' + i + ')">×</b></span>'; }).join('') : '<span style="font-size:12px; color:#bbb;">まだ刻印がありません</span>') + '</div>'
    + '<div class="row" style="margin-top:8px;">'
    +   '<div class="fld"><input type="text" id="codeIn" placeholder="刻印（例：TW 25、表:あ 裏:123）"></div>'
    +   '<button class="btn green" onclick="addCode()">刻印を追加</button>'
    + '</div>'
    + '<div style="font-size:11px; color:#999; margin-top:6px;">表・裏それぞれ別に登録するのがおすすめ。大文字小文字・全角半角・スペースは検索時に自動で無視されます。</div>'
    + '<button class="btn gray small" style="margin-top:10px;" onclick="pickedDrug=null; renderKokuinEdit();">閉じる</button>'
    + '</div>';
}

function addCode(){
  if (!pickedDrug) return;
  const v = document.getElementById('codeIn').value.trim();
  if (!v){ alert('刻印を入力してくださいカニ🦀'); return; }
  const it = itemFor(pickedDrug.yj);
  it.name = pickedDrug.name;
  it.codes = it.codes || [];
  if (it.codes.indexOf(v) === -1) it.codes.push(v);
  renderKokuinEdit();
  renderKokuinList();
  setMsg('刻印を追加しました（まだ保存されていません）');
}

function delCode(i){
  if (!pickedDrug) return;
  const it = (KOKUIN.items || []).find(function(x){ return String(x.yj) === String(pickedDrug.yj); });
  if (!it) return;
  it.codes.splice(i, 1);
  if (!it.codes.length) KOKUIN.items = KOKUIN.items.filter(function(x){ return x !== it; });
  renderKokuinEdit();
  renderKokuinList();
  setMsg('刻印を削除しました（まだ保存されていません）');
}

function renderKokuinList(){
  const box = document.getElementById('kokuinList');
  const items = (KOKUIN.items || []).filter(function(x){ return (x.codes || []).length; });
  if (!items.length){ box.innerHTML = '<div style="font-size:12px; color:#bbb; padding:6px 0;">まだ登録がありません</div>'; return; }
  box.innerHTML = items.map(function(it){
    return '<div class="yrow"><span class="nm"><b style="font-size:12.5px;">' + esc(it.name) + '</b><br>'
      + it.codes.map(function(c){ return '<span class="chip" style="margin-top:4px;">' + esc(c) + '</span>'; }).join('')
      + '</span><span class="acts"><button class="btn small red" onclick="delKokuin(\\'' + esc(it.yj) + '\\')">全削除</button></span></div>';
  }).join('');
}

function delKokuin(yj){
  if (!confirm('この薬の追加刻印をすべて削除しますか？')) return;
  KOKUIN.items = (KOKUIN.items || []).filter(function(x){ return String(x.yj) !== String(yj); });
  if (pickedDrug && String(pickedDrug.yj) === String(yj)) renderKokuinEdit();
  renderKokuinList();
  setMsg('削除しました（まだ保存されていません）');
}

/* ===== 保存 ===== */
function splitList(s){ return String(s||'').split(/[,\\u3001\\uFF0C]/).map(function(x){ return x.trim(); }).filter(function(x){ return x; }); }

async function saveAll(scope){
  const pwd = document.getElementById('adminPwd').value;
  if (!pwd){ alert('施設の管理パスワードを入力してくださいカニ🦀'); return; }
  if (scope === 'default' && !confirm('【共通デフォルト】を上書きします。全施設の既定値に影響しますが、よろしいですか？')) return;

  const units = splitList(document.getElementById('unitsIn').value);
  const doses = splitList(document.getElementById('dosesIn').value);
  const tmplText = document.getElementById('tmplTextIn').value;
  const tmplSign = document.getElementById('tmplSignIn').value;

  let config;
  if (scope === 'default') {
    // デフォルト保存＝いま画面に見えているマージ結果を新しいデフォルトにする
    const hs = hideSet();
    const yoho = (DEF.yoho || []).filter(function(y){ return !hs.has(Number(y.code)); })
      .concat(OVR.yohoAdd || [])
      .map(function(y){ return { code: Number(y.code), cat: y.cat, name: y.name, abbr: y.abbr || y.name }; })
      .sort(function(a,b){ return a.code - b.code; });
    config = { version: 1, yoho: yoho, units: units, doses: doses, tmplText: tmplText, tmplSign: tmplSign };
  } else {
    config = {
      yohoAdd: OVR.yohoAdd || [],
      yohoHide: OVR.yohoHide || [],
      units: units,
      doses: doses,
      tmplText: tmplText,
      tmplSign: tmplSign
    };
  }

  setMsg('保存中...🦀');
  try {
    const res = await fetch('/api/kanbetsu/save?h=' + encodeURIComponent(HID), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pwd: pwd, scope: scope, config: config, kokuin: KOKUIN })
    });
    const j = await res.json();
    if (j.success){ setMsg('✅ 保存しましたカニ！🦀', true); if (scope === 'default') load(); }
    else if (j.error === 'auth') setMsg('⚠️ パスワードが違いますカニ🦀💦');
    else if (j.error === 'forbidden') setMsg('⚠️ 共通デフォルトの保存はスーパー管理施設のみですカニ🦀');
    else setMsg('⚠️ 保存に失敗しましたカニ🦀💦 ' + (j.error || ''));
  } catch(e){ setMsg('⚠️ 通信エラーが発生しましたカニ🦀💦'); }
}

load();
</script></body></html>`;
}
// === 🦀メディカニ鑑別: 管理画面 生成関数 (ここまで) ===





export default {
  async fetch(request, env) {
    const url = new URL(request.url);

      // 📦 jsQRライブラリを同一オリジンで配信（ページCSP回避）。jsDelivrを中継しエッジキャッシュ
      if (url.pathname === "/vendor/jsqr.js") {
        try {
          let up = await fetch("https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js", { cf: { cacheTtl: 604800, cacheEverything: true } });
          if (!up.ok) up = await fetch("https://unpkg.com/jsqr@1.4.0/dist/jsQR.js");
          const jsBody = await up.text();
          return new Response(jsBody, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=604800" } });
        } catch (e) {
          return new Response("/* jsQR load failed */", { status: 502, headers: { "content-type": "application/javascript; charset=utf-8" } });
        }
      }

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
    // === 🦀休薬チェッカー: 利用ページルート (ここから) ===
    // /{hId}/kyuyaku 患者の薬リスト→休薬判定→帳票印刷（_KYプランでゲート）
    if (hospitalId && pathParts[1] === "kyuyaku") {
      const isSuper = hospitalId === (env.SUPER_ADMIN_HID || "HPTEST1");
      if (!isSuper) {
        const plan = await env.MEDI_KV.get(`${hospitalId}_plan`) || "";
        if (!plan.endsWith("_KY")) {
          return new Response("休薬チェッカーオプションが有効ではありませんカニ🦀", {
            status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }
      }
      return new Response(kyuyakuCheckerPage(hospitalId, isSuper), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    // === 🦀休薬チェッカー: 利用ページルート (ここまで) ===

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

      // === 🦀メディカニ鑑別: マスタ管理画面ルート /{hId}/kanbetsu-admin (ここから) ===
      // 用法マスタ・追加刻印・定型文の設定画面。ゲートは /kanbetsu と同じ（持参薬オプション）。
      if (hospitalId && pathParts[1] === "kanbetsu-admin") {
        const isSuperKA = hospitalId === (env.SUPER_ADMIN_HID || "HPTEST1");
        if (!isSuperKA) {
          const kaFlag = await env.MEDI_KV.get(`${hospitalId}_jisan`) || "";
          if (kaFlag !== "1") {
            return new Response("持参薬オプションが有効ではありませんカニ🦀", {
              status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
          }
        }
        return new Response(kanbetsuAdminPage(hospitalId, isSuperKA), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      // === 🦀メディカニ鑑別: マスタ管理画面ルート (ここまで) ===

      // === 🦀持参薬鑑別(開発版): ページルート /{hId}/kanbetsu (ここから) ===
      // jisanと同じゲート（Z列オプション or スーパー管理施設）。OCR付きの開発版画面。
      if (hospitalId && pathParts[1] === "kanbetsu") {
        const isSuperKanbetsu = hospitalId === (env.SUPER_ADMIN_HID || "HPTEST1");
        if (!isSuperKanbetsu) {
          const kanbetsuFlag = await env.MEDI_KV.get(`${hospitalId}_jisan`) || "";
          if (kanbetsuFlag !== "1") {
            return new Response("持参薬オプションが有効ではありませんカニ🦀", {
              status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
          }
        }
        return new Response(kanbetsuPage(hospitalId, hospitalName), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      // === 🦀持参薬鑑別(開発版): ページルート (ここまで) ===

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

      // === 🦀メディカニ鑑別: 用法マスタ等の設定API (ここから) ===
      // 鑑別ページ用。共通デフォルト＋施設の追加をマージ済みの設定を返す。
      if (url.pathname.includes("/api/kanbetsu/config")) {
        try {
          const hId = url.searchParams.get("h") || "";
          const isSuperC = hId === (env.SUPER_ADMIN_HID || "HPTEST1");
          if (!isSuperC) {
            const flag = (hId ? await env.MEDI_KV.get(`${hId}_jisan`) : "") || "";
            if (flag !== "1") {
              return new Response(JSON.stringify({ error: "option_disabled" }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
          }
          const def = await loadKanbetsuDefault(env);
          const ovr = await loadKanbetsuOvr(hId, env);
          return new Response(JSON.stringify(mergeKanbetsuConfig(def, ovr)), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
      }

      // 管理画面用。デフォルトと施設分を「分けたまま」返す（どれが既定でどれが追加か見せるため）。
      if (url.pathname.includes("/api/kanbetsu/admin-config")) {
        try {
          const hId = url.searchParams.get("h") || "";
          const isSuperA = hId === (env.SUPER_ADMIN_HID || "HPTEST1");
          if (!isSuperA) {
            const flag = (hId ? await env.MEDI_KV.get(`${hId}_jisan`) : "") || "";
            if (flag !== "1") {
              return new Response(JSON.stringify({ error: "持参薬オプションが有効ではありません" }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
          }
          const def = await loadKanbetsuDefault(env);
          const ovr = await loadKanbetsuOvr(hId, env);
          const kokuin = await loadKokuinOvr(hId, env);
          return new Response(JSON.stringify({ def: def, ovr: ovr, kokuin: kokuin, blocks: YOHO_CAT_BLOCKS, isSuper: isSuperA }), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
      }
      // === 🦀メディカニ鑑別: 用法マスタ等の設定API (ここまで) ===


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
          // ===== 🌟追加: 施設が登録した追加刻印を先にマージする (ここから) =====
          // PMDA由来の索引(_IDCODE_INDEX)は idx2kv.py で丸ごと再生成されるため、
          // 施設の追加分は {hId}_kokuin_json に別置きして検索時に合流させる。
          // 先に入れることで、上限50件に達しても施設登録分が必ず残る。
          try {
            const ownKo = await loadKokuinOvr(hId, env);
            for (const it of (ownKo.items || [])) {
              const oyj = String(it.yj || "");
              if (!oyj || yjHit.has(oyj)) continue;
              for (const c of (it.codes || [])) {
                const cn = String(c).normalize("NFKC").toUpperCase().replace(/\s+/g, "");
                if (cn && cn.includes(qn)) {
                  yjHit.set(oyj, { code: String(c), pmdaName: it.name || "", own: true });
                  break;
                }
              }
            }
          } catch (e) { /* 追加刻印が壊れていても通常検索は続行 */ }
          // ===== 🌟追加: 施設が登録した追加刻印を先にマージする (ここまで) =====
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
          // 🌟変更: 全件listはメモリキャッシュ経由にして読み取り回数を削減
          const masterKeys = await getMasterKeysCached(env);
          const adoptedKeys = await getAdoptedKeysCached(hId, env);

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
            return { key, name: extracted.name, spec: extracted.spec, type: cleanType, yj: yj, isAdopted: isAdopted, isBrand: isBrand, price: extracted.price, code: hit.code || "", own: !!hit.own };
          }));

          let finalResults = results.filter(r => r !== null);

          // マスタに存在しないYJ（経過措置切れ等）はPMDA名でフォールバック表示
          const foundYJs = new Set(finalResults.map(r => r.yj));
          for (const [yj, info] of yjHit) {
            if (!foundYJs.has(yj)) {
              finalResults.push({ key: "", name: info.pmdaName, spec: "", type: "", yj: yj, isAdopted: false, isBrand: false, price: "", code: info.code, own: !!info.own });
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

      // === 🦀持参薬鑑別: 単名再照合 API /api/kanbetsu-rematch?h=&q= (ここから) ===
      // 未照合の薬品名を編集した時に、1件だけKV照合し直すためのAPI
      if (url.pathname.includes("/api/kanbetsu-rematch")) {
        try {
          const hId = url.searchParams.get("h") || "";
          const isSuperK = hId === (env.SUPER_ADMIN_HID || "HPTEST1");
          if (!isSuperK) {
            const flag = (hId ? await env.MEDI_KV.get(`${hId}_jisan`) : "") || "";
            if (flag !== "1") {
              return new Response(JSON.stringify({ error: "option_disabled" }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
          }
          const q = url.searchParams.get("q") || "";
          if (!q.trim()) {
            return new Response(JSON.stringify({ error: "empty" }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          const matched = await kanbetsuMatchNames([q], hId, env);
          return new Response(JSON.stringify({ match: matched[0] || { found: false } }), {
            headers: { "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
      }
      // === 🦀持参薬鑑別: 単名再照合 API (ここまで) ===

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

      // === 🌟新規追加: 休薬チェッカー 候補検索API GET /api/kyuyaku/search?h=&q= (ここから) ===
      // メディカニ本体と同じキー構造ロジックで、薬品名・成分名の両方から候補を返す。
      // ⚠️ GETなので必ず if (request.method === "GET") ブロックの内側に置くこと。
      // プラン判定は行わない（ページ自体がプランで守られているため）。
      if (url.pathname.includes("/api/kyuyaku/search")) {
        try {
          const hId = url.searchParams.get("h") || "";
          const rawQ = url.searchParams.get("q") || "";
          if (!env.MEDI_KV) {
            return new Response(JSON.stringify({ error: "KV未設定", results: [] }), { status: 500, headers: { "Content-Type": "application/json" } });
          }

          // ===== 🌟修正: 全角/半角のズレで必ず0件になっていた不具合の対応 (ここから) =====
          // 【症状】手入力でもOCRチップでも「該当する薬が見つかりませんでした」になる。
          // 【原因】マスタのキー名は英数字が全角（例:「錠６０ｍｇ」）なのに、クエリだけ
          //   半角に変換して素の includes で比較していたため、規格や英字を含む名前が
          //   一切ヒットしなかった。OCRチップはフルネームを投げるので特に全滅していた。
          // 【対策】キー側も同じルールで正規化（kvNormName）したインデックスと突き合わせ、
          //   さらに「メーカー名を外す→規格を外す→先頭一致」と段階的に緩めて候補を拾う。
          const qn = kvNormName(rawQ);
          if (qn.length < 2) {
            return new Response(JSON.stringify({ error: "2文字以上で検索してください", results: [] }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          const qNoMaker = qn.replace(/「[^」]*」/g, "");                                          // 「トーワ」等のメーカー名を外した版
          const qCore = qNoMaker.replace(/[0-9]+(?:\.[0-9]+)?(?:MG|ΜG|MCG|G|ML|%|単位|IU)/g, "");  // 規格（60MG等）も外した版

          // マスタ情報の上書きに使うのでキー一覧も取っておく（メモリキャッシュ経由）
          const masterKeys = await getMasterKeysCached(env);
          // 正規化済みインデックス（採用薬が先頭に積まれている）
          const IDX = await getNameIndexCached(hId, env);

          // メディカニ本体と同じ切り出しロジック（結果組み立てで使用）
          const getDrugNamePart = (key) => key.split("_").find(p => p.includes("[")) || key;
          const getComponentPart = (key) => { const ps = key.split("_"); return ps.length > 2 ? ps[ps.length - 2] : ""; };

          // 一致の強さでスコアリング（採用薬は必ず上に来るよう大きく加点）
          const scored = [];
          for (const e of IDX) {
            if (!e.n) continue;
            let s = 0;
            if (e.n === qn) s = 500;                                                  // 完全一致
            else if (e.n.includes(qn)) s = 300;                                       // 薬品名に丸ごと含まれる
            else if (qNoMaker.length >= 3 && e.n.includes(qNoMaker)) s = 260;          // メーカー名を外せば一致
            else if (qn.length >= 4 && qn.includes(e.n) && e.n.length >= 4) s = 220;   // 入力の方が長い（規格込み入力）
            else if (qCore.length >= 3 && e.n.includes(qCore)) s = 200;                // 規格も外せば一致
            else if (e.c && qCore.length >= 3 && e.c.includes(qCore)) s = 140;         // 成分名で一致
            else if (qCore.length >= 4 && e.n.includes("]" + qCore.slice(0, 4))) s = 90; // 先頭4文字が同じ
            if (!s) continue;
            if (e.adopted) s += 1000;                                                  // 🏥採用薬を最優先
            if (e.n.includes("]" + qn) || (qCore.length >= 3 && e.n.includes("]" + qCore))) s += 40; // 薬品名の前方一致を優先
            scored.push({ e: e, s: s });
          }
          // スコア降順 → 同点なら名前が短い方（＝余計な修飾が少ない方）を上に
          scored.sort((a, b) => (b.s - a.s) || (a.e.n.length - b.e.n.length));

          // 同じYJコードは1件に絞る（採用薬の方がスコアが高いので採用薬が残る）
          const seenYJ = new Set();
          const finalKeys = [];
          for (const it of scored) {
            const t = it.e.k.split("_").pop();
            if (t && seenYJ.has(t)) continue;
            if (t) seenYJ.add(t);
            finalKeys.push(it.e.k);
            if (finalKeys.length >= 40) break;
          }
          // ===== 🌟修正: 全角/半角のズレで必ず0件になっていた不具合の対応 (ここまで) =====

          const built = await Promise.all(finalKeys.map(async (key) => {
            const val = await env.MEDI_KV.get(key);
            if (!val) return null;
            let parts = String(val).split(/[,\uFF0C]/);
            const yj = getBestYJ(key, parts);
            const isAdopted = hId ? key.startsWith(`${hId}_`) : false;
            // 採用薬はマスタ情報で上書きして先発マーク・薬価を復活（本体検索と同じ）
            if (isAdopted && yj && yj !== "NONE") {
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
            const ext = extractDrugData(parts, yj);
            const isBrand = parts.some(p => String(p).includes("先発"));
            return {
              key: key,
              name: ext.name,
              spec: ext.spec,
              price: ext.price,
              type: ext.type.replace(/先発品?/g, ""),
              yj: yj,
              isAdopted: isAdopted,
              isBrand: isBrand,
              component: getComponentPart(key)
            };
          }));

          // 🌟変更: 並び順は上のスコアリング結果（finalKeys の順）をそのまま使う
          const order = new Map(finalKeys.map((k, i) => [k, i]));
          const results = built.filter(r => r !== null)
            .sort((a, b) => (order.get(a.key) || 0) - (order.get(b.key) || 0));

          return new Response(JSON.stringify({ results: results }), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e), results: [] }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
      }
      // === 🌟新規追加: 休薬チェッカー 候補検索API (ここまで) ===

      // === 🦀休薬チェッカー: 旧POST APIの死にコードを削除しました（ここから） ===
      // 【経緯】/api/admin/kyuyaku と /api/kyuyaku/lookup は POST なのに
      //   if (request.method === "GET") の内側に置かれており、永久に到達しない
      //   死にコードになっていた（動作には影響なし・二重管理で紛らわしいだけ）。
      // 【現在】実際に動いているのは GETブロックの外側にある↓の2本です。
      //   ・POST /api/kyuyaku/lookup      … 「休薬チェッカーのPOST API」節
      //   ・POST /api/admin/kyuyaku       … 同上
      //   直すときは必ずそちらを編集してください。
      // === 🦀休薬チェッカー: 旧POST APIの死にコードを削除しました（ここまで） ===
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
          // ===== 🌟追加: key が無く yj だけ渡された場合の口 (ここから) =====
          // 刻印検索で見つかったが薬価マスタ(MEDI_KV)に無い薬（key空・PMDA名フォールバック）用。
          // YJ前方7桁の兄弟薬を全カテゴリから集めて切替候補として返す。
          const yjParam = url.searchParams.get("yj") || "";
          if (!key && yjParam) {
            const byYj = await this.handleWebDetailByYj(yjParam, hId, env, url.searchParams.get("spec") || "");
            return new Response(JSON.stringify(byYj), { headers: { "Content-Type": "application/json" } });
          }
          // ===== 🌟追加: key が無く yj だけ渡された場合の口 (ここまで) =====
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
    // 👆【目印】ここが if (request.method === "GET") { ... } の閉じカッコ。以下はGETブロックの外側。

    // ===== 🌟修正追加: 休薬チェッカーのPOST API を GETブロックの外に設置 (ここから) =====
    // 【経緯】/api/kyuyaku/lookup と /api/admin/kyuyaku は POST なのに
    //   if (request.method === "GET") の内側に置かれていたため永久に到達せず、
    //   最終フォールバックの 404 "Not Found"（プレーンテキスト）が返り、
    //   フロントの res.json() が例外→「通信エラー」表示になっていた。
    // 【方針】ブロック内の旧コードは消さずに残す（到達不能な死にコードとして無害）。
    //   なお kyuyakuPlanOk() はGETブロック内で定義されておりここからは参照できないため、
    //   プラン判定は同じ条件をインラインで実装する。

    // --- 🦀休薬チェッカー: 手入力照合API POST /api/kyuyaku/lookup ---
    if (request.method === "POST" && url.pathname.includes("/api/kyuyaku/lookup")) {
      try {
        const body = await request.json();
        const hId = body.h || "";
        let planOk = false;
        if (hId) {
          if (hId === (env.SUPER_ADMIN_HID || "HPTEST1")) {
            planOk = true;
          } else {
            const plan = (await env.MEDI_KV.get(`${hId}_plan`)) || "";
            planOk = plan.endsWith("_KY");
          }
        }
        if (!planOk) {
          return new Response(JSON.stringify({ error: "option_disabled" }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        const names = Array.isArray(body.names) ? body.names.slice(0, 50).map(n => String(n)) : [];
        if (!names.length) {
          return new Response(JSON.stringify({ results: [] }), { headers: { "Content-Type": "application/json" } });
        }
        const matches = await kanbetsuMatchNames(names, hId, env);
        const results = names.map((n, i) => ({ name: n, match: matches[i] || { found: false } }));
        return new Response(JSON.stringify({ results: results }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // --- 🦀休薬チェッカー: 休薬マスタ保存API POST /api/admin/kyuyaku（パスワード必須） ---
    if (request.method === "POST" && url.pathname.includes("/api/admin/kyuyaku")) {
      try {
        const hId = url.searchParams.get("h") || "";
        let planOk = false;
        if (hId) {
          if (hId === (env.SUPER_ADMIN_HID || "HPTEST1")) {
            planOk = true;
          } else {
            const plan = (await env.MEDI_KV.get(`${hId}_plan`)) || "";
            planOk = plan.endsWith("_KY");
          }
        }
        if (!planOk) {
          return new Response(JSON.stringify({ success: false, error: "option_disabled" }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        const body = await request.json();
        const pwd = await env.MEDI_KV.get(`${hId}_pwd`);
        if (!hId || !pwd || body.pwd !== pwd) {
          return new Response(JSON.stringify({ success: false, error: "auth" }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        const data = body.data || {};
        data.updatedAt = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });

        if (body.scope === "default") {
          if (hId !== (env.SUPER_ADMIN_HID || "HPTEST1")) {
            return new Response(JSON.stringify({ success: false, error: "forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
          await env.MEDI_KV.put("KYUYAKU_DEFAULT_json", JSON.stringify(data));
        } else {
          await env.MEDI_KV.put(`${hId}_kyuyaku_json`, JSON.stringify(data));
        }
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    // ===== 🌟修正追加: 休薬チェッカーのPOST API (ここまで) =====

    // ===== 🦀メディカニ鑑別: マスタ保存API POST /api/kanbetsu/save (ここから) =====
    // ⚠️ POSTなので必ず if (request.method === "GET") ブロックの【外側】に置くこと。
    //    （内側に置くと永久に到達せず 404 になり、フロントで「通信エラー」になる）
    // ⚠️ パスをあえて /api/admin/ 配下にしていない：/api/admin/ は管理画面のログインCookie必須で、
    //    /kanbetsu-admin を単独で開いたときに「認証エラー」になってしまうため。
    //    その代わり、この中で施設の管理パスワード（{hId}_pwd）を必ず照合している。
    // body: { pwd, scope:"facility"|"default", config:{...}, kokuin:{items:[...]} }
    if (request.method === "POST" && url.pathname.includes("/api/kanbetsu/save")) {
      try {
        const hId = url.searchParams.get("h") || "";
        const isSuperK = hId === (env.SUPER_ADMIN_HID || "HPTEST1");
        if (!isSuperK) {
          const flag = (hId ? await env.MEDI_KV.get(`${hId}_jisan`) : "") || "";
          if (flag !== "1") {
            return new Response(JSON.stringify({ success: false, error: "option_disabled" }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
        }
        const body = await request.json();
        // 施設管理パスワードで認証（既存の {hId}_pwd を流用）
        const pwd = await env.MEDI_KV.get(`${hId}_pwd`);
        if (!hId || !pwd || body.pwd !== pwd) {
          return new Response(JSON.stringify({ success: false, error: "auth" }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        const stamp = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });

        if (body.config) {
          const cfg = body.config;
          if (body.scope === "default") {
            if (!isSuperK) {
              return new Response(JSON.stringify({ success: false, error: "forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
            await env.MEDI_KV.put("KANBETSU_DEFAULT_json", JSON.stringify({
              version: 1,
              yoho: Array.isArray(cfg.yoho) ? cfg.yoho : [],
              units: Array.isArray(cfg.units) ? cfg.units : [],
              doses: Array.isArray(cfg.doses) ? cfg.doses : [],
              tmplText: typeof cfg.tmplText === "string" ? cfg.tmplText : "",
              tmplSign: typeof cfg.tmplSign === "string" ? cfg.tmplSign : "",
              updatedAt: stamp
            }));
          } else {
            await env.MEDI_KV.put(`${hId}_kanbetsu_json`, JSON.stringify({
              yohoAdd: Array.isArray(cfg.yohoAdd) ? cfg.yohoAdd : [],
              yohoHide: Array.isArray(cfg.yohoHide) ? cfg.yohoHide.map(Number) : [],
              units: Array.isArray(cfg.units) ? cfg.units : [],
              doses: Array.isArray(cfg.doses) ? cfg.doses : [],
              tmplText: typeof cfg.tmplText === "string" ? cfg.tmplText : "",
              tmplSign: typeof cfg.tmplSign === "string" ? cfg.tmplSign : "",
              updatedAt: stamp
            }));
          }
        }

        // 追加刻印は常に施設ごと（共通デフォルトには置かない）
        if (body.kokuin) {
          const items = Array.isArray(body.kokuin.items) ? body.kokuin.items : [];
          const clean = items
            .map(it => ({
              yj: String(it.yj || "").replace(/[^a-zA-Z0-9]/g, ""),
              name: String(it.name || "").slice(0, 120),
              codes: Array.isArray(it.codes) ? it.codes.map(c => String(c).slice(0, 40)).filter(c => c.trim()) : []
            }))
            .filter(it => it.yj && it.codes.length)
            .slice(0, 500);
          await env.MEDI_KV.put(`${hId}_kokuin_json`, JSON.stringify({ items: clean, updatedAt: stamp }));
        }

        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    // ===== 🦀メディカニ鑑別: マスタ保存API POST /api/kanbetsu/save (ここまで) =====
// 👆【目印】ここまでが前回追加した /api/kyuyaku/lookup と /api/admin/kyuyaku

    // === 🌟新規追加: 休薬チェッカー専用OCR API POST /api/kyuyaku/ocr (ここから) ===
    // お薬手帳・薬剤情報提供書（薬情）・処方箋控え・薬剤リストのいずれにも対応。
    // 薬剤の特定はAIにさせず「読めた名前」だけを返す（人が検索して確定する設計）。
    // ⚠️ 鑑別の /api/kanbetsu-ocr とは別物。あちらのプロンプトは無改変で精度を維持する。
    if (request.method === "POST" && url.pathname.includes("/api/kyuyaku/ocr")) {
      try {
        const body = await request.json();
        const image = body.image || "";
        if (!image.startsWith("data:image/")) {
          return new Response(JSON.stringify({ error: "画像データがありません" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (!env.OPENAI_API_KEY) {
          return new Response(JSON.stringify({ error: "OPENAI_API_KEY未設定" }), { status: 500, headers: { "Content-Type": "application/json" } });
        }

        const kyuOcrPrompt = "あなたは病院薬剤部のOCR補助AIです。写真から「薬の名前」だけを抜き出してください。\n写真は お薬手帳／薬剤情報提供書（薬情）／処方箋の控え／院内の持参薬リスト／手書きや印刷の薬名一覧 など様々な形式があります。どの形式でも同じルールで抽出してください。\n【厳守ルール】\n1. 写真に写っている薬だけを抽出し、写っていない薬を絶対に追加しない（ハルシネーション禁止）。\n2. 薬品名が2行に折り返されている場合は結合して1つの薬品名にする。「トーワ」「サワイ」「日医工」などのメーカー名だけが次の行に来やすいので必ず結合する。\n3. 規格(mg・g・%等)やメーカー名「」が書かれていればそれも含める。書かれていない場合は無理に補わず、書かれている通りに返す。\n4. 成分名だけが並んだ一覧（例:「アスピリン」「ワーファリン」「アムロジピン」）でも、それぞれを薬品名として抽出する。番号付きの箇条書きでも同様。\n5. 規格の数値は写真の通りに正確に読む。0.5mgと1mgの混同、小数点の見落としは重大事故につながるため絶対に禁止。\n6. 【般】(一般名)の行と◆付きの販売名の行が両方ある場合は、◆の販売名を優先する。\n7. 剤形（錠・カプセル・OD錠・散・顆粒・軟膏・貼付剤など）が書かれていれば含める。\n8. 病院名・薬局名・日付・患者名・効能効果・服用の注意・処方日数・「以上」などの行は薬として数えない。\n9. usage には用量と用法（例:「1日2錠 1日2回 朝・夕食後」）が読み取れれば入れる。読み取れなければ空文字にする。\n10. 必ず次のJSON形式のみで出力: {\"names\":[{\"name\":\"薬品名\",\"usage\":\"用量 用法\"}]}\n11. 薬が1つも読み取れない場合は {\"names\":[]} を返す。";

        const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "user", content: [
                { type: "text", text: kyuOcrPrompt },
                { type: "image_url", image_url: { url: image, detail: "high" } }
              ] }
            ],
            response_format: { type: "json_object" },
            temperature: 0.0,
            max_tokens: 2000
          })
        });
        if (!aiRes.ok) {
          const errText = await aiRes.text();
          return new Response(JSON.stringify({ error: "OCR APIエラー: " + errText.slice(0, 200) }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
        const aiData = await aiRes.json();
        let names = [];
        try {
          const parsed = JSON.parse(aiData.choices[0].message.content);
          names = Array.isArray(parsed.names) ? parsed.names : [];
        } catch (e) { names = []; }
        names = names.filter(n => n && String(n.name || "").trim()).slice(0, 40)
                     .map(n => ({ name: String(n.name).trim(), usage: String(n.usage || "").trim() }));

        return new Response(JSON.stringify({ names: names }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    // === 🌟新規追加: 休薬チェッカー専用OCR API (ここまで) ===

    // === 🦀持参薬鑑別: 手帳OCR API POST /api/kanbetsu-ocr (ここから) ===
    // お薬手帳の写真をOpenAI Vision(gpt-4o-mini)でOCRし、薬品名＋用法を抽出。
    // 続けて各薬品名をKV照合（マスタ＋採用薬）し、マッチ情報付きで返す。
    if (request.method === "POST" && url.pathname.includes("/api/kanbetsu-ocr")) {
      try {
        const body = await request.json();
        const hId = body.h || "";
        // 🌟修正: プラン/オプション判定を撤去（ページ側で既にゲート済みのため）
        const image = body.image || "";
        if (!image.startsWith("data:image/")) {
          return new Response(JSON.stringify({ error: "画像データがありません" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (!env.OPENAI_API_KEY) {
          return new Response(JSON.stringify({ error: "OPENAI_API_KEY未設定" }), { status: 500, headers: { "Content-Type": "application/json" } });
        }

        // --- OpenAI Vision でOCR ---
        const ocrPrompt = "あなたは病院薬剤部のOCR補助AIです。お薬手帳の写真から、処方されている薬を読み取ってください。\n【厳守ルール】\n1. 写真に写っている薬だけを抽出し、写っていない薬を絶対に追加しない（ハルシネーション禁止）。\n2. 薬品名は2行に折り返されていることが多い。特に「トーワ」「サワイ」「日医工」などのメーカー名だけが次の行に来やすいので、続きの行を必ず結合して1つの薬品名として読み取る。例:「デュロキセチンカプセル２０ｍｇ「」+「トーワ」」→「デュロキセチンカプセル20mg「トーワ」」\n3. 薬品名には規格(mg・g・%等)と「メーカー名」まで含める。\n4. 【般】(一般名)の行と◆付きの販売名の行が両方ある場合は、◆の販売名を name に使う。処方箋【〇〇】のような参考表記の行は薬として数えない。\n5. 規格の数値は写真の通りに正確に読む。0.5mgと1mgの混同、小数点の見落としは重大事故につながるため絶対に禁止。自信が持てない場合も見えた通りに書く。\n6. usage には、1日量(例: 1日1C、1日2錠、1日3錠)と用法(例: 1日1回 朝食後、1日2回 朝・夕食後、1日3回 毎食後)の両方を読み取り、半角スペースで結合する。例:「1日1C 1日1回 朝食後」「1日2錠 1日2回 朝・夕食後」。用量と用法は離れた場所に書かれていることが多いので、その薬のブロック全体から探して結合すること。\n7. 「21日分」「14日分」などの処方日数は usage に含めない。\n8. 薬以外の行（病院名・日付・患者名・効能効果・服用の注意など）は含めない。\n9. 必ず次のJSON形式のみで出力: {\"drugs\":[{\"name\":\"薬品名\",\"usage\":\"用量 用法\"}]}\n10. 薬が1つも読み取れない場合は {\"drugs\":[]} を返す。";
        const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "user", content: [
                { type: "text", text: ocrPrompt },
                { type: "image_url", image_url: { url: image, detail: "high" } }
              ] }
            ],
            response_format: { type: "json_object" },
            temperature: 0.0,
            max_tokens: 2000
          })
        });
        if (!aiRes.ok) {
          const errText = await aiRes.text();
          return new Response(JSON.stringify({ error: "OCR APIエラー: " + errText.slice(0, 200) }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
        const aiData = await aiRes.json();
        let drugs = [];
        try {
          const parsed = JSON.parse(aiData.choices[0].message.content);
          drugs = Array.isArray(parsed.drugs) ? parsed.drugs : [];
        } catch (e) { drugs = []; }
        // 名前が空のものは除外し、最大30件に制限
        drugs = drugs.filter(d => d && String(d.name || "").trim()).slice(0, 30)
                     .map(d => ({ name: String(d.name).trim(), usage: String(d.usage || "").trim() }));

        // --- KV照合（1回のスキャンで全薬をマッチング） ---
        const matches = drugs.length ? await kanbetsuMatchNames(drugs.map(d => d.name), hId, env) : [];
        const result = drugs.map((d, i) => ({ name: d.name, usage: d.usage, match: matches[i] || { found: false } }));

        return new Response(JSON.stringify({ drugs: result }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    // === 🦀持参薬鑑別: 手帳OCR API (ここまで) ===

    // === 🦀持参薬鑑別: 手帳QR API POST /api/techo-qr (ここから) ===
    // お薬手帳QR（JAHIS規格）のデコード済みテキストを受け取り、201=医薬品/301=用法をパース。
    // 各薬品名を既存の kanbetsuMatchNames でKV照合し、手帳OCRと同じ {drugs:[{name,usage,match}]} で返す。
    if (request.method === "POST" && url.pathname.includes("/api/techo-qr")) {
      try {
        const body = await request.json();
        const hId = body.h || "";
        const isSuperQ = hId === (env.SUPER_ADMIN_HID || "HPTEST1");
        if (!isSuperQ) {
          const flag = (hId ? await env.MEDI_KV.get(`${hId}_jisan`) : "") || "";
          if (flag !== "1") {
            return new Response(JSON.stringify({ error: "option_disabled" }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
        }
        // texts: スキャンした複数QRのデコード済み文字列（スキャン順）。分割QRは連結して解釈する
        const texts = Array.isArray(body.texts) ? body.texts : (body.text ? [String(body.text)] : []);
        if (!texts.length) {
          return new Response(JSON.stringify({ error: "QRデータがありません" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const full = texts.join("");
        const lines = full.split(/\r\n|\n|\r/);
        const parsed = [];
        const pend = [];
        let curUsage = "";
        const flush = () => {
          for (const idx of pend) {
            parsed[idx].usage = [parsed[idx].qty, curUsage].filter(Boolean).join(" ").trim();
          }
          pend.length = 0;
        };
        for (const line of lines) {
          const f = line.split(/[,\uFF0C]/);
          const rec = (f[0] || "").trim();
          if (rec === "201") {                 // 医薬品レコード
            const name = (f[2] || "").trim();
            if (!name) continue;
            const qty = ((f[3] || "") + (f[4] || "")).trim();
            parsed.push({ name: name, usage: "", qty: qty });
            pend.push(parsed.length - 1);
          } else if (rec === "301") {            // 用法レコード
            const yoho = (f[2] || "").trim();
            const days = ((f[3] || "") + (f[4] || "")).trim();
            curUsage = [yoho, days].filter(Boolean).join(" ");
            flush();                             // 直前までの薬に用法を付与
          }
        }
        // 用法行が付かなかった薬（頃用など）は qty だけ usage に入れる
        for (const d of parsed) { if (!d.usage) d.usage = d.qty || ""; }
        const drugs = parsed.filter(d => d.name).slice(0, 30).map(d => ({ name: d.name, usage: (d.usage || "").trim() }));
        if (!drugs.length) {
          return new Response(JSON.stringify({ drugs: [] }), { headers: { "Content-Type": "application/json" } });
        }
        // --- KV照合（手帳OCRと完全に同じロジック）---
        const matches = await kanbetsuMatchNames(drugs.map(d => d.name), hId, env);
        const result = drugs.map((d, i) => ({ name: d.name, usage: d.usage, match: matches[i] || { found: false } }));

        return new Response(JSON.stringify({ drugs: result }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    // === 🦀持参薬鑑別: 手帳QR API (ここまで) ===

    // === 🦀持参薬鑑別: 裸錠刻印OCR API POST /api/kokuin-ocr (ここから) ===
    // 裸錠（PTPから出した錠剤・カプセル）のまとめ撮り写真をOpenAI Vision(gpt-4o-mini)でOCRし、
    // 各錠剤の刻印文字列を配列で返す。薬剤の特定はAIにさせない（人が刻印検索で確定する設計）。
    if (request.method === "POST" && url.pathname.includes("/api/kokuin-ocr")) {
      try {
        const body = await request.json();
        const hId = body.h || "";
        const isSuperKokuin = hId === (env.SUPER_ADMIN_HID || "HPTEST1");
        if (!isSuperKokuin) {
          const flag = (hId ? await env.MEDI_KV.get(`${hId}_jisan`) : "") || "";
          if (flag !== "1") {
            return new Response(JSON.stringify({ error: "option_disabled" }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
        }
        const image = body.image || "";
        if (!image.startsWith("data:image/")) {
          return new Response(JSON.stringify({ error: "画像データがありません" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (image.length > 6000000) {
          return new Response(JSON.stringify({ error: "画像が大きすぎます。撮り直してください" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (!env.OPENAI_API_KEY) {
          return new Response(JSON.stringify({ error: "OPENAI_API_KEY未設定" }), { status: 500, headers: { "Content-Type": "application/json" } });
        }

        const kokuinPrompt = "あなたは裸錠（PTPシートから出した錠剤・カプセル）の刻印・印字を書き起こすOCRアシスタントです。\n【厳守ルール】\n1. 写真に写っている錠剤・カプセルを1つずつ見て、それぞれの表面の刻印・印字（英数字・カタカナ・記号）を見えたとおりに imprint に書き起こす。例: KW 123、Tw.050、EE5。\n2. 写っていない錠剤を絶対に追加しない（ハルシネーション禁止）。\n3. 薬の名前や成分を推測して imprint に入れない。見えた文字の書き起こしだけ。\n4. 会社ロゴ・マークなど文字でない印は【ロゴ】【三角】のように【】で補足する。\n5. 割線（スコア線）のみで刻印が読めない錠剤は imprint を空文字にし、note に「割線のみ・刻印なし」と書く。\n6. 同じ1錠の表面と裏面が両方見える場合は、同じ1要素の imprint にスペース区切りでまとめてよい。別の錠剤と混同しないこと。\n7. 0とO、1とIなど紛らわしい文字も見えたとおりに書き、自信がない錠剤は confidence を「低」にする（その場合も必ず1要素として残す）。";
        const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "user", content: [
                { type: "text", text: kokuinPrompt },
                { type: "image_url", image_url: { url: image, detail: "high" } }
              ] }
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "kokuin_result",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    pills: {
                      type: "array",
                      description: "写真内の各錠剤/カプセルごとの刻印",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          imprint: { type: "string", description: "刻印・印字の書き起こし。ロゴ等は【】で補足。無ければ空文字" },
                          kind: { type: "string", enum: ["錠剤", "カプセル", "その他"], description: "剤形の見た目" },
                          confidence: { type: "string", enum: ["高", "中", "低"], description: "読み取り自信度" },
                          note: { type: "string", description: "割線/かすれ等の補足。無ければ空文字" }
                        },
                        required: ["imprint", "kind", "confidence", "note"]
                      }
                    }
                  },
                  required: ["pills"]
                }
              }
            },
            temperature: 0.0,
            max_tokens: 1500
          })
        });
        if (!aiRes.ok) {
          const errText = await aiRes.text();
          return new Response(JSON.stringify({ error: "OCR APIエラー: " + errText.slice(0, 200) }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
        const aiData = await aiRes.json();
        let pills = [];
        try {
          const parsed = JSON.parse(aiData.choices[0].message.content);
          pills = Array.isArray(parsed.pills) ? parsed.pills : [];
        } catch (e) { pills = []; }
        // 整形: 最大20錠・文字数制限
        pills = pills.slice(0, 20).map(p => ({
          imprint: String(p.imprint || "").trim().slice(0, 40),
          kind: p.kind || "その他",
          confidence: p.confidence || "中",
          note: String(p.note || "").trim().slice(0, 60)
        }));

        return new Response(JSON.stringify({ pills: pills }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    // === 🦀持参薬鑑別: 裸錠刻印OCR API (ここまで) ===

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

  // ===== 🌟追加: YJコードだけで切替候補を返す（薬価マスタ未収載＝key空の薬用） =====
  // 刻印検索のPMDA名フォールバックでリストに入れた薬は MEDI_KV にキーが無いため
  // handleWebDetail(kvKey) が使えない。ここではYJ前方7桁が同じ薬を
  // マスタ3カテゴリ＋施設採用薬から集めて alts として返す。
  // 戻り値の形は handleWebDetail と揃えてあるのでフロント側は同じ扱いでよい。
  async handleWebDetailByYj(yj, hospitalId, env, baseSpec = "") {
    const cleanYj = String(yj || "").replace(/[^a-zA-Z0-9]/g, "");
    const empty = {
      key: "", label: "[内]", fullName: "", yj: cleanYj, isAdopted: false, isBrand: false,
      comment: "", price: "", pmdaEfficacy: "", pmdaUsage: "", pmdaContra: "",
      pmdaWarnings: null, pmdaLastUpdated: "", alts: []
    };
    if (!cleanYj || cleanYj.length < 7) return empty;
    const yj7 = cleanYj.substring(0, 7);

    // キー一覧はメモリキャッシュから（採用薬を先頭に置いて優先させる）
    const masterKeys = await getMasterKeysCached(env);
    const adoptedKeys = await getAdoptedKeysCached(hospitalId, env);
    const allKeys = [...adoptedKeys, ...masterKeys];

    // YJ前方7桁が一致するキーだけ拾う（同じYJの重複は先に来た方＝採用薬を採用）
    const seenYJs = new Set();
    const keysToFetch = [];
    for (const k of allKeys) {
      const tail = k.split("_").pop();
      if (!tail || tail.length < 7 || tail.substring(0, 7) !== yj7) continue;
      if (tail === cleanYj) continue;   // 自分自身は切替候補に出さない
      if (seenYJs.has(tail)) continue;
      seenYJs.add(tail);
      keysToFetch.push(k);
    }
    if (!keysToFetch.length) return empty;

    const altPromises = keysToFetch.slice(0, 50).map(async (k) => {
      const v = await env.MEDI_KV.get(k);
      if (!v) return null;
      let p = String(v).split(/[,\uFF0C]/);
      const ayj = getBestYJ(k, p);
      const aIsAdopted = hospitalId ? k.startsWith(`${hospitalId}_`) : false;
      if (aIsAdopted) {
        // 採用薬はコメント部分を落としてから、マスタ情報で上書き（既存の詳細APIと同じ処理）
        const ayjIndex = p.findIndex(x => x.replace(/[^a-zA-Z0-9]/g, "") === ayj);
        if (ayjIndex !== -1 && ayjIndex < p.length - 1) { p = p.slice(0, ayjIndex + 1); }
        if (ayj && ayj !== "NONE") {
          const masterKey = masterKeys.find(mk => mk.endsWith(`_${ayj}`) || mk.endsWith(ayj));
          if (masterKey) {
            const mVal = await env.MEDI_KV.get(masterKey);
            if (mVal) {
              const mP = String(mVal).split(/[,\uFF0C]/);
              const mYjIdx = mP.findIndex(x => x.replace(/[^a-zA-Z0-9]/g, "") === ayj);
              if (mYjIdx !== -1) p = mP.slice(0, mYjIdx + 1);
            }
          }
        }
      }
      if (!ayj || ayj === "NONE" || ayj.substring(0, 7) !== yj7) return null;
      const extAlt = extractDrugData(p, ayj);
      const aIsBrand = p.some(x => String(x).includes("先発"));
      return { key: k, name: extAlt.name, spec: extAlt.spec, yj: ayj, isAdopted: aIsAdopted, isBrand: aIsBrand, price: extAlt.price };
    });

    let alts = (await Promise.all(altPromises)).filter(a => a !== null);
    // 名前＋規格が同じものは1つに
    const seen = new Set();
    alts = alts.filter(a => {
      const id = `${a.name}-${a.spec}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }).slice(0, 15);

    // 並び順は既存の詳細APIと同じ思想（採用薬 → 同mg数）
    const baseDose = normalizeDose(baseSpec);
    alts.sort((a, b) => {
      if (b.isAdopted !== a.isAdopted) return b.isAdopted - a.isAdopted;
      const aSame = normalizeDose(a.spec) === baseDose && baseDose !== "";
      const bSame = normalizeDose(b.spec) === baseDose && baseDose !== "";
      if (aSame !== bSame) return (bSame ? 1 : 0) - (aSame ? 1 : 0);
      return 0;
    });

    return Object.assign({}, empty, { alts: alts });
  },
  // ===== 🌟追加: YJコードだけで切替候補を返す (ここまで) =====

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
              resDiv.innerHTML = '<div class="no-results">📭 該当する採用薬が登録されていませんカニ🦀</div>';
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
            resDiv.innerHTML = html;
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
