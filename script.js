/* ThreadlessCoin front-end logic (fixed for supabase-js v2)
   - Uses await (no .catch chaining on builders)
   - Uses .maybeSingle() where 0 rows are possible (prevents 406)
   - Avoids shadowing the global "supabase" by using "sb"
*/

'use strict';

// === CONFIG ===
const SUPABASE_URL = "https://ltxuqodtgzuculryimwe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0eHVxb2R0Z3p1Y3VscnlpbXdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0ODAxMDksImV4cCI6MjA3NDA1NjEwOX0.nxGsleK3F0lsypzXtZeDPsy2I2JP3uJBtBtd2s5LkEI";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Economics
const EARN_PER_HOUR = 100;             // 100 ThreadlessCoin per hour
const TOTAL_SUPPLY  = 1_000_000_000;   // total cap (not enforced here)
const COINS_PER_SEC = EARN_PER_HOUR / 3600;

// === DOM ===
const app        = document.getElementById('app');
const userStatus = document.getElementById('userStatus');
const logoutBtn  = document.getElementById('logoutBtn');
const themeSelect = document.getElementById('themeSelect');

// Theme persistence
const savedTheme = localStorage.getItem('threadlesscoin_theme') || 'forest';
document.documentElement.setAttribute('data-theme', savedTheme);
if (themeSelect){
  themeSelect.value = savedTheme;
  themeSelect.addEventListener('change', () => {
    const t = themeSelect.value;
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('threadlesscoin_theme', t);
  });
}

// === INIT ===
async function init(){
  const { data: { session } } = await sb.auth.getSession();
  if (!session){
    window.location.href = 'login.html';
    return;
  }
  const user = session.user;
  userStatus.textContent = user.email;
  logoutBtn.style.display = 'inline-block';
  logoutBtn.onclick = async () => { await sb.auth.signOut(); location.href = 'login.html'; };

  // Ensure balance row exists; .maybeSingle() avoids 406 when no row exists
  const { data: balRow, error: balErr } = await sb
    .from('balances')
    .select('balance, last_generated')
    .eq('user_id', user.id)
    .maybeSingle(); // returns null if none, no 406

  let balance = 0;
  let lastGenerated = new Date().toISOString();

  if (balErr){
    console.warn('balances select error:', balErr.message);
  }
  if (!balRow){
    const { error: insErr } = await sb.from('balances').insert({
      user_id: user.id, balance: 0, last_generated
    });
    if (insErr) console.error('balances insert error:', insErr.message);
  }else{
    balance = Number(balRow.balance || 0);
    lastGenerated = balRow.last_generated || lastGenerated;
  }

  renderApp(user, balance);
  startMinting(user, balance, lastGenerated);
}

// === RENDER ===
function renderApp(user, balance){
  app.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2 style="margin-top:0;">Welcome, ${user.email}</h2>
    <p>Your current balance:</p>
    <h3 id="balanceDisplay" style="margin:6px 0 16px;font-size:26px;">${balance.toFixed(4)} ¢</h3>

    <div class="row" style="margin-top:20px;">
      <div style="flex:1;">
        <label for="amountInput">Amount to convert to PassID</label>
        <input id="amountInput" type="number" min="0" step="0.0001" placeholder="0.00" />
      </div>
      <button class="btn" id="createPassBtn">Create PassID</button>
    </div>
    <div id="passidOutput" class="passid" style="display:none;"></div>

    <hr style="margin:24px 0;border-color:var(--line);">

    <label for="redeemInput">Redeem a PassID</label>
    <input id="redeemInput" type="text" placeholder="Enter PassID" />
    <button class="btn" id="redeemBtn" style="margin-top:12px;">Redeem</button>
    <div id="redeemMessage" class="passid" style="display:none;"></div>
  `;
  app.appendChild(card);

  // Events
  document.getElementById('createPassBtn').addEventListener('click', () => createPass(user));
  document.getElementById('redeemBtn').addEventListener('click', () => redeemPass(user));
}

// === PASSID CREATE / REDEEM ===
async function createPass(user){
  const out = document.getElementById('passidOutput');
  out.style.display = 'none';

  const amount = parseFloat(document.getElementById('amountInput').value);
  if (Number.isNaN(amount) || amount <= 0){
    out.textContent = 'Please enter a positive amount.';
    out.style.display = 'block';
    return;
  }

  // Recheck latest balance
  const { data: row, error } = await sb
    .from('balances')
    .select('balance')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error){ out.textContent = error.message || 'Could not read balance.'; out.style.display='block'; return; }

  const current = Number(row?.balance || 0);
  if (current < amount){
    out.textContent = 'Insufficient balance.';
    out.style.display = 'block';
    return;
  }

  const passid = crypto.randomUUID().replace(/-/g, '');

  const { error: insErr } = await sb.from('passids').insert({
    user_id: user.id, amount, passid, redeemed_by: null, redeemed_at: null
  });
  if (insErr){ out.textContent = insErr.message || 'Failed to create passid.'; out.style.display='block'; return; }

  const { error: updErr } = await sb
    .from('balances')
    .update({ balance: current - amount })
    .eq('user_id', user.id);
  if (updErr){ console.error('Deduct error:', updErr.message); }

  document.getElementById('balanceDisplay').textContent = (current - amount).toFixed(4) + ' ¢';
  out.textContent = `PassID created: ${passid}`;
  out.style.display = 'block';
  document.getElementById('amountInput').value = '';
}

async function redeemPass(user){
  const input = document.getElementById('redeemInput');
  const msg = document.getElementById('redeemMessage');
  msg.style.display = 'none';

  const pid = (input.value || '').trim();
  if (!pid) return;

  // Use maybeSingle() to avoid 406 when not found
  const { data: rec, error } = await sb
    .from('passids')
    .select('*')
    .eq('passid', pid)
    .maybeSingle();

  if (error || !rec){ msg.textContent = 'Invalid passid.'; msg.style.display='block'; return; }
  if (rec.redeemed_by){ msg.textContent = 'This passid has already been redeemed.'; msg.style.display='block'; return; }
  if (rec.user_id === user.id){ msg.textContent = 'You cannot redeem your own passid.'; msg.style.display='block'; return; }

  const { error: markErr } = await sb
    .from('passids')
    .update({ redeemed_by: user.id, redeemed_at: new Date().toISOString() })
    .eq('id', rec.id);
  if (markErr){ msg.textContent = markErr.message || 'Could not redeem passid.'; msg.style.display='block'; return; }

  const { data: b } = await sb
    .from('balances')
    .select('balance')
    .eq('user_id', user.id)
    .maybeSingle();

  const newBal = Number(b?.balance || 0) + Number(rec.amount);
  const { error: creditErr } = await sb
    .from('balances')
    .update({ balance: newBal })
    .eq('user_id', user.id);
  if (creditErr){ console.error('Credit error:', creditErr.message); }

  document.getElementById('balanceDisplay').textContent = newBal.toFixed(4) + ' ¢';
  msg.textContent = `Redeemed ${Number(rec.amount).toFixed(4)} ¢ successfully!`;
  msg.style.display = 'block';
  input.value = '';
}

// === MINTING LOOP ===
function startMinting(user, startingBalance, lastGeneratedISO){
  let currentBalance = Number(startingBalance || 0);
  let lastGen = new Date(lastGeneratedISO).getTime();
  let accSecs = 0;

  // Catch up immediately
  const now = Date.now();
  if (now > lastGen){
    const earned = ((now - lastGen) / 1000) * COINS_PER_SEC;
    currentBalance += earned;
    lastGen = now;
    // persist catch-up
    (async () => {
      const { error } = await sb
        .from('balances')
        .update({ balance: currentBalance, last_generated: new Date().toISOString() })
        .eq('user_id', user.id);
      if (error) console.error('Persist catch-up error:', error.message);
    })();
  }
  const show = () => {
    const el = document.getElementById('balanceDisplay');
    if (el) el.textContent = currentBalance.toFixed(4) + ' ¢';
  };
  show();

  // Tick every second
  setInterval(async () => {
    const now2 = Date.now();
    const delta = (now2 - lastGen) / 1000;
    lastGen = now2;

    currentBalance += delta * COINS_PER_SEC;
    accSecs += delta;
    show();

    if (accSecs >= 60){
      accSecs = 0;
      const { error } = await sb
        .from('balances')
        .update({ balance: currentBalance, last_generated: new Date().toISOString() })
        .eq('user_id', user.id);
      if (error) console.error('Persist tick error:', error.message);
    }
  }, 1000);
}

init();
