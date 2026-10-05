(() => {
  const config = window.PRHSupabaseConfig || {};
  const setupMessage = document.getElementById('adminSetupMessage');
  const isConfigured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.url || '')
    && !!config.anonKey
    && !/YOUR_|REPLACE_ME/i.test(config.anonKey);

  if (!isConfigured || !window.supabase?.createClient) {
    setupMessage.hidden = false;
    setupMessage.textContent = !isConfigured
      ? 'Add your Supabase project URL and anon key to supabase-config.js, then run supabase/schema.sql in the Supabase SQL Editor.'
      : 'Supabase client failed to load. Check your connection and reload this page.';
    document.getElementById('adminLoginPanel').hidden = true;
    return;
  }

  const client = window.supabase.createClient(config.url, config.anonKey);
  const loginPanel = document.getElementById('adminLoginPanel');
  const dashboard = document.getElementById('adminDashboard');
  const loginStatus = document.getElementById('adminStatus');
  const dashboardStatus = document.getElementById('adminDashboardStatus');
  const requestList = document.getElementById('adminRequestList');
  let requests = [];
  let profiles = new Map();
  let activeFilter = 'pending';

  function setStatus(element, message, kind = '') {
    element.textContent = message;
    element.className = `wallet-status${kind ? ` is-${kind}` : ''}`;
  }

  function formatGhs(amount) {
    return `GHS ${Number(amount).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function addText(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
  }

  function setFilter(filter) {
    activeFilter = filter;
    document.querySelectorAll('[data-admin-filter]').forEach((button) => {
      const selected = button.dataset.adminFilter === filter;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    renderRequests();
  }

  function renderRequests() {
    requestList.replaceChildren();
    const visibleRequests = requests.filter((request) => {
      if (activeFilter === 'pending') return request.status === 'pending';
      if (activeFilter === 'reviewed') return request.status !== 'pending';
      return true;
    });
    document.getElementById('adminRequestCount').textContent = activeFilter === 'pending'
      ? `${visibleRequests.length} pending`
      : `${visibleRequests.length} request${visibleRequests.length === 1 ? '' : 's'}`;

    if (!visibleRequests.length) {
      addText(requestList, 'p', 'wallet-request-empty', activeFilter === 'pending' ? 'No pending requests.' : 'No requests to show.');
      return;
    }

    visibleRequests.forEach((request) => {
      const profile = profiles.get(request.user_id) || {};
      const card = document.createElement('article');
      card.className = 'wallet-admin-request';
      card.dataset.requestId = request.id;
      const main = document.createElement('div');
      main.className = 'wallet-admin-request-main';
      const title = request.kind === 'deposit' ? 'Deposit request' : 'Withdrawal request';
      addText(main, 'h2', '', `${title} · ${profile.display_name || 'Account holder'}`);
      addText(main, 'p', '', profile.email || request.user_id);
      addText(main, 'p', '', `Current balance: ${formatGhs(profile.balance || 0)}`);
      addText(main, 'p', '', `Submitted ${new Date(request.created_at).toLocaleString()}`);
      if (request.kind === 'withdrawal') {
        const fee = Number(request.fee_amount ?? request.feeAmount ?? 0);
        const net = Number(request.net_payout ?? request.netPayout ?? (Number(request.amount || 0) - fee));
        addText(main, 'p', '', `Requested: ${formatGhs(request.amount)}`);
        addText(main, 'p', '', `Admin fee (5%): ${formatGhs(fee)}`);
        addText(main, 'p', '', `Net payout: ${formatGhs(net)}`);
      }
      if (request.note) addText(main, 'p', '', `User note: ${request.note}`);
      if (request.admin_note) addText(main, 'p', '', `Admin note: ${request.admin_note}`);

      const side = document.createElement('div');
      side.className = 'wallet-admin-request-side';
      addText(side, 'strong', 'wallet-admin-request-amount', formatGhs(request.amount));
      addText(side, 'span', `wallet-status-tag is-${request.status}`, request.status);
      card.append(main, side);

      if (request.status === 'pending') {
        const controls = document.createElement('div');
        controls.className = 'wallet-admin-controls';
        const note = document.createElement('input');
        note.className = 'wallet-admin-note';
        note.type = 'text';
        note.maxLength = 500;
        note.placeholder = 'Optional note for the user';
        note.setAttribute('aria-label', 'Admin note');
        const approve = document.createElement('button');
        approve.type = 'button';
        approve.className = 'wallet-button wallet-button-approve';
        approve.dataset.approve = 'true';
        approve.textContent = 'Approve';
        const reject = document.createElement('button');
        reject.type = 'button';
        reject.className = 'wallet-button wallet-button-reject';
        reject.dataset.approve = 'false';
        reject.textContent = 'Reject';
        controls.append(note, approve, reject);
        card.append(controls);
      } else if (request.reviewed_at) {
        addText(main, 'p', '', `Reviewed ${new Date(request.reviewed_at).toLocaleString()}`);
      }
      requestList.append(card);
    });
  }

  async function loadRequests() {
    setStatus(dashboardStatus, 'Loading requests…');
    const [requestResult, profileResult] = await Promise.all([
      client.from('wallet_requests').select('id, user_id, kind, amount, note, status, admin_note, created_at, reviewed_at').order('created_at', { ascending: false }),
      client.from('profiles').select('user_id, email, display_name, balance')
    ]);
    if (requestResult.error || profileResult.error) {
      setStatus(dashboardStatus, `Could not load admin data: ${(requestResult.error || profileResult.error).message}`, 'error');
      return false;
    }
    requests = requestResult.data || [];
    profiles = new Map((profileResult.data || []).map((profile) => [profile.user_id, profile]));
    renderRequests();
    setStatus(dashboardStatus, '');
    return true;
  }

  async function renderSession(session) {
    const user = session?.user;
    document.getElementById('adminEmail').textContent = user?.email || '';
    document.getElementById('adminSignOut').hidden = !user;
    if (!user) {
      loginPanel.hidden = false;
      dashboard.hidden = true;
      return;
    }

    const { data, error } = await client.rpc('is_wallet_admin');
    if (error || data !== true) {
      loginPanel.hidden = false;
      dashboard.hidden = true;
      setStatus(loginStatus, error ? error.message : 'This account is not authorized to review wallet requests.', 'error');
      return;
    }
    loginPanel.hidden = true;
    dashboard.hidden = false;
    setStatus(loginStatus, '');
    await loadRequests();
  }

  document.getElementById('adminLoginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus(loginStatus, 'Signing in…');
    const { error } = await client.auth.signInWithPassword({
      email: document.getElementById('adminLoginEmail').value.trim(),
      password: document.getElementById('adminLoginPassword').value
    });
    button.disabled = false;
    if (error) setStatus(loginStatus, error.message, 'error');
  });

  document.querySelectorAll('[data-admin-filter]').forEach((button) => {
    button.addEventListener('click', () => setFilter(button.dataset.adminFilter));
  });
  document.getElementById('adminRefresh').addEventListener('click', loadRequests);
  document.getElementById('adminSignOut').addEventListener('click', () => client.auth.signOut());

  requestList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-approve]');
    if (!button) return;
    const card = button.closest('[data-request-id]');
    const controls = card.querySelectorAll('button');
    controls.forEach((control) => { control.disabled = true; });
    setStatus(dashboardStatus, button.dataset.approve === 'true' ? 'Approving request…' : 'Rejecting request…');
    const { error } = await client.rpc('review_wallet_request', {
      p_request_id: card.dataset.requestId,
      p_approve: button.dataset.approve === 'true',
      p_admin_note: card.querySelector('.wallet-admin-note').value.trim()
    });
    if (error) {
      controls.forEach((control) => { control.disabled = false; });
      setStatus(dashboardStatus, error.message, 'error');
      return;
    }
    if (await loadRequests()) setStatus(dashboardStatus, 'Request reviewed.', 'success');
  });

  client.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => renderSession(session), 0);
  });
  client.auth.getSession().then(({ data, error }) => {
    if (error) setStatus(loginStatus, error.message, 'error');
    renderSession(data?.session || null);
  });
})();
