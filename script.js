// ThreadlessCoin front-end logic
// This script powers the index.html page. It checks authentication, loads
// user state from Supabase, handles minting coins over time, and
// provides UI for creating and redeeming pass IDs. The site uses
// Supabase Auth and Database. You must create the tables
// `balances` (user_id: uuid, balance: numeric, last_generated: timestamptz),
// `passids` (id serial, user_id uuid, amount numeric, passid text, redeemed_by uuid, redeemed_at timestamptz)
// ahead of time in your Supabase project. Supply limits are handled
// client-side for demonstration but could be enforced via SQL triggers.

// Configure your Supabase project URL and anon key here. These are the same
// credentials used by the Threadless alpha prototype; replace with your
// own project values for production use.
const SUPABASE_URL = "https://ltxuqodtgzuculryimwe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0eHVxb2R0Z3p1Y3VscnlpbXdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0ODAxMDksImV4cCI6MjA3NDA1NjEwOX0.nxGsleK3F0lsypzXtZeDPsy2I2JP3uJBtBtd2s5LkEI";
// Create a dedicated client instance. Avoid shadowing the global `supabase` constructor.
const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// UI elements; will be populated later
const app = document.getElementById('app');
const userStatus = document.getElementById('userStatus');
const logoutBtn = document.getElementById('logoutBtn');
const themeSelect = document.getElementById('themeSelect');

// Persist and apply theme selection
const savedTheme = localStorage.getItem('threadlesscoin_theme') || 'forest';
document.documentElement.setAttribute('data-theme', savedTheme);
themeSelect.value = savedTheme;
themeSelect.addEventListener('change', () => {
  const t = themeSelect.value;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('threadlesscoin_theme', t);
});

// Check current session and render accordingly
async function init() {
  const { data: { session } } = await client.auth.getSession();
  if (!session) {
    // No user session; redirect to login page
    window.location.href = 'login.html';
    return;
  }
  const user = session.user;
  userStatus.textContent = user.email;
  logoutBtn.style.display = 'inline-block';
  logoutBtn.addEventListener('click', async () => {
    await client.auth.signOut();
    window.location.href = 'login.html';
  });
  // Ensure a row exists in balances table for this user
  const { data: balData, error: balErr } = await client
    .from('balances')
    .select('balance, last_generated')
    .eq('user_id', user.id)
    .single();
  let balance = 0;
  let lastGenerated = null;
  if (balErr && balErr.code === 'PGRST116') {
    // Row does not exist; create one with 0 balance
    await client.from('balances').insert({ user_id: user.id, balance: 0, last_generated: new Date().toISOString() });
    balance = 0;
    lastGenerated = new Date().toISOString();
  } else {
    balance = Number(balData?.balance || 0);
    lastGenerated = balData?.last_generated || new Date().toISOString();
  }
  renderApp(user, balance, lastGenerated);
  startMinting(user, balance, lastGenerated);
}

// Render the main application UI
function renderApp(user, balance, lastGenerated) {
  app.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'card';
  container.innerHTML = `
    <h2 style="margin-top:0;">Welcome, ${user.email}</h2>
    <p>Your current balance:</p>
    <h3 id="balanceDisplay" style="margin:6px 0 16px; font-size:26px;">${balance.toFixed(4)} ¢</h3>
    <p>Coins accumulate while this page is open. Every hour you earn <strong>0.1</strong> ThreadlessCoin.</p>
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

  // Hook up events
  document.getElementById('createPassBtn').addEventListener('click', async () => {
    const amount = parseFloat(document.getElementById('amountInput').value);
    const output = document.getElementById('passidOutput');
    output.style.display = 'none';
    if (isNaN(amount) || amount <= 0) {
      output.textContent = 'Please enter a positive amount.';
      output.style.display = 'block';
      return;
    }
    // Retrieve latest balance before converting
    const { data: balRow, error } = await client.from('balances').select('balance').eq('user_id', user.id).single();
    let currentBal = parseFloat(balRow?.balance || 0);
    if (currentBal < amount) {
      output.textContent = 'Insufficient balance.';
      output.style.display = 'block';
      return;
    }
    // Generate a random passid (32 hex chars)
    const passid = crypto.randomUUID().replace(/-/g, '');
    // Insert new passid and update balance in a transaction-like sequence
    const { error: insertErr } = await client.from('passids').insert({ user_id: user.id, amount, passid, redeemed_by: null, redeemed_at: null });
    if (insertErr) {
      output.textContent = insertErr.message || 'Failed to create passid.';
      output.style.display = 'block';
      return;
    }
    // Deduct from balance
    await client.from('balances').update({ balance: currentBal - amount }).eq('user_id', user.id);
    // Update UI
    document.getElementById('balanceDisplay').textContent = (currentBal - amount).toFixed(4) + ' ¢';
    output.textContent = `PassID created: ${passid}`;
    output.style.display = 'block';
    document.getElementById('amountInput').value = '';
  });

  document.getElementById('redeemBtn').addEventListener('click', async () => {
    const passidInput = document.getElementById('redeemInput');
    const messageEl = document.getElementById('redeemMessage');
    messageEl.style.display = 'none';
    const pid = passidInput.value.trim();
    if (!pid) return;
    // Fetch passid record
    const { data: rec, error } = await client.from('passids').select('*').eq('passid', pid).single();
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
    // Redeem: update passids row and credit coins
    const { error: updateErr } = await client.from('passids').update({ redeemed_by: user.id, redeemed_at: new Date().toISOString() }).eq('id', rec.id);
    if (updateErr) {
      messageEl.textContent = updateErr.message || 'Could not redeem passid.';
      messageEl.style.display = 'block';
      return;
    }
    // Credit balance
    // Fetch current balance then update
    const { data: balRow2 } = await client.from('balances').select('balance').eq('user_id', user.id).single();
    const userBal = parseFloat(balRow2?.balance || 0);
    const newBal = userBal + parseFloat(rec.amount);
    await client.from('balances').update({ balance: newBal }).eq('user_id', user.id);
    document.getElementById('balanceDisplay').textContent = newBal.toFixed(4) + ' ¢';
    messageEl.textContent = `Redeemed ${rec.amount.toFixed(4)} ¢ successfully!`;
    messageEl.style.display = 'block';
    passidInput.value = '';
  });
}

// Start minting coins periodically. This function keeps track of
// elapsed time and increments the user's balance in-memory, then
// persists it back to Supabase roughly once per minute. It also
// updates the on-screen balance display every second.
function startMinting(user, startingBalance, lastGenerated) {
  let currentBalance = startingBalance;
  let lastGen = new Date(lastGenerated).getTime();
  const coinsPerSecond = 0.1 / 3600;
  let accumulatedSeconds = 0;
  // Immediately catch up any gap between lastGenerated and now
  const now = Date.now();
  if (now > lastGen) {
    const elapsed = (now - lastGen) / 1000;
    const earned = elapsed * coinsPerSecond;
    currentBalance += earned;
    lastGen = now;
    // Persist initial catch-up
    client.from('balances').update({ balance: currentBalance, last_generated: new Date().toISOString() }).eq('user_id', user.id);
  }
  // Update UI
  document.getElementById('balanceDisplay').textContent = currentBalance.toFixed(4) + ' ¢';
  // Timer for continuous accrual
  setInterval(async () => {
    const now2 = Date.now();
    const delta = (now2 - lastGen) / 1000;
    lastGen = now2;
    const add = delta * coinsPerSecond;
    currentBalance += add;
    accumulatedSeconds += delta;
    // Update display
    const displayEl = document.getElementById('balanceDisplay');
    if (displayEl) displayEl.textContent = currentBalance.toFixed(4) + ' ¢';
    // Persist roughly once every minute
    if (accumulatedSeconds >= 60) {
      accumulatedSeconds = 0;
      await client.from('balances').update({ balance: currentBalance, last_generated: new Date().toISOString() }).eq('user_id', user.id);
    }
  }, 1000);
}

init();
