// ThreadlessCoin front-end logic
// - Fixes TDZ bug by using `window.supabase.createClient(...)` (stored as `sb`)
// - Rate: 100 coins/hour; Max supply: 1,000,000,000
// - Adds a live "remaining supply" counter above the app card
//
// Tables expected:
//   balances(user_id uuid pk, balance numeric, last_generated timestamptz)
//   passids(id serial pk, user_id uuid, amount numeric, passid text unique, redeemed_by uuid, redeemed_at timestamptz)

const SUPABASE_URL = "https://ltxuqodtgzuculryimwe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0eHVxb2R0Z3p1Y3VscnlpbXdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0ODAxMDksImV4cCI6MjA3NDA1NjEwOX0.nxGsleK3F0lsypzXtZeDPsy2I2JP3uJBtBtd2s5LkEI";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Config
const RATE_PER_HOUR = 100;                 // coins per hour
const MAX_SUPPLY = 1_000_000_000;          // total cap
const COINS_PER_SECOND = RATE_PER_HOUR / 3600;

const app = document.getElementById('app');
const userStatus = document.getElementById('userStatus');
const logoutBtn = document.getElementById('logoutBtn');
const themeSelect = document.getElementById('themeSelect');

// Apply saved theme
const savedTheme = localStorage.getItem('threadlesscoin_theme') || 'forest';
document.documentElement.setAttribute('data-theme', savedTheme);
if (themeSelect) {
  themeSelect.value = savedTheme;
  themeSelect.addEventListener('change', () => {
    const t = themeSelect.value;
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('threadlesscoin_theme', t);
  });
}

// Boot
init();

async function init() {
  if (!window.supabase) {
    app.innerHTML = `<div class="card">Supabase failed to load. Check the CDN script tag.</div>`;
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return;
  }

  const user = session.user;
  userStatus.textContent = user.email;
  logoutBtn.style.display = 'inline-block';
  logoutBtn.addEventListener('click', async () => {
    await sb.auth.signOut();
    window.location.href = 'login.html';
  });

  // Ensure balances row exists
  const { data: balData, error: balErr } = await sb
    .from('balances')
    .select('balance, last_generated')
    .eq('user_id', user.id)
    .maybeSingle();

  let balance = 0;
  let lastGenerated = new Date().toISOString();

  if (!balData) {
    await sb.from('balances').insert({ user_id: user.id, balance: 0, last_generated: lastGenerated });
  } else {
    balance = Number(balData.balance || 0);
    lastGenerated = balData.last_generated || lastGenerated;
  }

  renderAppShell();                  // supply bar container + app container
  renderApp(user, balance, lastGenerated);
  startMinting(user, balance, lastGenerated);
  startSupplyTicker();               // live remaining supply
}

// Renders a fixed “supply bar” spot + clears app
function renderAppShell(){
  app.innerHTML = '';
  const supplyCard = document.createElement('div');
  supplyCard.className = 'card';
  supplyCard.id = 'supplyCard';
  supplyCard.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
      <div><strong>Remaining supply</strong></div>
      <div id="supplyRemaining" style="font-weight:800; font-size:18px;">calculating…</div>
    </div>
    <div style="margin-top:6px; color:var(--muted); font-size:12px;">Max: ${MAX_SUPPLY.toLocaleString()}</div>
  `;
  app.appendChild(supplyCard);
}

// Main UI
function renderApp(user, balance, lastGenerated) {
  const container = document.createElement('div');
  container.className = 'card';
  container.innerHTML = `
    <h2 style="margin-top:0;">Welcome, ${user.email}</h2>
    <p>Your current balance:</p>
    <h3 id="balanceDisplay" style="margin:6px 0 16px; font-size:26px;">${balance.toFixed(4)} ¢</h3>
    <p>Coins accumulate while this page is open. Every hour you earn <strong>${RATE_PER_HOUR}</strong> ThreadlessCoin.</p>

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
  app.appendChild(container);

  // Create PassID
  document.getElementById('createPassBtn').addEventListener('click', async () => {
    const amount = parseFloat(document.getElementById('amountInput').value);
    const output = document.getElementById('passidOutput');
    output.style.display = 'none';
    if (isNaN(amount) || amount <= 0) {
      output.textContent = 'Please enter a positive amount.';
      output.style.display = 'block';
      return;
    }
    // Get latest balance
    const { data: balRow } = await sb.from('balances').select('balance').eq('user_id', user.id).single();
    let currentBal = parseFloat(balRow?.balance || 0);
    if (currentBal < amount) {
      output.textContent = 'Insufficient balance.';
      output.style.display = 'block';
      return;
    }
    // Generate a long passid (uuid without dashes + random 16 hex)
    const passid = (crypto.randomUUID().replace(/-/g, '') + [...crypto.getRandomValues(new Uint8Array(8))].map(b=>b.toString(16).padStart(2,'0')).join(''));
    // Insert pass and deduct
    const { error: insertErr } = await sb.from('passids').insert({ user_id: user.id, amount, passid, redeemed_by: null, redeemed_at: null });
    if (insertErr) {
      output.textContent = insertErr.message || 'Failed to create passid.';
      output.style.display = 'block';
      return;
    }
    await sb.from('balances').update({ balance: currentBal - amount }).eq('user_id', user.id);
    document.getElementById('balanceDisplay').textContent = (currentBal - amount).toFixed(4) + ' ¢';
    output.textContent = `PassID created: ${passid}`;
    output.style.display = 'block';
    document.getElementById('amountInput').value = '';
    // Refresh supply after creating an unredeemed pass
    refreshSupplyOnce();
  });

  // Redeem PassID
  document.getElementById('redeemBtn').addEventListener('click', async () => {
    const passidInput = document.getElementById('redeemInput');
    const messageEl = document.getElementById('redeemMessage');
    messageEl.style.display = 'none';
    const pid = passidInput.value.trim();
    if (!pid) return;

    const { data: rec, error } = await sb.from('passids').select('*').eq('passid', pid).single();
    if (error || !rec) {
      messageEl.textContent = 'Invalid passid.';
      messageEl.style.display = 'block';
      return;
    }
    const { data: { session } } = await sb.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) { location.href = 'login.html'; return; }
    if (rec.redeemed_by) {
      messageEl.textContent = 'This passid has already been redeemed.';
      messageEl.style.display = 'block';
      return;
    }
    if (rec.user_id === userId) {
      messageEl.textContent = 'You cannot redeem your own passid.';
      messageEl.style.display = 'block';
      return;
    }
    const { error: updateErr } = await sb.from('passids').update({ redeemed_by: userId, redeemed_at: new Date().toISOString() }).eq('id', rec.id);
    if (updateErr) {
      messageEl.textContent = updateErr.message || 'Could not redeem passid.';
      messageEl.style.display = 'block';
      return;
    }
    const { data: balRow2 } = await sb.from('balances').select('balance').eq('user_id', userId).single();
    const userBal = parseFloat(balRow2?.balance || 0);
    const newBal = userBal + parseFloat(rec.amount);
    await sb.from('balances').update({ balance: newBal }).eq('user_id', userId);
    document.getElementById('balanceDisplay').textContent = newBal.toFixed(4) + ' ¢';
    messageEl.textContent = `Redeemed ${Number(rec.amount).toFixed(4)} ¢ successfully!`;
    messageEl.style.display = 'block';
    passidInput.value = '';
    // Refresh supply after moving funds out of unredeemed pool
    refreshSupplyOnce();
  });
}

// Continuous minting (client-timed)
function startMinting(user, startingBalance, lastGenerated) {
  let currentBalance = startingBalance;
  let lastGen = new Date(lastGenerated).getTime();
  let accumulatedSeconds = 0;

  // Catch up from lastGenerated -> now
  const now = Date.now();
  if (now > lastGen) {
    const elapsed = (now - lastGen) / 1000;
    currentBalance += elapsed * COINS_PER_SECOND;
    lastGen = now;
    sb.from('balances').update({ balance: currentBalance, last_generated: new Date().toISOString() }).eq('user_id', user.id);
  }
  const displayEl = document.getElementById('balanceDisplay');
  if (displayEl) displayEl.textContent = currentBalance.toFixed(4) + ' ¢';

  setInterval(async () => {
    const now2 = Date.now();
    const delta = (now2 - lastGen) / 1000;
    lastGen = now2;
    currentBalance += delta * COINS_PER_SECOND;
    accumulatedSeconds += delta;

    const d = document.getElementById('balanceDisplay');
    if (d) d.textContent = currentBalance.toFixed(4) + ' ¢';

    if (accumulatedSeconds >= 60) {
      accumulatedSeconds = 0;
      await sb.from('balances').update({ balance: currentBalance, last_generated: new Date().toISOString() }).eq('user_id', user.id);
      // Minting increases total supply; reflect it
      refreshSupplyOnce();
    }
  }, 1000);
}

/** Supply counter (simple client-side aggregation; fine for MVP) **/
async function calcMintedApprox(){
  // Sum balances (paged)
  let minted = 0;
  let from = 0;
  const size = 1000;
  while (true) {
    const { data, error } = await sb.from('balances').select('balance').range(from, from + size - 1);
    if (error) break;
    for (const r of (data || [])) minted += Number(r.balance || 0);
    if (!data || data.length < size) break;
    from += size;
  }
  // Add unredeemed passids (they’re out of balances temporarily)
  from = 0;
  while (true) {
    const { data, error } = await sb.from('passids').select('amount, redeemed_by').is('redeemed_by', null).range(from, from + size - 1);
    if (error) break;
    for (const r of (data || [])) minted += Number(r.amount || 0);
    if (!data || data.length < size) break;
    from += size;
  }
  return minted;
}

async function refreshSupplyOnce(){
  const el = document.getElementById('supplyRemaining');
  if (!el) return;
  el.textContent = 'calculating…';
  const minted = await calcMintedApprox();
  const remaining = Math.max(0, MAX_SUPPLY - minted);
  el.textContent = `${remaining.toLocaleString(undefined,{maximumFractionDigits:4})}`;
}

function startSupplyTicker(){
  refreshSupplyOnce();
  // Refresh every 30s
  setInterval(refreshSupplyOnce, 30000);
}
