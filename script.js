// ThreadlessCoin front-end logic (with global supply counter)
//
// Tables expected:
//   balances(user_id uuid pk/fk, balance numeric, last_generated timestamptz)
//   passids(id bigserial pk, user_id uuid, amount numeric, passid text unique,
//           redeemed_by uuid null, redeemed_at timestamptz null)
//
// RPC function expected (from SQL step):
//   get_supply_stats() -> totals for minted & remaining.

// ======= CONFIG (use your project values) =======
const SUPABASE_URL = "https://ltxuqodtgzuculryimwe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0eHVxb2R0Z3p1Y3VscnlpbXdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0ODAxMDksImV4cCI6MjA3NDA1NjEwOX0.nxGsleK3F0lsypzXtZeDPsy2I2JP3uJBtBtd2s5LkEI";
const TOTAL_SUPPLY = 1_000_000_000;            // 1B max
const RATE_PER_HOUR = 100;                      // 100 coins/hour per active browser
// ================================================

const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// UI refs
const mainWrap = document.querySelector('main.wrap');
const app = document.getElementById('app');
const userStatus = document.getElementById('userStatus');
const logoutBtn = document.getElementById('logoutBtn');
const themeSelect = document.getElementById('themeSelect');
const supplyBar = document.getElementById('supplyBar');
const remainingSupplyEl = document.getElementById('remainingSupply');
const totalSupplyEl = document.getElementById('totalSupply');
const progressEl = document.getElementById('supplyProgress');
const mintedBlurbEl = document.getElementById('mintedBlurb');

// Theme persistence
const savedTheme = localStorage.getItem('threadlesscoin_theme') || 'forest';
document.documentElement.setAttribute('data-theme', savedTheme);
themeSelect.value = savedTheme;
themeSelect.addEventListener('change', () => {
  const t = themeSelect.value;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('threadlesscoin_theme', t);
});

// Number formatting
const fmtInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmt4 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

// ======= APP BOOT =======
init();

async function init(){
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return;
  }
  const user = session.user;
  userStatus.textContent = user.email;
  logoutBtn.style.display = 'inline-block';
  logoutBtn.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = 'login.html';
  });

  // Ensure balance row exists
  const { data: balData, error: balErr, status } = await supabase
    .from('balances').select('balance, last_generated').eq('user_id', user.id).maybeSingle();

  let balance = 0;
  let lastGenerated = new Date().toISOString();

  if (!balData) {
    await supabase.from('balances').insert({ user_id: user.id, balance: 0, last_generated: lastGenerated });
  } else {
    balance = Number(balData.balance || 0);
    lastGenerated = balData.last_generated || lastGenerated;
  }

  // Draw supply counter (shows above the welcome card)
  totalSupplyEl.textContent = fmtInt.format(TOTAL_SUPPLY);
  supplyBar.style.display = 'block';
  startSupplyPolling(); // live updates

  // Render main UI & start minting
  renderApp(user, balance, lastGenerated);
  startMinting(user, balance, lastGenerated);
}

// ======= SUPPLY BAR =======
async function fetchSupplyStats(){
  // Prefer RPC (single round-trip). If you ever change total supply, update SQL + TOTAL_SUPPLY constant.
  const { data, error } = await supabase.rpc('get_supply_stats');
  if (error) throw error;

  // Function may return an array rowset or an object depending on SQL; normalize:
  const row = Array.isArray(data) ? data[0] : data;
  return {
    total: Number(row.total_supply ?? TOTAL_SUPPLY),
    minted: Number(row.minted_total ?? 0),
    remaining: Number(row.remaining ?? Math.max(TOTAL_SUPPLY - Number(row.minted_total ?? 0), 0)),
    inBalances: Number(row.balances_total ?? 0),
    inUnredeemedPassids: Number(row.passids_unredeemed ?? 0),
  };
}

async function updateSupplyBar(){
  try{
    const s = await fetchSupplyStats();
    remainingSupplyEl.textContent = fmtInt.format(Math.max(Math.floor(s.remaining), 0));
    const pctMinted = Math.min(100, (s.minted / s.total) * 100);
    progressEl.style.width = `${pctMinted}%`;
    mintedBlurbEl.textContent = `Minted so far: ${fmtInt.format(Math.floor(s.minted))} (balances: ${fmtInt.format(Math.floor(s.inBalances))} · unredeemed PassIDs: ${fmtInt.format(Math.floor(s.inUnredeemedPassids))})`;
  }catch(e){
    // keep the bar but show a soft error
    mintedBlurbEl.textContent = 'Supply stats currently unavailable.';
  }
}

function startSupplyPolling(){
  updateSupplyBar();
  // Poll every 15s; you could also listen to realtime `postgres_changes` on balances/passids.
  setInterval(updateSupplyBar, 15000);
  // (Realtime is also supported by Supabase if you prefer push updates.) :contentReference[oaicite:3]{index=3}
}

// ======= MAIN APP (welcome card, passid create/redeem) =======
function renderApp(user, balance, lastGenerated){
  app.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'card';
  container.innerHTML = `
    <h2 style="margin-top:0;">Welcome, ${user.email}</h2>
    <p>Your current balance:</p>
    <h3 id="balanceDisplay" style="margin:6px 0 16px; font-size:26px;">${fmt4.format(balance)} ¢</h3>
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

  document.getElementById('createPassBtn').addEventListener('click', async () => {
    const amount = parseFloat(document.getElementById('amountInput').value);
    const output = document.getElementById('passidOutput');
    output.style.display = 'none';
    if (isNaN(amount) || amount <= 0) {
      output.textContent = 'Please enter a positive amount.';
      output.style.display = 'block';
      return;
    }
    const { data: balRow } = await supabase.from('balances').select('balance').eq('user_id', user.id).single();
    const currentBal = parseFloat(balRow?.balance || 0);
    if (currentBal < amount) {
      output.textContent = 'Insufficient balance.';
      output.style.display = 'block';
      return;
    }
    const passid = crypto.randomUUID().replace(/-/g, '');
    const { error: insertErr } = await supabase.from('passids').insert({
      user_id: user.id, amount, passid, redeemed_by: null, redeemed_at: null
    });
    if (insertErr) {
      output.textContent = insertErr.message || 'Failed to create passid.';
      output.style.display = 'block';
      return;
    }
    await supabase.from('balances').update({ balance: currentBal - amount }).eq('user_id', user.id);
    document.getElementById('balanceDisplay').textContent = fmt4.format(currentBal - amount) + ' ¢';
    output.textContent = `PassID created: ${passid}`;
    output.style.display = 'block';
    document.getElementById('amountInput').value = '';

    // refresh supply (unredeemed pool increased, balances decreased)
    updateSupplyBar();
  });

  document.getElementById('redeemBtn').addEventListener('click', async () => {
    const passidInput = document.getElementById('redeemInput');
    const messageEl = document.getElementById('redeemMessage');
    messageEl.style.display = 'none';
    const pid = passidInput.value.trim();
    if (!pid) return;

    const { data: rec, error } = await supabase.from('passids').select('*').eq('passid', pid).single();
    if (error || !rec) {
      messageEl.textContent = 'Invalid passid.';
      messageEl.style.display = 'block';
      return;
    }
    if (rec.redeemed_by) {
      messageEl.textContent = 'This passid has already been redeemed.';
      messageEl.style.display = 'block';
      return;
    }
    if (rec.user_id === user.id) {
      messageEl.textContent = 'You cannot redeem your own passid.';
      messageEl.style.display = 'block';
      return;
    }

    const { error: updateErr } = await supabase.from('passids')
      .update({ redeemed_by: user.id, redeemed_at: new Date().toISOString() })
      .eq('id', rec.id);
    if (updateErr) {
      messageEl.textContent = updateErr.message || 'Could not redeem passid.';
      messageEl.style.display = 'block';
      return;
    }

    const { data: balRow2 } = await supabase.from('balances').select('balance').eq('user_id', user.id).single();
    const userBal = parseFloat(balRow2?.balance || 0);
    const newBal = userBal + parseFloat(rec.amount);
    await supabase.from('balances').update({ balance: newBal }).eq('user_id', user.id);
    document.getElementById('balanceDisplay').textContent = fmt4.format(newBal) + ' ¢';
    messageEl.textContent = `Redeemed ${fmt4.format(rec.amount)} ¢ successfully!`;
    messageEl.style.display = 'block';
    passidInput.value = '';

    // refresh supply (unredeemed pool shrank, balances rose; minted stays same)
    updateSupplyBar();
  });
}

// ======= MINTING LOOP =======
function startMinting(user, startingBalance, lastGeneratedIso){
  let currentBalance = startingBalance;
  let lastTs = new Date(lastGeneratedIso).getTime();
  const coinsPerSecond = RATE_PER_HOUR / 3600;
  let bucket = 0;

  // Catch up from last_generated
  const now = Date.now();
  if (now > lastTs) {
    const elapsed = (now - lastTs) / 1000;
    currentBalance += elapsed * coinsPerSecond;
    lastTs = now;
    supabase.from('balances')
      .update({ balance: currentBalance, last_generated: new Date().toISOString() })
      .eq('user_id', user.id);
  }
  document.getElementById('balanceDisplay').textContent = fmt4.format(currentBalance) + ' ¢';

  setInterval(async () => {
    const t = Date.now();
    const delta = (t - lastTs) / 1000;
    lastTs = t;
    currentBalance += delta * coinsPerSecond;
    bucket += delta;

    const displayEl = document.getElementById('balanceDisplay');
    if (displayEl) displayEl.textContent = fmt4.format(currentBalance) + ' ¢';

    // Persist ~ every minute
    if (bucket >= 60) {
      bucket = 0;
      await supabase.from('balances')
        .update({ balance: currentBalance, last_generated: new Date().toISOString() })
        .eq('user_id', user.id);

      // Minting increases total minted; update supply bar occasionally
      updateSupplyBar();
    }
  }, 1000);
}
