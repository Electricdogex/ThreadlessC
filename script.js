// ThreadlessCoin front-end
// - Fixes 'Cannot access supabase before initialization' by using `window.supabase`
// - Handles 'no rows' (PGRST116) without killing the UI
// - Mobile-friendly UI like Threadless
// - Rate: 100 coins/hour; Max supply (display): 1,000,000,000

// --- Supabase client (CDN) ---
const SUPABASE_URL = "https://ltxuqodtgzuculryimwe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0eHVxb2R0Z3p1Y3VscnlpbXdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0ODAxMDksImV4cCI6MjA3NDA1NjEwOX0.nxGsleK3F0lsypzXtZeDPsy2I2JP3uJBtBtd2s5LkEI";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); // per docs :contentReference[oaicite:7]{index=7}

// --- DOM refs ---
const app = document.getElementById('app');
const userStatus = document.getElementById('userStatus');
const logoutBtn = document.getElementById('logoutBtn');
const themeSelect = document.getElementById('themeSelect');

// Theme
const savedTheme = localStorage.getItem('threadlesscoin_theme') || 'forest';
document.documentElement.setAttribute('data-theme', savedTheme);
themeSelect.value = savedTheme;
themeSelect.addEventListener('change', () => {
  const t = themeSelect.value;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('threadlesscoin_theme', t);
});

// Utility: show inline error at top of app
function showInlineError(msg){
  let b = document.getElementById('tc_err');
  if (!b){
    b = document.createElement('div');
    b.id = 'tc_err';
    b.style.cssText = 'margin:12px 0;padding:10px;border:1px solid var(--line);background:color-mix(in srgb,var(--bg) 90%,black 10%);border-radius:10px;color:var(--warn);font-size:13px';
    app.prepend(b);
  }
  b.textContent = msg;
}

// Init
window.addEventListener('DOMContentLoaded', init);

async function init(){
  try{
    const { data: { session } } = await sb.auth.getSession();
    if (!session){
      location.href = 'login.html';
      return;
    }
    const user = session.user;
    userStatus.textContent = user.email || 'signed in';
    logoutBtn.style.display = 'inline-block';
    logoutBtn.onclick = async () => { await sb.auth.signOut(); location.href = 'login.html'; };

    // Ensure balance row exists (avoid PGRST116 empty-row failure) :contentReference[oaicite:8]{index=8}
    const { data: balRow, error: selErr } = await sb
      .from('balances')
      .select('balance,last_generated')
      .eq('user_id', user.id)
      .maybeSingle(); // returns null if none (no error)

    let balance = 0;
    let lastGenerated = new Date().toISOString();

    if (!balRow){
      // create a fresh row
      const { error: insErr } = await sb.from('balances').insert({
        user_id: user.id, balance: 0, last_generated: lastGenerated
      });
      if (insErr){ showInlineError('Could not initialize your balance. Check RLS policies.'); }
    } else {
      balance = parseFloat(balRow.balance || 0) || 0;
      lastGenerated = balRow.last_generated || lastGenerated;
    }

    renderApp(user, balance);
    startMinting(user, balance, lastGenerated);
  } catch(err){
    showInlineError('App failed to start: ' + (err?.message || String(err)));
    console.error(err);
  }
}

function renderApp(user, balance){
  app.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2 style="margin:0 0 4px">Welcome, ${user.email}</h2>
    <div class="hint">Supply cap: 1,000,000,000 · Rate: <strong>100</strong> coins/hour while this tab is open.</div>

    <p style="margin-top:14px">Your current balance:</p>
    <h3 id="balanceDisplay" style="margin:6px 0 16px;font-size:26px">${balance.toFixed(4)} ¢</h3>

    <div class="row" style="margin-top:16px">
      <div>
        <label for="amountInput" class="hint">Convert amount to PassID</label>
        <input id="amountInput" type="number" min="0" step="0.0001" placeholder="0.00" />
      </div>
      <button class="btn" id="createPassBtn">Create PassID</button>
    </div>
    <div id="passidOutput" class="passid" style="display:none"></div>

    <hr style="margin:24px 0;border-color:var(--line)">

    <label for="redeemInput" class="hint">Redeem a PassID</label>
    <input id="redeemInput" type="text" placeholder="Enter PassID" />
    <button class="btn" id="redeemBtn" style="margin-top:12px">Redeem</button>
    <div id="redeemMessage" class="passid" style="display:none"></div>
  `;
  app.appendChild(card);

  // events
  document.getElementById('createPassBtn').addEventListener('click', () => createPass(user));
  document.getElementById('redeemBtn').addEventListener('click', () => redeemPass(user));
}

// Generate long Base64url PassID
function genPassId(){
  // Use crypto APIs (supported widely) :contentReference[oaicite:9]{index=9}
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let b64 = btoa(String.fromCharCode(...bytes));
  // Base64url
  b64 = b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  // add uuid for extra length/uniqueness
  return b64 + '_' + crypto.randomUUID().replace(/-/g,'');
}

async function createPass(user){
  const amount = parseFloat(document.getElementById('amountInput').value);
  const out = document.getElementById('passidOutput');
  out.style.display = 'none';

  if (isNaN(amount) || amount <= 0){ out.textContent = 'Enter a positive amount.'; out.style.display='block'; return; }

  // check latest balance
  const { data: b } = await sb.from('balances').select('balance').eq('user_id', user.id).maybeSingle();
  const cur = parseFloat(b?.balance || 0) || 0;
  if (cur < amount){ out.textContent = 'Insufficient balance.'; out.style.display='block'; return; }

  const passid = genPassId();
  const { error: insErr } = await sb.from('passids').insert({ user_id: user.id, amount, passid, redeemed_by: null, redeemed_at: null });
  if (insErr){ out.textContent = insErr.message || 'Failed to create passid.'; out.style.display='block'; return; }

  await sb.from('balances').update({ balance: cur - amount }).eq('user_id', user.id);
  document.getElementById('balanceDisplay').textContent = (cur - amount).toFixed(4) + ' ¢';

  out.textContent = `PassID created: ${passid}`;
  out.style.display = 'block';
  document.getElementById('amountInput').value = '';
}

async function redeemPass(user){
  const pid = document.getElementById('redeemInput').value.trim();
  const msg = document.getElementById('redeemMessage');
  msg.style.display = 'none';
  if (!pid){ return; }

  const { data: rec, error } = await sb.from('passids').select('*').eq('passid', pid).maybeSingle();
  if (error || !rec){ msg.textContent = 'Invalid PassID.'; msg.style.display='block'; return; }
  if (rec.redeemed_by){ msg.textContent = 'This PassID has already been redeemed.'; msg.style.display='block'; return; }
  if (rec.user_id === (await sb.auth.getUser()).data.user.id){ msg.textContent = 'You cannot redeem your own PassID.'; msg.style.display='block'; return; }

  const { error: updErr } = await sb.from('passids')
    .update({ redeemed_by: (await sb.auth.getUser()).data.user.id, redeemed_at: new Date().toISOString() })
    .eq('id', rec.id);
  if (updErr){ msg.textContent = updErr.message || 'Redeem failed.'; msg.style.display='block'; return; }

  const { data: bal } = await sb.from('balances').select('balance').eq('user_id', (await sb.auth.getUser()).data.user.id).maybeSingle();
  const newBal = (parseFloat(bal?.balance || 0) || 0) + parseFloat(rec.amount || 0);
  await sb.from('balances').update({ balance: newBal }).eq('user_id', (await sb.auth.getUser()).data.user.id);
  document.getElementById('balanceDisplay').textContent = newBal.toFixed(4) + ' ¢';

  msg.textContent = `Redeemed ${Number(rec.amount).toFixed(4)} ¢ successfully!`;
  msg.style.display = 'block';
  document.getElementById('redeemInput').value = '';
}

// Minting: 100 coins/hour
function startMinting(user, startBalance, lastGeneratedIso){
  let bal = startBalance;
  let last = new Date(lastGeneratedIso).getTime();
  const perSec = 100 / 3600; // coins per second

  // catch-up
  const now = Date.now();
  if (now > last){
    const earned = (now - last) / 1000 * perSec;
    bal += earned;
    last = now;
    sb.from('balances').update({ balance: bal, last_generated: new Date().toISOString() }).eq('user_id', user.id);
  }
  const disp = document.getElementById('balanceDisplay');
  disp.textContent = bal.toFixed(4) + ' ¢';

  let acc = 0;
  setInterval(async ()=>{
    const t = Date.now();
    const delta = (t - last) / 1000;
    last = t;
    bal += delta * perSec;
    acc += delta;

    disp.textContent = bal.toFixed(4) + ' ¢';

    if (acc >= 60){
      acc = 0;
      await sb.from('balances').update({ balance: bal, last_generated: new Date().toISOString() }).eq('user_id', user.id);
    }
  }, 1000);
}
