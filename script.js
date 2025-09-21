// ThreadlessCoin front-end logic (keeps your structure + mobile polish)
//
// Fixes:
//  - Uses window.supabase.createClient to avoid "Cannot access 'supabase' before initialization"
//  - 100 coins/hour rate (client displays continuously; server enforces via RPC)
//  - 1,000,000,000 hard cap on total supply (enforced in SQL function)
//  - Atomic PassID create/redeem via RPCs (single-use)
//
// Requires the SQL in supabase.sql to be run once in your Supabase project.

'use strict';

// ====== Supabase config (from your "future reference") ======
const SUPABASE_URL = "https://ltxuqodtgzuculryimwe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0eHVxb2R0Z3p1Y3VscnlpbXdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0ODAxMDksImV4cCI6MjA3NDA1NjEwOX0.nxGsleK3F0lsypzXtZeDPsy2I2JP3uJBtBtd2s5LkEI";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); // :contentReference[oaicite:5]{index=5}

// ====== UI refs ======
const app = document.getElementById('app');
const userStatus = document.getElementById('userStatus');
const logoutBtn = document.getElementById('logoutBtn');
const themeSelect = document.getElementById('themeSelect');

// ====== Theme persistence (kept) ======
const savedTheme = localStorage.getItem('threadlesscoin_theme') || 'forest';
document.documentElement.setAttribute('data-theme', savedTheme);
themeSelect.value = savedTheme;
themeSelect.addEventListener('change', () => {
  const t = themeSelect.value;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('threadlesscoin_theme', t);
});

// ====== Constants ======
const COINS_PER_HOUR = 100;
const COINS_PER_SECOND = COINS_PER_HOUR / 3600;

// ====== Boot ======
init();

async function init(){
  // Session or redirect
  const { data: { session } } = await sb.auth.getSession();
  if (!session){ location.href = 'login.html'; return; }

  const user = session.user;
  userStatus.textContent = user.email || 'online';
  logoutBtn.style.display = 'inline-block';
  logoutBtn.addEventListener('click', async () => { await sb.auth.signOut(); location.href = 'login.html'; });

  // Ensure balances row exists
  const { data: balRow, error: balErr } = await sb
    .from('balances')
    .select('balance,last_generated')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!balRow){
    await sb.from('balances').insert({ user_id: user.id, balance: 0, last_generated: new Date().toISOString() }).catch(()=>{});
  }

  // First server-side mint to catch up + cap check (RPC)
  // (RPC defined in supabase.sql)
  await safeMintRPC();

  // Load fresh state
  const { data: balRow2 } = await sb.from('balances').select('balance,last_generated').eq('user_id', user.id).single();
  const balance = Number(balRow2?.balance || 0);
  const lastGen = balRow2?.last_generated || new Date().toISOString();

  // Also load supply stats
  const { data: supply } = await sb.from('supply').select('minted, cap').single().catch(()=>({ data:null }));

  renderApp(user, balance, lastGen, supply);
  startMinting(user);
}

// ====== Render ======
function renderApp(user, balance, lastGenerated, supply){
  app.innerHTML = '';

  const wallet = document.createElement('div');
  wallet.className = 'card';
  wallet.innerHTML = `
    <h2 style="margin-top:0;">Welcome, ${user.email}</h2>
    <p>Your current balance:</p>
    <h3 id="balanceDisplay" style="margin:6px 0 16px; font-size:26px;">${Number(balance).toFixed(4)} ¢</h3>
    <p>Coins accumulate while this page is open. Every hour you earn <strong>${COINS_PER_HOUR.toLocaleString()}</strong> ThreadlessCoin.</p>

    <div class="row" style="margin-top:20px;">
      <div>
        <label for="amountInput">Amount to convert to PassID</label>
        <input id="amountInput" type="number" min="0" step="0.0001" placeholder="0.00" />
      </div>
      <button class="btn" id="createPassBtn">Create PassID</button>
    </div>
    <div id="passidOutput" class="passid" style="display:none;"></div>

    <hr style="margin:24px 0; border-color:var(--line);">

    <label for="redeemInput">Redeem a PassID</label>
    <input id="redeemInput" type="text" placeholder="Enter PassID" />
    <button class="btn" id="redeemBtn" style="margin-top:12px;">Redeem</button>
    <div id="redeemMessage" class="passid" style="display:none;"></div>
  `;

  const stats = document.createElement('div');
  stats.className = 'card';
  const minted = Number(supply?.minted ?? 0);
  const cap = Number(supply?.cap ?? 1000000000);
  stats.innerHTML = `
    <h2 style="margin-top:0;">Network</h2>
    <div class="row">
      <div style="flex:1">
        <div style="color:var(--muted);font-size:14px;">Total minted</div>
        <div id="mintedDisplay" style="font-size:18px;">${minted.toLocaleString(undefined,{maximumFractionDigits:4})} ¢</div>
      </div>
      <div style="flex:1">
        <div style="color:var(--muted);font-size:14px;">Max supply</div>
        <div id="capDisplay" style="font-size:18px;">${cap.toLocaleString()} ¢</div>
      </div>
    </div>
    <div id="capNotice" class="passid" style="display:${minted>=cap?'block':'none'}; margin-top:12px;">
      Max supply reached — minting paused.
    </div>
  `;

  app.append(wallet, stats);

  // Events
  document.getElementById('createPassBtn').addEventListener('click', onCreatePass);
  document.getElementById('redeemBtn').addEventListener('click', onRedeemPass);
}

// ====== Mint loop (UI smooth + periodic server RPC) ======
let mintTimer = null;
async function startMinting(user){
  if (mintTimer) clearInterval(mintTimer);

  // Pull last_generated once
  let { data: row } = await sb.from('balances').select('balance,last_generated').eq('user_id', user.id).single();
  let balance = Number(row?.balance || 0);
  let lastGen = new Date(row?.last_generated || new Date()).getTime();
  let secAccumulator = 0;

  // UI tick
  mintTimer = setInterval(async () => {
    const now = Date.now();
    const deltaSec = Math.max(0, (now - lastGen)/1000);
    lastGen = now;

    balance += deltaSec * COINS_PER_SECOND;
    secAccumulator += deltaSec;

    const bEl = document.getElementById('balanceDisplay');
    if (bEl) bEl.textContent = balance.toFixed(4) + ' ¢';

    // Every ~60s: persist via RPC (server clamps to cap, authoritative)  :contentReference[oaicite:6]{index=6}
    if (secAccumulator >= 60){
      secAccumulator = 0;
      const ok = await safeMintRPC();
      // Refresh canonical numbers after RPC
      const { data: fresh } = await sb.from('balances').select('balance,last_generated').eq('user_id', user.id).single();
      if (fresh){
        balance = Number(fresh.balance||0);
        lastGen = new Date(fresh.last_generated).getTime();
        const bEl2 = document.getElementById('balanceDisplay');
        if (bEl2) bEl2.textContent = balance.toFixed(4) + ' ¢';
      }
      if (ok){
        const { data: sup } = await sb.from('supply').select('minted,cap').single().catch(()=>({data:null}));
        const mEl = document.getElementById('mintedDisplay');
        const cEl = document.getElementById('capDisplay');
        if (sup && mEl && cEl){
          mEl.textContent = Number(sup.minted).toLocaleString(undefined,{maximumFractionDigits:4}) + ' ¢';
          cEl.textContent = Number(sup.cap).toLocaleString() + ' ¢';
          const notice = document.getElementById('capNotice');
          if (notice) notice.style.display = (Number(sup.minted) >= Number(sup.cap)) ? 'block':'none';
        }
      }
    }
  }, 1000);
}

async function safeMintRPC(){
  try{
    // No args: function determines user via auth.uid()
    const { error } = await sb.rpc('mint_coins'); // security definer function clamps to cap
    if (error) console.warn('mint_coins RPC', error);
    return !error;
  }catch(e){ console.warn('mint RPC failed', e); return false; }
}

// ====== PassID create/redeem (RPCs) ======
async function onCreatePass(){
  const output = document.getElementById('passidOutput');
  output.style.display = 'none';
  output.textContent = '';

  const amount = parseFloat(document.getElementById('amountInput').value);
  if (isNaN(amount) || amount <= 0){
    output.textContent = 'Please enter a positive amount.';
    output.style.display = 'block';
    return;
  }
  try{
    // create_passid(amount numeric) -> text passid
    const { data, error } = await sb.rpc('create_passid', { amount });
    if (error){ output.textContent = error.message || 'Failed to create passid.'; output.style.display='block'; return; }
    // Update local balance display
    const { data: fresh } = await sb.from('balances').select('balance').eq('user_id', (await sb.auth.getUser()).data.user.id).single();
    if (fresh){
      const bEl = document.getElementById('balanceDisplay');
      if (bEl) bEl.textContent = Number(fresh.balance).toFixed(4) + ' ¢';
    }
    output.textContent = `PassID created: ${data}`;
    output.style.display = 'block';
    document.getElementById('amountInput').value = '';
  }catch(e){
    output.textContent = 'Error: ' + (e?.message || 'unknown');
    output.style.display = 'block';
  }
}

async function onRedeemPass(){
  const messageEl = document.getElementById('redeemMessage');
  messageEl.style.display = 'none';
  messageEl.textContent = '';

  const pid = (document.getElementById('redeemInput').value || '').trim();
  if (!pid) return;

  try{
    // redeem_passid(passid text) -> numeric amount
    const { data, error } = await sb.rpc('redeem_passid', { passid: pid });
    if (error){ messageEl.textContent = error.message || 'Could not redeem passid.'; messageEl.style.display='block'; return; }

    // Refresh balance
    const { data: fresh } = await sb.from('balances').select('balance').eq('user_id', (await sb.auth.getUser()).data.user.id).single();
    if (fresh){
      const bEl = document.getElementById('balanceDisplay');
      if (bEl) bEl.textContent = Number(fresh.balance).toFixed(4) + ' ¢';
    }

    messageEl.textContent = `Redeemed ${Number(data).toFixed(4)} ¢ successfully!`;
    messageEl.style.display = 'block';
    document.getElementById('redeemInput').value = '';
  }catch(e){
    messageEl.textContent = 'Error: ' + (e?.message || 'unknown');
    messageEl.style.display = 'block';
  }
}
