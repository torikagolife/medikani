// Webサービス: 医薬品検索（メディカニ・ハイブリッド検索＆個別メモ対応版）
// 環境変数: OPENAI_API_KEY, MEDI_KV(バインディング), HELP_TEXT(ヘルプタブ用文章), KANI_TIPS(トップのつぶやき用), RESEND_API_KEY(オプション:メール送信API)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(p => p);
    
    // パスの1番目を施設IDとして取得（apiパスは除外）
    const hospitalId = (pathParts[0] && !pathParts[0].startsWith('api')) ? pathParts[0] : "";

    // === 新規追加: Basic認証の判定ロジック (ここから) ===
    const isAdminResetPage = pathParts[1] === "admin" && pathParts[2] === "reset" && pathParts[0] !== "api";
    const isAdminResetApi = url.pathname.includes("/api/admin/reset");
    const isAdminApi = url.pathname.includes("/api/admin/") && !isAdminResetApi;
    const isAdminPage = pathParts[1] === "admin" && pathParts[0] !== "api" && !isAdminResetPage;

    if (isAdminApi || isAdminPage) {
      const targetHId = url.searchParams.get("h") || hospitalId;
      const isAuth = await this.checkAuth(request, env, targetHId);
      if (!isAuth) {
        if (isAdminApi) {
          return new Response(JSON.stringify({error: "認証エラー"}), { status: 401, headers: { "WWW-Authenticate": `Basic realm="Medikani Admin"`, "Content-Type": "application/json" } });
        } else {
          // ブラウザの認証ダイアログで「キャンセル」を押した時に表示される画面（ここに再発行へのリンクを置く）
          return new Response(this.getAuthFailedHTML(targetHId), { status: 401, headers: { "WWW-Authenticate": `Basic realm="Medikani Admin"`, "Content-Type": "text/html;charset=UTF-8" } });
        }
      }
    }
    // === 新規追加: Basic認証の判定ロジック (ここまで) ===

    // --- 1. Web画面の表示 (GETリクエスト) ---
    if (request.method === "GET") {
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
      if (isAdminResetPage) {
        return new Response(this.getResetHTML(env, hospitalId), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
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
            realCount += list.keys.filter(k => !k.name.endsWith("_meta") && !k.name.endsWith("_pwd") && !k.name.endsWith("_email") && !k.name.endsWith("_board") && !k.name.includes("COMP_")).length;
            cursor = list.list_complete ? "" : list.cursor;
          } while (cursor);
          meta.count = realCount;
          // ==============================================================

          meta.email = currentEmail || "未登録"; // 画面表示用にメアドも含めて返す
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
            keys.push(...list.keys.map(k => k.name).filter(n => !n.endsWith("_meta") && !n.endsWith("_pwd") && !n.endsWith("_email") && !n.endsWith("_board")));
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
            keys.push(...list.keys.map(k => k.name).filter(n => !n.endsWith("_meta") && !n.endsWith("_pwd") && !n.endsWith("_email") && !n.endsWith("_board") && !n.includes("COMP_")));
            cursor = list.list_complete ? "" : list.cursor;
          } while (cursor);

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
                const name = (p[0] || "").replace(/"/g, '""');
                const spec = (p[1] || "").replace(/"/g, '""');
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
      // === 新規追加: CSVダウンロード API (ここまで) ===
      
      if (isAdminPage) {
        return new Response(this.getDashboardHTML(env, hospitalId), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
      }
      // === 新規追加: 管理画面と管理用API (ここまで) ===
      
      // メイン画面の表示
      return new Response(this.getAdminHTML(env, hospitalId), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
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
        }

        await env.MEDI_KV.put(`${bHId}_board`, JSON.stringify(boardArr));
        return new Response(JSON.stringify({success: true}), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // === 新規追加: CSVアップロード等の POST API (ここから) ===
    if (request.method === "POST" && url.pathname.includes("/api/admin/upload")) {
      try {
        const uploadHId = url.searchParams.get("h") || ""; 
        const body = await request.json();
        const items = body.items || [];
        const deletes = body.deletes || [];
        
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

    // パスワード変更 (管理画面内から)
    if (request.method === "POST" && url.pathname.includes("/api/admin/changepwd")) {
      try {
        const cpBody = await request.json();
        const cpHId = url.searchParams.get("h") || "";
        await env.MEDI_KV.put(`${cpHId}_pwd`, cpBody.newPwd);
        return new Response(JSON.stringify({success: true}), { headers: { "Content-Type": "application/json" } });
      } catch(e) { return new Response(JSON.stringify({error: e.message}), { status: 500 }); }
    }

    // メールアドレス変更 (管理画面内から)
    if (request.method === "POST" && url.pathname.includes("/api/admin/changemail")) {
      try {
        const cmBody = await request.json();
        const cmHId = url.searchParams.get("h") || "";
        await env.MEDI_KV.put(`${cmHId}_email`, cmBody.newEmail);
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
    const authHeader = request.headers.get('Authorization');
    
    // KVからパスワードを取得（未設定なら、HPTEST1は'12345'、その他は施設IDそのものを初期パスワードにする）
    let pwd = await env.MEDI_KV.get(`${hId}_pwd`);
    if (!pwd) pwd = (hId === 'HPTEST1') ? '12345' : hId;

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

  getResetHTML(env, hId) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>パスワード再発行 - メディカニ</title>
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
      <input type="text" id="hId" value="${hId}" readonly style="background:#f0f0f0; color:#777;">
      
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
              content: "あなたは経験20年の凄腕薬剤師『メディカニくん』です。ユーザーの入力（不完全な名称やひらがなを含む）から、最も可能性の高い具体的な市販薬を推測・特定してください。回答の冒頭には必ず『対象：確定した製品名（例：アレグラFX）』を記載し、以下の形式で回答してください。\n\n主成分：\n特徴：\n切替候補：\n\n※「切替候補」には医療用医薬品の同等成分の一般名を1つだけ、括弧や補足なしで記載してください。\n最後に改行して『※AIによる参考情報ですカニ🦀 詳細は最新の添付文書を確認してください。』と必ず記載すること。全体で150文字以内で。" 
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

  // === 新規追加: 詳細画面用AIヘルパー (ここから) ===
  async askDetailAI(drugName, apiKey) {
    if (!apiKey) return "AIキーが設定されていませんカニ🦀";
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ 
          model: "gpt-4o-mini", 
          messages: [
            { 
              role: "system", 
              content: "あなたは経験２０年の凄腕薬剤師です。提示された薬品名について、医療従事者向けに以下の指定フォーマットで出力してください。推測や不確実な情報は絶対に書かないでください。\n\n薬効： （※この薬が何に使われるか、1文で）\n観察ポイント： （※服用後に注意すべき症状や副作用）\n注意： （※粉砕不可、食直後、水多めなど、与薬時の注意点、点滴は投与速度、混注不可、 遮光 など）\n\n※最後に改行して『※AIによる参考情報ですカニ🦀 必ず最新の添付文書を確認してください。』と必ず記載すること。全体で200文字以内で。"
            }, 
            { role: "user", content: `薬品名：${drugName}` }
          ], 
          max_tokens: 250 
        })
      });
      const d = await res.json();
      return d.choices?.[0]?.message?.content || "情報を取得できませんでしたカニ🦀";
    } catch (e) { return "通信エラーが発生しましたカニ🦀"; }
  },
  // === 新規追加: 詳細画面用AIヘルパー (ここまで) ===

  async handleWebSearch(query, category, hospitalId, env) {
    if (!query || query.length < 2) return [];
    const hiraQuery = hiraToKata(query);
    
    // --- ハイブリッド検索 ---
    let masterKeys = [];
    let mCursor = "";
    do {
      const list = await env.MEDI_KV.list({ prefix: category, limit: 1000, cursor: mCursor || undefined });
      masterKeys.push(...list.keys.map(k => k.name));
      mCursor = list.list_complete ? "" : list.cursor;
    } while (mCursor);

    let adoptedKeys = [];
    if (hospitalId) {
      let aCursor = "";
      do {
        const list = await env.MEDI_KV.list({ prefix: `${hospitalId}_${category}`, limit: 1000, cursor: aCursor || undefined });
        adoptedKeys.push(...list.keys.map(k => k.name));
        aCursor = list.list_complete ? "" : list.cursor;
      } while (aCursor);
    }

    const matchedMaster = masterKeys.filter(k => k.includes(hiraQuery));
    const matchedAdopted = adoptedKeys.filter(k => k.includes(hiraQuery));

    let finalKeys = [];
    if (hospitalId) {
      const adoptedSuffixes = new Set(matchedAdopted.map(k => k.replace(`${hospitalId}_`, "")));
      const filteredMaster = matchedMaster.filter(k => !adoptedSuffixes.has(k));
      finalKeys = [...matchedAdopted, ...filteredMaster].slice(0, 30);
    } else {
      finalKeys = matchedMaster.slice(0, 30);
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
      }
      const rawType = (parts[3] || "").trim();
      const isBrand = (yj && yj.length >= 11 && yj.charAt(10) === '1') || rawType.includes("先");
      const cleanType = rawType.replace(/先発品?/g, "").trim();
      return { key, name: (parts[0] || "").trim(), spec: (parts[1] || "").trim(), type: cleanType, yj: yj, isAdopted: isAdopted, isBrand: isBrand };
    }));
    return results.filter(r => r !== null).sort((a, b) => b.isAdopted - a.isAdopted);
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
    if (isAdopted) {
      const yjIndex = parts.findIndex(p => p.replace(/[^a-zA-Z0-9]/g, "") === yj);
      if (yjIndex !== -1 && yjIndex < parts.length - 1) {
        comment = parts.slice(yjIndex + 1).join(",").trim();
        parts = parts.slice(0, yjIndex + 1);
      }
    }
    const rawType = (parts[3] || "").trim();
    const isBrand = (yj && yj.length >= 11 && yj.charAt(10) === '1') || rawType.includes("先");
    const fullName = `${parts[0]||""} ${parts[1]||""} ${rawType.replace(/先発品?/g, "")}`.replace(/\s+/g, ' ').trim();
    const yj7 = (yj && yj !== "NONE") ? yj.substring(0, 7) : null;
    let alts = [];
    if (yj7) {
      let cursor = "";
      let allCategoryKeys = [];
      do {
        const list = await env.MEDI_KV.list({ prefix: label, limit: 1000, cursor: cursor || undefined });
        allCategoryKeys.push(...list.keys.map(k => k.name));
        cursor = list.list_complete ? "" : list.cursor;
      } while (cursor);
      if (hospitalId) {
        let aCursor = "";
        do {
          const list = await env.MEDI_KV.list({ prefix: `${hospitalId}_${label}`, limit: 1000, cursor: aCursor || undefined });
          allCategoryKeys.push(...list.keys.map(k => k.name));
          aCursor = list.list_complete ? "" : list.cursor;
        } while (aCursor);
      }
      const prefix2 = (parts[0] || "").substring(0, 2);
      const prefix3 = (parts[0] || "").substring(0, 3);
      const keysToFetch = allCategoryKeys.filter(k => {
        if (k === kvKey) return false;
        if (yj7 && k.includes(yj7)) return true;
        if (prefix3 && k.includes(prefix3)) return true;
        if (prefix2 && k.includes(prefix2)) return true;
        return false;
      });
      const uniqueKeysToFetch = [];
      const seenSuffixes = new Set();
      for (const k of keysToFetch.filter(k => hospitalId && k.startsWith(`${hospitalId}_`))) {
        uniqueKeysToFetch.push(k);
        seenSuffixes.add(k.replace(`${hospitalId}_`, ""));
      }
      for (const k of keysToFetch.filter(k => !(hospitalId && k.startsWith(`${hospitalId}_`)))) {
        if (!seenSuffixes.has(k)) uniqueKeysToFetch.push(k);
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
        }
        if (ayj && ayj.substring(0, 7) === yj7) {
          const aRawType = (p[3]||"").trim();
          const aIsBrand = (ayj && ayj.length >= 11 && ayj.charAt(10) === '1') || aRawType.includes("先");
          return { key: k, name: (p[0]||"").trim(), spec: (p[1]||"").trim(), yj: ayj, isAdopted: aIsAdopted, isBrand: aIsBrand };
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
    return { key: kvKey, label, fullName, yj, isAdopted, isBrand, comment, alts: alts.sort((a,b)=>b.isAdopted - a.isAdopted) };
  },

  getAdminHTML(env, hospitalId) {
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

    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦀</text></svg>">
    <title>メディカニ - 医薬品検索</title>
    <style>
      :root { --main-orange: #ff9d00; --bg: #fff9f0; }
      html { background: #333; display: flex; justify-content: center; }
      body { max-width: 500px; width: 100%; background: ${bgColor}; font-family: sans-serif; margin: 0; min-height: 100vh; box-shadow: 0 0 50px rgba(0,0,0,0.5); position: relative; transition: background 0.3s ease; }
      .header { background: ${headerBgColor}; padding: 15px; text-align: center; border-bottom: 3px solid var(--main-orange); border-radius: 0 0 15px 15px; transition: background 0.3s ease; }
      .header h1 { margin: 0; font-size: 22px; color: var(--main-orange); display: flex; align-items: center; justify-content: center; gap: 8px; }
      .search-box { padding: 15px; background: #fff; position: sticky; top: 0; z-index: 10; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border-radius: 0 0 15px 15px; margin-bottom: 10px; }
      .tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 15px; }
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

      .card { background: #fff; border-radius: 15px; padding: 16px; margin-bottom: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.03); cursor: pointer; border-left: 6px solid #ccc; transition: transform 0.1s; }
      .card:active { transform: scale(0.98); }
      .card.adopted { border-left-color: #28a745; }
      .no-results { text-align: center; padding: 40px 20px; color: #777; font-size: 15px; line-height: 1.6; }
      .help-box { background: #fff; padding: 20px; border-radius: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.03); line-height: 1.6; white-space: pre-wrap; font-size: 14px; color: #444; }
      .tag { font-size: 11px; padding: 4px 10px; border-radius: 20px; background: #eee; font-weight: bold; white-space: nowrap; display: inline-block; }
      .tag.green { background: #d1ffd1; color: #155724; }
      .tag.red { background: #ffebeb; color: #dc3545; border: 1px solid #ffcdd2; }
      .tag.blue { background: #e3f2fd; color: #0d47a1; border: 1px solid #bbdefb; }
      #modalOverlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); backdrop-filter: blur(3px); display: none; z-index: 1000; justify-content: center; align-items: center; }
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
    </style></head>
    <body>
      <div id="sysHelpData" style="display:none;">${env.HELP_TEXT || "環境変数 HELP_TEXT に使い方の説明などを設定してください。"}</div>
      <div class="header">
        <h1>
          <img src="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani.png" alt="メディカニロゴ" style="height: 60px;">
          メディカニ 医薬品検索💊
        </h1>
      </div>
      <div class="search-box">
        <div class="tabs">
          <button class="tab active" onclick="setCat('[内]', this)">💊 内服</button>
          <button class="tab" onclick="setCat('[外]', this)">🩹 外用</button>
          <button class="tab" onclick="setCat('[注]', this)">💉 注射</button>
          <button class="tab" onclick="setCat('[市販]', this)">🛒 市販薬</button>
          <button class="tab" onclick="setCat('[履歴]', this)">🕒 履歴</button>
          <button class="tab" onclick="setCat('[お気に入り]', this)">⭐️ お気に入り</button>
          <button class="tab" style="${demoBtnStyle}" onclick="setCat('[デモ]', this)">${demoBtnLabel}</button>
          <button class="tab" onclick="setCat('[ヘルプ]', this)">❓ ヘルプ</button>
        </div>
        <input type="text" id="q" placeholder="🔍 お薬名（かな・カナ３文字〜）..." oninput="search()">
      </div>
      <div id="loading">🦀 メディカニくんが一生懸命探しています... 💦</div>
      <div class="results" id="results">
        <div id="defaultDisplay">
          <div class="kani-tips-area">
            <img src="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani.png" class="kani-icon" alt="カニ">
            <div class="kani-bubble">${randomTip}</div>
          </div>
          <div id="boardArea"></div>
        </div>
      </div>
      <div id="modalOverlay" onclick="closeModal(event)"><div class="modal" onclick="event.stopPropagation()">
        <span class="modal-close" onclick="closeModal()">×</span>
        <div id="modalContent"></div>
      </div></div>
      <script>
        const hId = "${hospitalId}";
        let currentCat = '[内]'; let timer = null;
        let currentDetailData = null; 
        const promoHTML = \`
          <div class="promo-box">
            <div class="promo-title">📣 メディカニをシェアしてカニ〜！🦀✨</div>
            <p style="font-size:13px;color:#666;margin:5px 0 10px;">スマホでQRを読み取って、同僚や友人に教えてあげてね！🎁</p>
            <img src="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/QR.png" alt="メディカニQRコード" class="promo-qr">
            <div class="promo-copy-area">
              <textarea id="shareText" class="promo-text" readonly>🏥 採用薬が爆速でわかる「メディカニ」超便利だよ！🦀\n今すぐチェックカニ〜！✨\nhttps://medikani.com/</textarea>
              <button class="btn-copy" onclick="copyShareText()">📝 コピペしてシェアする</button>
              <span id="copyMsg" style="display:none;font-size:11px;color:#28a745;margin-left:8px;">✅ コピーしたカニ！🦀</span>
            </div>
          </div>
        \`;
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
          el.classList.add('active'); 
          search(); 
        }
        function searchAlt(kw) {
          document.getElementById('q').value = kw;
          setCat('[内]', document.querySelectorAll('.tab')[0]); 
        }
        function getFormEmoji(yj, ctx = "") {
          if (!yj || yj === "NONE" || yj.length < 8) return "💊";
          const f = yj.charAt(7).toUpperCase();
          const s = String(ctx);
          if (s.includes("注")) return "💉";
          if (s.includes("外")) {
            if (f === "S") return "🩹"; 
            if (f === "R") return "💨"; 
            if ("VWX".includes(f)) return "💧"; 
            return "🧴"; 
          }
          if ("ABCDE".includes(f)) return "🧂"; 
          if ("QRS".includes(f)) return "💧"; 
          return "💊"; 
        }
        function renderHistory() {
          const resDiv = document.getElementById('results');
          document.getElementById('loading').style.display = 'none';
          let hist = JSON.parse(localStorage.getItem('yakumiru_history') || '[]');
          if (hist.length === 0) {
            resDiv.innerHTML = '<div class="no-results">📭 まだメディカニくんが見たお薬はないみたいです 🦀<br><span style="font-size:12px;color:#aaa;">検索するとここに履歴が残ります✨</span></div>';
          } else {
            resDiv.innerHTML = hist.map(i => \`
              <div class="card \${i.isAdopted ? 'adopted' : ''}" onclick="showDetail('\${i.key}')">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; font-weight:bold; gap:8px;">
                  <div style="flex:1; line-height:1.4;">\${getFormEmoji(i.yj, i.key)} \${i.name}</div>
                  <div style="flex-shrink:0; display:flex; gap:4px; margin-top:2px;">
                    \${i.isBrand ? '<span class="tag blue">先</span>' : ''}
                    \${i.yj && i.yj.startsWith('8') ? '<span class="tag red">麻</span>' : ''}
                    \${i.isAdopted ? '<span class="tag green">🏥 採用</span>' : '<span class="tag">未採用</span>'}
                  </div>
                </div>
                <div style="font-size:12px; color:#888; margin-top:8px;">🕒 さいきん見たお薬カニ🦀</div>
              </div>\`).join('');
          }
        }
        function renderFavorites() {
          const resDiv = document.getElementById('results');
          document.getElementById('loading').style.display = 'none';
          let favs = JSON.parse(localStorage.getItem('yakumiru_favorites') || '[]');
          if (favs.length === 0) {
            resDiv.innerHTML = '<div class="no-results">⭐️ お気に入りはまだありませんカニ🦀<br><span style="font-size:12px;color:#aaa;">お薬の詳細画面で「⭐」を押すと登録できるよ！</span></div>';
          } else {
            resDiv.innerHTML = favs.map(i => \`
              <div class="card \${i.isAdopted ? 'adopted' : ''}" onclick="showDetail('\${i.key}')">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; font-weight:bold; gap:8px;">
                  <div style="flex:1; line-height:1.4;">\${getFormEmoji(i.yj, i.key)} \${i.name}</div>
                  <div style="flex-shrink:0; display:flex; gap:4px; margin-top:2px;">
                    \${i.isBrand ? '<span class="tag blue">先</span>' : ''}
                    \${i.yj && i.yj.startsWith('8') ? '<span class="tag red">麻</span>' : ''}
                    \${i.isAdopted ? '<span class="tag green">🏥 採用</span>' : '<span class="tag">未採用</span>'}
                  </div>
                </div>
                <div style="font-size:12px; color:#ff9d00; margin-top:8px; font-weight:bold;">⭐️ お気に入りカニ🦀</div>
              </div>\`).join('');
          }
        }
        function saveHistory(key, d) {
          try {
            let hist = JSON.parse(localStorage.getItem('yakumiru_history') || '[]');
            hist = hist.filter(h => h.key !== key);
            hist.unshift({ key: key, name: d.fullName, yj: d.yj, isAdopted: d.isAdopted, isBrand: d.isBrand });
            if (hist.length > 10) hist.pop();
            localStorage.setItem('yakumiru_history', JSON.stringify(hist));
            if (currentCat === '[履歴]') renderHistory();
          } catch(e) {}
        }
        function isFavorite(key) {
          let favs = JSON.parse(localStorage.getItem('yakumiru_favorites') || '[]');
          return favs.some(f => f.key === key);
        }
        function toggleFav() {
          if (!currentDetailData) return;
          let d = currentDetailData;
          let favs = JSON.parse(localStorage.getItem('yakumiru_favorites') || '[]');
          let idx = favs.findIndex(f => f.key === d.key);
          if (idx >= 0) {
            favs.splice(idx, 1);
            document.getElementById('favStar').innerText = '⭐';
          } else {
            favs.unshift({ key: d.key, name: d.fullName, yj: d.yj, isAdopted: d.isAdopted, isBrand: d.isBrand });
            document.getElementById('favStar').innerText = '🌟';
          }
          localStorage.setItem('yakumiru_favorites', JSON.stringify(favs));
          if (currentCat === '[お気に入り]') renderFavorites();
        }
        function search() {
          const q = document.getElementById('q').value.trim();
          const resDiv = document.getElementById('results');
          if (currentCat === '[ヘルプ]') {
            clearTimeout(timer);
            document.getElementById('loading').style.display = 'none';
            const helpEl = document.getElementById('sysHelpData');
            resDiv.innerHTML = '<div class="help-box">' + (helpEl ? helpEl.innerHTML : '説明文がありませんカニ🦀') + '</div>' + promoHTML;
            return;
          }
          if (currentCat === '[履歴]') { clearTimeout(timer); renderHistory(); return; }
          if (currentCat === '[お気に入り]') { clearTimeout(timer); renderFavorites(); return; }

          if (currentCat === '[デモ]') {
            clearTimeout(timer);
            document.getElementById('loading').style.display = 'none';
            if (hId) {
              resDiv.innerHTML = \`<div class="no-results" style="background:white; border-radius:20px; padding:30px; border:2px dashed var(--main-orange);">
                <h3 style="color:var(--main-orange);">✅ プラスモード動作中カニ🦀</h3>
                <p style="font-size:14px; color:#666; margin-top:10px;">現在、施設ID「\${hId}」の環境で動作しています。<br>採用薬や、限定メモが優先表示されますカニ🦀</p>
                <div style="display:flex; flex-direction:column; gap:10px; margin-top:20px;">
                  <a href="/" style="background:#eee; color:#555; padding:15px; border-radius:15px; text-decoration:none; font-weight:bold;">🌍 一般モードに戻る</a>
                  <a href="/\${hId}/admin" style="background:#fff0f5; color:#d63384; padding:15px; border-radius:15px; text-decoration:none; font-weight:bold; border:1px solid #ffcdd2;">⚙️ 管理画面を開く</a>
                </div>
              </div>\`;
            } else {
              resDiv.innerHTML = \`<div class="no-results" style="background:white; border-radius:20px; padding:30px; border:2px dashed var(--main-orange);">
                <h3 style="color:var(--main-orange);">✨ メディカニ・プラス体験版</h3>
                <p style="font-size:14px; color:#666; margin-top:10px;">施設ごとの「採用薬」や「メモ」を表示できる法人向け機能のデモですカニ🦀</p>
                <div style="display:flex; flex-direction:column; gap:10px; margin-top:20px;">
                  <a href="/HPTEST1" style="background:var(--main-orange); color:white; padding:15px; border-radius:15px; text-decoration:none; font-weight:bold;">🏥 デモ施設（HPTEST1）を試す</a>
                </div>
                <p style="font-size:11px; color:#aaa; margin-top:15px;">※URLの末尾に施設IDを入れるだけで専用環境に切り替わりますカニ🦀</p>
              </div>\`;
            }
            return;
          }
          
          // 検索文字が空になったらデフォルト表示（カニのつぶやき ＋ お知らせ）に戻す
          if (q.length === 0) {
            resDiv.innerHTML = '<div id="defaultDisplay"><div class="kani-tips-area"><img src="https://pub-c7c02d36bdac4c67bd68891550df9b90.r2.dev/kani.png" class="kani-icon" alt="カニ"><div class="kani-bubble">' + (window.currentKaniTip || 'お薬名を入力してみてカニ！🦀') + '</div></div><div id="boardArea">' + (window.boardHTML || '') + '</div></div>';
            return;
          }
          if (q.length < 2) { resDiv.innerHTML = ''; return; }
          
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
                infoHtml = infoHtml.replace(/対象[:：]\\s*([^\\n]+)/, function(match, name) {
                   return "<div style='font-weight:bold; color:#d63384; margin-bottom:8px; border-bottom:1px dashed #ffd1dc; padding-bottom:4px;'>💊 薬品名： " + name.trim() + "</div>";
                });
                infoHtml = infoHtml.replace(/切替候補[:：]\\s*([^\\n]+)/, function(match, kw) {
                  var cleanKw = kw.trim().replace(/['"]/g, "");
                  return "切替候補：<span style='font-weight:bold; color:#0056b3;'>" + cleanKw + "</span> <button onclick=\\"searchAlt('" + cleanKw + "')\\" style='background:var(--main-orange);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;margin-left:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);font-weight:bold;vertical-align:middle;'>🔍 切替候補を探す</button>";
                });
                const searchKw = data.kataQuery || q;
                resDiv.innerHTML = '<div class="card" style="border-left-color:#e83e8c;">' +
                  '<div style="font-weight:bold; color:#e83e8c; margin-bottom:12px;">👩‍⚕️ メディカニくんの解説 🦀✨</div>' +
                  '<div style="font-size:14px; background:#fff0f5; padding:12px; border-radius:10px; margin-bottom:12px; line-height:1.6; white-space:pre-wrap; border: 1px solid #ffd1dc;">' + infoHtml + '</div>' +
                  '<a href="https://www.google.com/search?q=' + encodeURIComponent(searchKw + ' 医療用 同成分') + '" class="btn btn-google" target="_blank" style="display:flex;">🔍 Googleで処方薬を探す</a>' +
                '</div>';
              } else if (!data || data.length === 0) {
                resDiv.innerHTML = '<div class="no-results">📭 アレ…？お薬が見つかりませんでしたカニ🦀💦<br><span style="font-size:12px;color:#aaa;">名前のスペルを変えて試してみてね！</span></div>';
              } else {
                resDiv.innerHTML = data.map(i => \`
                  <div class="card \${i.isAdopted ? 'adopted' : ''}" onclick="showDetail('\${i.key}')">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; font-weight:bold; font-size:15px; gap:8px;">
                      <div style="flex:1; line-height:1.4;">\${getFormEmoji(i.yj, currentCat)} \${i.name}</div>
                      <div style="flex-shrink:0; display:flex; gap:4px; margin-top:2px;">
                        \${i.isBrand ? '<span class="tag blue">先</span>' : ''}
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
        fetch('/api/board?h=' + hId).then(r=>r.json()).then(data => {
          if (data && data.length > 0) {
            window.boardHTML = '<div style="margin-top:15px; font-weight:bold; color:var(--main-orange);">📢 お知らせ</div>' + 
              data.map(b => \`<div class="card" style="border-left-color:var(--main-orange); margin-top:10px;"><div style="font-size:12px; color:#888; margin-bottom:5px;">🕒 \${b.date}</div><div style="font-size:14px; line-height:1.6; white-space:pre-wrap;">\${b.message}</div></div>\`).join('');
          }
          // 初期表示時（検索欄が空の時）に流し込む
          if (document.getElementById('q').value.trim().length === 0 && document.getElementById('boardArea')) {
            document.getElementById('boardArea').innerHTML = window.boardHTML;
          }
        }).catch(e => {});

        // === 新規追加: 詳細画面用AI呼び出し処理 (ここから) ===
        async function fetchAIAdvice(drugName) {
          const btn = document.getElementById('btnAiAdvice');
          const area = document.getElementById('aiAdviceArea');
          btn.disabled = true;
          btn.innerHTML = '🦀 文献をあさっています... 💦';
          area.style.display = 'block';
          area.innerHTML = '<div style="text-align:center; color:#ff9d00;">少し待っててカニ...</div>';
          
          try {
            const res = await fetch(\`/api/detail-ai?q=\${encodeURIComponent(drugName)}\`);
            const d = await res.json();
            if (d.info) {
              btn.style.display = 'none';
              let html = d.info;
              html = html.replace(/薬効[：:]/g, '<span style="color:#d63384; font-weight:bold;">💊 薬効：</span>');
              html = html.replace(/観察ポイント[：:]/g, '<span style="color:#0056b3; font-weight:bold;">👀 観察ポイント：</span>');
              html = html.replace(/注意[：:]/g, '<span style="color:#e65100; font-weight:bold;">⚠️ 注意：</span>');
              area.innerHTML = html;
            } else {
              btn.disabled = false;
              btn.innerHTML = '🤖 メディカニくんに薬効と注意点を聞く';
              area.innerHTML = '<span style="color:#dc3545;">エラーが発生しましたカニ🦀💦</span>';
            }
          } catch(e) {
            btn.disabled = false;
            btn.innerHTML = '🤖 メディカニくんに薬効と注意点を聞く';
            area.innerHTML = '<span style="color:#dc3545;">通信エラーカニ🦀💦</span>';
          }
        }
        // === 新規追加: 詳細画面用AI呼び出し処理 (ここまで) ===

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

            // 薬品名をエスケープ（シングルクォーテーション等でのJSエラー防止）
            const safeDrugName = d.fullName.replace(/'/g, "\\'");

            document.getElementById('modalContent').innerHTML = \`
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                <h3 style="color:#0056b3; margin: 5px 15px 0 0; font-size:20px; flex:1; line-height:1.4; word-break: break-word;">\${getFormEmoji(d.yj, d.label)} \${d.fullName}</h3>
                <span id="favStar" onclick="toggleFav()" style="font-size:28px; cursor:pointer; padding:0; margin-right: 25px; margin-top: 2px; line-height:1; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1)); flex-shrink:0;" title="お気に入りに登録/解除">\${isFav ? '🌟' : '⭐'}</span>
              </div>
              <p style="font-weight:bold; font-size:15px; margin-top:0; margin-bottom:15px; color:\${d.isAdopted?'#28a745':'#888'}">
                \${d.isBrand ? '<span class="tag blue" style="margin-right:5px;">先</span>' : ''}
                \${isNarcotic ? '<span class="tag red" style="margin-right:5px;">麻</span>' : ''}
                \${d.isAdopted?'🏥 採用薬ですカニ！🦀':'🏠 未採用のお薬ですカニ🦀'}
              </p>
              \${commentHTML}

              <div style="margin-bottom:15px;">
                <button id="btnAiAdvice" onclick="fetchAIAdvice('\${safeDrugName}')" style="width:100%; background:#fff3e0; color:#e65100; border:1px solid #ffcc80; padding:10px; border-radius:8px; font-weight:bold; cursor:pointer; display:flex; justify-content:center; align-items:center; gap:8px; box-shadow:0 2px 4px rgba(255,157,0,0.1); transition:all 0.2s;">🤖 メディカニくんに薬効 and 注意点を聞く</button>
                <div id="aiAdviceArea" style="display:none; background:#fff9f0; border:1px solid #ffe0b2; border-radius:8px; padding:12px; margin-top:8px; font-size:13px; color:#444; line-height:1.6; white-space:pre-wrap;"></div>
              </div>
              <div class="btn-group"><a href="\${mUrl}" class="btn btn-medley" target="_blank">📘 メドレー</a><a href="\${gUrl}" class="btn btn-google" target="_blank">🔍 Google</a></div>
              <hr style="border:none; border-top:1px dashed #ccc; margin:15px 0;">
              <p style="font-weight:bold; font-size:14px; margin-bottom:12px; color:#555;">🔄 同成分・切替候補カニ🦀</p>
              \${d.alts && d.alts.length ? d.alts.map(a => {
                const aIsNarcotic = a.yj && a.yj.startsWith('8');
                return \`
                <a href="#" onclick="showDetail('\${a.key}'); return false;" class="alt-item \${a.isAdopted?'adopted':''}">
                  <div class="alt-item-content">
                    <span style="font-weight:bold;">\${getFormEmoji(a.yj, a.key)} \${a.name} <span style="font-weight:normal;color:#666;font-size:11px;">\${a.spec}</span></span>
                    <span style="font-weight:bold;color:\${a.isAdopted?'#28a745':'#aaa'};">
                      \${a.isBrand ? '<span class="tag blue" style="margin-right:5px;font-size:10px;">先</span>' : ''}
                      \${aIsNarcotic ? '<span class="tag red" style="margin-right:5px;font-size:10px;">麻</span>' : ''}
                      \${a.isAdopted?'🏥 採用':''} ❯
                    </span>
                  </div>
                </a>\`}).join('') : '<p style="font-size:13px; color:#999; text-align:center; padding:10px 0;">見つかりませんでしたカニ🦀💦</p>'}
              \${promoHTML}
              \${!hId ? \`<div onclick="closeModal(); setCat('[デモ]', document.querySelectorAll('.tab')[6]);" style="margin-top:20px; text-align:center; padding:12px; background:#fff0f5; border-radius:12px; border:1px dashed #ffb6c1; cursor:pointer; transition: opacity 0.2s;"><span style="color:#d63384;font-weight:bold;font-size:13px;">🦀メディカニ・プラスは採用薬が切替候補に出るカニ💚</span><br><span style="color:#999;font-size:11px;text-decoration:underline;margin-top:4px;display:inline-block;">プラス体験はこちら ✨</span></div>\` : ''}
            \`;
          } catch(e) {
            document.getElementById('modalContent').innerHTML = '<p style="text-align:center;padding:20px;color:#dc3545;font-weight:bold;">⚠️ 詳細を開けませんでしたカニ🦀💦</p>';
          }
        }
        function closeModal() { document.getElementById('modalOverlay').style.display = 'none'; }
      </script></body></html>`;
  },

  getDashboardHTML(env, hospitalId) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
    <title>メディカニ・プラス 管理画面🦀</title>
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
    </style></head>
    <body>
      <div class="header">
        <h1>🏥 メディカニ・プラス 管理画面</h1>
        <div style="font-size:12px; background:rgba(255,255,255,0.2); padding:4px 10px; border-radius:15px;">ID: ${hospitalId}</div>
      </div>
      <div class="container">
        <div class="card">
          <h2>📊 現在のステータス</h2>
          <div class="stat-grid">
            <div class="stat-box"><div class="label">採用薬 登録件数</div><div class="num" id="metaCount">--</div></div>
            <div class="stat-box"><div class="label">最終更新日時</div><div class="num" id="metaDate" style="font-size:16px; margin-top:12px;">確認中...</div></div>
          </div>
          <a href="/api/admin/download?h=${hospitalId}" class="btn" style="background:#17a2b8; margin-top:10px; display:flex; align-items:center; justify-content:center; gap:8px; text-decoration:none;">⬇️ 現在の採用薬CSVをダウンロード</a>
        </div>

        <div class="card">
          <h2>✏️ 個別編集（簡易版）</h2>
          <p style="font-size:12px; color:#666; margin-bottom:10px;">修正したい薬品を検索してから編集してくださいカニ🦀</p>
          <div style="display:flex; gap:8px;">
            <input type="text" id="adminSearchQ" placeholder="薬品名で検索..." style="flex:1; padding:10px; border:1px solid #ccc; border-radius:8px;">
            <button onclick="adminSearch()" style="padding:10px 20px; background:var(--main-blue); color:#fff; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">検索</button>
          </div>
          <div id="adminSearchResults" class="admin-item-list"></div>
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

        <div class="card">
          <h2>📥 CSVデータのアップロード</h2>
          <p style="font-size:12px; color:#666; margin-bottom:15px;">一括更新はこちら。既存データはすべて上書きされますカニ🦀</p>
          <label class="dropzone" id="dropzone">
            <div style="font-size:24px; margin-bottom:10px;">📄</div>
            <div style="font-size:14px; color:#555; font-weight:bold;">CSVファイルをタップして選択</div>
            <input type="file" id="csvFile" accept=".csv">
          </label>
          <div class="mapping-area" id="mappingArea">
            <h3 style="font-size:14px; color:#d63384; margin-top:0;">🔀 列の紐付け（自動選択）</h3>
            <div class="map-row"><label>💊 薬品名 (必須)</label><select id="mapName"></select></div>
            <div class="map-row"><label>📦 規格</label><select id="mapSpec"></select></div>
            <div class="map-row"><label>🔑 YJコード (必須)</label><select id="mapYJ"></select></div>
            <div class="map-row"><label>💬 メモ</label><select id="mapC1"></select></div>
            <div class="map-row" style="background:#fff3cd; padding:10px; border-radius:6px; border:1px solid #ffe69c; border-bottom:none; margin-top:15px;">
              <label style="color:#856404; margin-bottom:0; cursor:pointer;"><input type="checkbox" id="chkFullSync" checked> 🗑️ フル同期カニ🦀</label>
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
          <textarea id="boardMessage" placeholder="お知らせ内容を入力してください..." style="width:100%; height:80px; padding:10px; border:1px solid #ccc; border-radius:8px; box-sizing:border-box; font-family:sans-serif; margin-bottom:10px;"></textarea>
          <button onclick="postBoard()" style="width:100%; padding:12px; background:#28a745; color:#fff; border:none; border-radius:8px; font-weight:bold; cursor:pointer; margin-bottom:20px; transition: transform 0.1s;">📢 投稿する</button>
          
          <h3 style="font-size:14px; color:#444; margin-top:0; border-bottom:1px dashed #ccc; padding-bottom:5px;">📋 過去のお知らせ</h3>
          <div id="boardList" class="admin-item-list" style="max-height:300px; overflow-y:auto;"></div>
        </div>

        <div class="card" style="border-top: 4px solid #ff9d00;">
          <h2>🔑 パスワード変更</h2>
          <input type="password" id="changePwd" placeholder="新しいパスワードを入力カニ🦀" style="width:100%; padding:12px; border:1px solid #ccc; border-radius:8px; margin-bottom:15px; box-sizing:border-box; font-size:14px;">
          <button class="btn" id="btnChangePwd" style="background:#ff9d00; margin-top:0;">🔄 パスワードを変更</button>
          <div id="changeMsg" style="margin-top:15px; font-size:14px; font-weight:bold; text-align:center; display:none;"></div>
        </div>
        <div class="card" style="border-top: 4px solid #0056b3;">
          <h2>✉️ メールアドレス登録</h2>
          <p style="font-size:12px; color:#666; margin-bottom:15px;">現在登録中: <b id="currentEmail">確認中...</b></p>
          <input type="email" id="changeEmail" placeholder="新しいメールアドレスを入力カニ🦀" style="width:100%; padding:12px; border:1px solid #ccc; border-radius:8px; margin-bottom:15px; box-sizing:border-box; font-size:14px;">
          <button class="btn" id="btnChangeEmail" style="background:#0056b3; margin-top:0;">✉️ メールアドレスを登録</button>
          <div id="emailMsg" style="margin-top:15px; font-size:14px; font-weight:bold; text-align:center; display:none;"></div>
        </div>
        <div style="text-align:center; margin-top:20px; margin-bottom:40px;"><a href="/${hospitalId}" style="color:#0056b3; font-weight:bold; text-decoration:none;">🌍 実際の検索画面へ戻る</a></div>
      </div>
      <script>
        const hId = "${hospitalId}";
        let currentEditKey = "";

        fetch('/api/admin/meta?h=' + hId).then(r=>r.json()).then(d => {
          document.getElementById('metaCount').innerText = d.count || 0;
          if(d.lastUpdated) {
            const dt = new Date(d.lastUpdated);
            document.getElementById('metaDate').innerText = dt.toLocaleDateString('ja-JP') + ' ' + dt.toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit'});
          } else { document.getElementById('metaDate').innerText = '未登録'; }
          document.getElementById('currentEmail').innerText = d.email || '未登録';
        });

        // 管理画面用検索
        async function adminSearch() {
          const q = document.getElementById('adminSearchQ').value.trim();
          if(!q) return;
          const res = await fetch(\`/api/search?q=\${encodeURIComponent(q)}&h=\${hId}\`);
          const data = await res.json();
          const list = document.getElementById('adminSearchResults');
          if(!data.length) { list.innerHTML = '<p style="padding:15px; font-size:13px; color:#999;">見つかりませんでしたカニ🦀</p>'; return; }
          list.innerHTML = data.filter(i => i.isAdopted).map(i => \`
            <div class="admin-item">
              <div class="admin-item-info">
                <b>\${i.name}</b><br><small>\${i.spec}</small>
              </div>
              <div class="admin-item-actions">
                <button class="btn-small btn-edit" onclick="openAdminEdit('\${i.key.replace(/'/g, "\\\\'")}', '\${i.name.replace(/'/g, "\\\\'")}')">編集</button>
                <button class="btn-small btn-delete" onclick="adminDeleteItem('\${i.key.replace(/'/g, "\\\\'")}')">削除</button>
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
          const res = await fetch('/api/admin/changemail?h=' + hId, {method: 'POST', body: JSON.stringify({ newEmail })});
          const r = await res.json();
          if(r.success) { document.getElementById('currentEmail').innerText = newEmail; alert('登録完了カニ！🦀'); }
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
          const reader = new FileReader();
          reader.onload = (evt) => {
            const rows = parseCSV(evt.target.result);
            headers = rows[0]; parsedData = rows.slice(1);
            ['mapName', 'mapSpec', 'mapYJ', 'mapC1'].forEach((sid, idx) => {
              const sel = document.getElementById(sid);
              sel.innerHTML = '<option value="-1">なし</option>' + headers.map((h, i) => \`<option value="\${i}">\${h}</option>\`).join('');
              const mIdx = headers.findIndex(h => h.includes(['名', '規格', 'YJ', 'メモ'][idx]));
              if(mIdx !== -1) sel.value = mIdx;
            });
            document.getElementById('mappingArea').style.display = 'block';
          };
          reader.readAsText(e.target.files[0]);
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
            let cat = "[内]"; if("SRV".includes(yj.charAt(7))) cat="[外]"; if("AH".includes(yj.charAt(7))) cat="[注]";
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
        function loadBoard() {
          fetch('/api/board?h=' + hId).then(r=>r.json()).then(data => {
            const list = document.getElementById('boardList');
            if(!data || data.length===0) { list.innerHTML = '<p style="padding:15px; font-size:13px; color:#999;">お知らせはまだありませんカニ🦀</p>'; return; }
            list.innerHTML = data.map(b => \`
              <div class="admin-item" style="flex-direction:column; align-items:flex-start;">
                <div style="font-size:11px; color:#888; margin-bottom:4px;">\${b.date}</div>
                <div style="font-size:13px; margin-bottom:8px; white-space:pre-wrap; width:100%;">\${b.message}</div>
                <button class="btn-small btn-delete" onclick="deleteBoard(\${b.id})">削除</button>
              </div>
            \`).join('');
          });
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
      </script></body></html>
