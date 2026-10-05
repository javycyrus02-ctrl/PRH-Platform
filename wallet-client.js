(() => {
  const root = document.getElementById('cloudWalletRoot');
  const setupMessage = document.getElementById('cloudSetupMessage');
  const config = window.PRHSupabaseConfig || {};
  const isConfigured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.url || '')
    && !!config.anonKey
    && !/YOUR_|REPLACE_ME/i.test(config.anonKey);

  if (!isConfigured || !window.supabase?.createClient) {
    setupMessage.hidden = false;
    setupMessage.textContent = !isConfigured
      ? 'Add your Supabase project URL and anon key to supabase-config.js, then run supabase/schema.sql in the Supabase SQL Editor.'
      : 'Supabase client failed to load. Check your connection and reload this page.';
    document.getElementById('cloudAuthPanel').hidden = true;
    return;
  }

  const client = window.supabase.createClient(config.url, config.anonKey);
  const authPanel = document.getElementById('cloudAuthPanel');
  const dashboard = document.getElementById('cloudDashboard');
  const signedInNav = document.getElementById('cloudSignedInNav');
  const authStatus = document.getElementById('cloudAuthStatus');
  const walletStatus = document.getElementById('cloudWalletStatus');
  const requestList = document.getElementById('cloudRequestList');
  let currentUser = null;

  function setStatus(element, message, kind = '') {
    element.textContent = message;
    element.className = `wallet-status${kind ? ` is-${kind}` : ''}`;
  }

  function formatGhs(amount) {
    return `GHS ${Number(amount).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function setAuthMode(mode) {
    const signup = mode === 'signup';
    document.getElementById('cloudLoginForm').hidden = signup;
    document.getElementById('cloudSignupForm').hidden = !signup;
    document.getElementById('cloudLoginTab').classList.toggle('is-active', !signup);
    document.getElementById('cloudSignupTab').classList.toggle('is-active', signup);
    document.getElementById('cloudLoginTab').setAttribute('aria-selected', String(!signup));
    document.getElementById('cloudSignupTab').setAttribute('aria-selected', String(signup));
    document.getElementById('cloudAuthHeading').textContent = signup ? 'Create your account' : 'Welcome back';
    document.getElementById('cloudAuthDescription').textContent = signup
      ? 'Create an account to manage your GHS wallet.'
      : 'Sign in to view your GHS balance and requests.';
    setStatus(authStatus, '');
  }

  function addText(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
  }

  function renderRequests(requests) {
    requestList.replaceChildren();
    if (!requests.length) {
      addText(requestList, 'p', 'wallet-request-empty', 'No deposit or withdrawal requests yet.');
      return;
    }

    requests.forEach((request) => {
      const row = document.createElement('article');
      row.className = 'wallet-request-row';
      const primary = document.createElement('div');
      primary.className = 'wallet-request-primary';
      addText(primary, 'strong', '', request.kind === 'deposit' ? 'Deposit request' : 'Withdrawal request');
      addText(primary, 'p', 'wallet-request-meta', new Date(request.created_at).toLocaleString());
      if (request.note) addText(primary, 'p', 'wallet-request-meta', request.note);
      if (request.admin_note) addText(primary, 'p', 'wallet-request-meta', `Admin note: ${request.admin_note}`);
      const side = document.createElement('div');
      side.className = 'wallet-request-side';
      addText(side, 'strong', 'wallet-request-amount', formatGhs(request.amount));
      addText(side, 'span', `wallet-status-tag is-${request.status}`, request.status);
      row.append(primary, side);
      requestList.append(row);
    });
  }

  async function refreshWallet() {
    if (!currentUser) return;
    setStatus(walletStatus, 'Refreshing wallet…');
    const [profileResult, requestResult, adminResult] = await Promise.all([
      client.from('profiles').select('email, display_name, balance').eq('user_id', currentUser.id).single(),
      client.from('wallet_requests').select('id, kind, amount, note, admin_note, status, created_at').eq('user_id', currentUser.id).order('created_at', { ascending: false }),
      client.rpc('is_wallet_admin')
    ]);

    if (profileResult.error) {
      setStatus(walletStatus, `Could not load your wallet: ${profileResult.error.message}`, 'error');
      return;
    }
    if (requestResult.error) {
      setStatus(walletStatus, `Could not load your requests: ${requestResult.error.message}`, 'error');
      return;
    }

    const profile = profileResult.data;
    document.getElementById('cloudBalance').textContent = formatGhs(profile.balance);
    document.getElementById('cloudWelcome').textContent = profile.display_name ? `Welcome, ${profile.display_name}` : 'Your wallet';
    document.getElementById('cloudUserEmail').textContent = profile.email || currentUser.email || '';
    document.getElementById('cloudAdminLink').hidden = adminResult.error || adminResult.data !== true;
    renderRequests(requestResult.data || []);
    setStatus(walletStatus, '');
  }

  async function renderSession(session) {
    currentUser = session?.user || null;
    const signedIn = !!currentUser;
    authPanel.hidden = signedIn;
    dashboard.hidden = !signedIn;
    signedInNav.hidden = !signedIn;
    if (signedIn) await refreshWallet();
  }

  document.getElementById('cloudLoginTab').addEventListener('click', () => setAuthMode('login'));
  document.getElementById('cloudSignupTab').addEventListener('click', () => setAuthMode('signup'));

  document.getElementById('cloudLoginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus(authStatus, 'Signing in…');
    const { error } = await client.auth.signInWithPassword({
      email: document.getElementById('cloudLoginEmail').value.trim(),
      password: document.getElementById('cloudLoginPassword').value
    });
    button.disabled = false;
    setStatus(authStatus, error ? error.message : 'Signed in.', error ? 'error' : 'success');
  });

  document.getElementById('cloudSignupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus(authStatus, 'Creating account…');
    const { data, error } = await client.auth.signUp({
      email: document.getElementById('cloudSignupEmail').value.trim(),
      password: document.getElementById('cloudSignupPassword').value,
      options: { data: { display_name: document.getElementById('cloudSignupName').value.trim() } }
    });
    button.disabled = false;
    if (error) {
      setStatus(authStatus, error.message, 'error');
    } else if (!data.session) {
      setStatus(authStatus, 'Check your email to confirm your account, then sign in.', 'success');
    } else {
      setStatus(authStatus, 'Account created.', 'success');
    }
  });

  async function submitWalletRequest(event) {
    event.preventDefault();
    if (!currentUser) return;
    const form = event.currentTarget;
    const submitButton = form.querySelector('button[type="submit"]');
    const formData = new FormData(form);
    const amount = Number(formData.get('amount'));
    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus(walletStatus, 'Enter an amount greater than zero.', 'error');
      return;
    }

    submitButton.disabled = true;
    setStatus(walletStatus, 'Submitting request…');
    const { error } = await client.rpc('submit_wallet_request', {
      p_kind: form.dataset.kind,
      p_amount: amount,
      p_note: String(formData.get('note') || '').trim()
    });
    submitButton.disabled = false;
    if (error) {
      setStatus(walletStatus, error.message, 'error');
      return;
    }
    form.reset();
    await refreshWallet();
    setStatus(walletStatus, 'Request submitted. Your balance changes after admin approval.', 'success');
  }

  document.getElementById('cloudDepositForm').addEventListener('submit', submitWalletRequest);
  document.getElementById('cloudWithdrawalForm').addEventListener('submit', submitWalletRequest);
  document.getElementById('cloudRefreshRequests').addEventListener('click', refreshWallet);
  document.getElementById('cloudSignOut').addEventListener('click', () => client.auth.signOut());
  document.getElementById('cloudMobileSignOut').addEventListener('click', () => client.auth.signOut());

  client.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => renderSession(session), 0);
  });
  client.auth.getSession().then(({ data, error }) => {
    if (error) setStatus(authStatus, error.message, 'error');
    renderSession(data?.session || null);
  });
})();
