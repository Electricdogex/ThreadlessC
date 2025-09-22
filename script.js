// ThreadlessCoin front-end logic
// - Fixes Supabase init (uses `sb` client)
// - Uses .maybeSingle() to avoid 406 on empty selects
// - Adds live "remaining supply" banner (TOTAL_SUPPLY - minted)
// - Keeps your original styling & mobile behavior

// ====== CONFIG ======
const SUPABASE_URL = "https://ltxuqodtgzuculryimwe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0eHVxb2R0Z3p1Y3VscnlpbXdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0ODAxMDksImV4cCI6MjA3NDA1NjEwOX0.nxGsleK3F0lsypzXtZeDPsy2I2JP3uJBtBtd2s5LkEI";

// Economics (your current plan)
const TOTAL_SUPPLY = 1_000_000_000;
const COINS_PER_HOUR = 100; // (was 0.1 before)
const COINS_PER_SECOND = COINS_PER_HOUR / 3600;

// ====== Supabase client ======
const { createClient } = window.supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sb = sb; // helpful for console debugging

// ====== UI refs ======
const app = document.getElementById('app');
const userStatus = document.getElementById('userStatus');
const logoutBtn = document.getElementById('logoutBtn');
const themeSelect = document.getElementById('themeSelect');
const supplyBanner = document.getElementById('supplyBanner');
const supplyRemainingEl = document.getElementById('supplyRemaining');
const supplyNoteEl = document.getElementById('supplyNote');

// Theme (persist like Threadless)
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

// ====== App boot ======
async function init() {
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
  let balance = 0;
  let lastGeneratedISO = new Date().toISOString();

  let { data: balData, error: balErr, status } = await sb
    .from('balances')
    .select('balance, last_generated')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!balData && !balErr) {
    // no row yet → create it
    await sb.from('balances').insert({ user_id: user.id, balance: 0, last_generated: lastGeneratedISO });
    balance = 0;
  } else if (balData) {
    balance = Number(balData.balance || 0);
    lastGeneratedISO = balData.last_generated || lastGeneratedISO;
  } else if (balErr) {
    console.warn('balances read error', balErr);
  }

  renderApp(user, balance);
  startMinting(user, balance, lastGeneratedISO);

  // Supply banner (best-effort if RLS allows global reads)
  try {
    supplyBanner.style.display = 'block';
    supplyNoteEl.style.display = 'block';
    await refreshSupply();
    setInterval(refreshSupply, 30000);
  } catch (e) {
    console.warn('supply view not available (RLS likely). Hide banner.', e);
    supplyBanner.style.display = 'none';
  }
}

// ====== Rendering ======
function renderApp(user, balance) {
  app.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'card';
  container.innerHTML = `
    <h2 style="margin-top:0;">Welcome, ${user.email}</h2>
    <p>Your current balance:</p>
    <h3 id="balanceDisplay" style="margin:6px 0 16px; font-size:26px;">${Number(balance).toFixed(4)} ¢</h3>
    <p>Coins accumulate while this page is open. Every hour you earn <strong>${COINS_PER_HOUR}</strong> ThreadlessCoin.</p>

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

    // Reload balance
    const { data: balRow } = await sb.from('balances').select('balance').eq('user_id', user.id).single();
    let currentBal = parseFloat(balRow?.balance || 0);
    if (currentBal < amount) {
      output.textContent = 'Insufficient balance.';
      output.style.display = 'block';
      return;
    }

    // Generate passid
    const passid = crypto.randomUUID().replace(/-/g, '');

    // Insert passid then deduct
    const { error: insErr } = await sb.from('passids').insert({
      user_id: user.id, amount, passid, redeemed_by: null, redeemed_at: null
    });
    if (insErr) {
      output.textContent = insErr.message || 'Failed to create passid.';
      output.style.display = 'block';
      return;
    }
    await sb.from('balances').update({ balance: currentBal - amount }).eq('user_id', user.id);

    document.getElementById('balanceDisplay').textContent = (currentBal - amount).toFixed(4) + ' ¢';
    output.textContent = `PassID created: ${passid}`;
    output.style.display = 'block';
    document.getElementById('amountInput').value = '';
  });

  // Redeem PassID (uses maybeSingle to avoid 406)
  document.getElementById('redeemBtn').addEventListener('click', async () => {
    const passidInput = document.getElementById('redeemInput');
    const messageEl = document.getElementById('redeemMessage');
    messageEl.style.display = 'none';
    const pid = passidInput.value.trim();
    if (!pid) return;

    const { data: rec, error } = await sb
      .from('passids')
      .select('id, user_id, amount, redeemed_by, redeemed_at')
      .eq('passid', pid)
      .maybeSingle();

    if (error) {
      messageEl.textContent = error.message || 'Could not check passid.';
      messageEl.style.display = 'block';
      return;
    }
    if (!rec) {
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

    const { error: updErr } = await sb
      .from('passids')
      .update({ redeemed_by: user.id, redeemed_at: new Date().toISOString() })
      .eq('id', rec.id);
    if (updErr) {
      messageEl.textContent = updErr.message || 'Could not redeem passid.';
      messageEl.style.display = 'block';
      return;
    }

    const { data: balRow2 } = await sb
      .from('balances')
      .select('balance')
      .eq('user_id', user.id)
      .single();

    const userBal = parseFloat(balRow2?.balance || 0);
    const newBal = userBal + parseFloat(rec.amount);
    await sb.from('balances').update({ balance: newBal }).eq('user_id', user.id);

    document.getElementById('balanceDisplay').textContent = newBal.toFixed(4) + ' ¢';
    messageEl.textContent = `Redeemed ${Number(rec.amount).toFixed(4)} ¢ successfully!`;
    messageEl.style.display = 'block';
    passidInput.value = '';
  });
}

// ====== Minting (client-side accrual) ======
function startMinting(user, startingBalance, lastGeneratedISO) {
  let currentBalance = Number(startingBalance || 0);
  let lastGenMs = new Date(lastGeneratedISO || Date.now()).getTime();
  let accumulate = 0;

  // Catch-up on page load
  const now = Date.now();
  if (now > lastGenMs) {
    const elapsed = (now - lastGenMs) / 1000;
    currentBalance += elapsed * COINS_PER_SECOND;
    lastGenMs = now;
    sb.from('balances').update({ balance: currentBalance, last_generated: new Date().toISOString() }).eq('user_id', user.id).catch(()=>{});
  }
  const display = document.getElementById('balanceDisplay');
  if (display) display.textContent = currentBalance.toFixed(4) + ' ¢';

  // Live accrual
  setInterval(async () => {
    const t = Date.now();
    const delta = (t - lastGenMs) / 1000;
    lastGenMs = t;
    const add = delta * COINS_PER_SECOND;
    currentBalance += add;
    accumulate += delta;

    const d = document.getElementById('balanceDisplay');
    if (d) d.textContent = currentBalance.toFixed(4) + ' ¢';

    if (accumulate >= 60) {
      accumulate = 0;
      await sb.from('balances').update({ balance: currentBalance, last_generated: new Date().toISOString() }).eq('user_id', user.id);
      // Optional: refresh supply after persistence
      refreshSupply().catch(()=>{});
    }
  }, 1000);
}

// ====== Supply banner ======
// We try to compute minted = SUM(all balances) + SUM(unredeemed passids)
// If RLS blocks global reads, banner hides itself.
async function refreshSupply() {
  if (!supplyBanner) return;

  // Try to fetch all rows in chunks (simple approach for small scale)
  async function fetchAll(table, columns, buildFilter) {
    const pageSize = 1000;
    let from = 0;
    let all = [];
    while (true) {
      let q = sb.from(table).select(columns).range(from, from + pageSize - 1);
      if (buildFilter) q = buildFilter(q);
      const { data, error } = await q;
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }

  // balances sum
  let sumBalances = 0;
  try {
    const rows = await fetchAll('balances', 'balance');
    sumBalances = rows.reduce((acc, r) => acc + Number(r.balance || 0), 0);
  } catch (e) {
    // Likely RLS — hide banner
    supplyBanner.style.display = 'none';
    throw e;
  }

  // unredeemed passids sum
  let sumUnredeemed = 0;
  try {
    const rows = await fetchAll('passids', 'amount, redeemed_by', (q) => q.is('redeemed_by', null));
    sumUnredeemed = rows.reduce((acc, r) => acc + Number(r.amount || 0), 0);
  } catch (e) {
    // If this fails but balances worked, still hide (incomplete picture)
    supplyBanner.style.display = 'none';
    throw e;
  }

  const minted = sumBalances + sumUnredeemed; // coins in balances + in codes
  const remaining = Math.max(0, TOTAL_SUPPLY - minted);
  supplyRemainingEl.textContent = `${Math.floor(remaining).toLocaleString()} / ${TOTAL_SUPPLY.toLocaleString()}`;
}

init();
