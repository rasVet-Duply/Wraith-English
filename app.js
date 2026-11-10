(function(){

  /* =====================================================================
     SUPABASE CONFIG — fill these two lines in with your own project's
     values (Supabase dashboard → Settings → API), then re-upload the file.
     ===================================================================== */
  const SUPABASE_URL = 'https://eesqqmqfeititqqxwvfl.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_cFj_C1sIt8XahB3H76Yt1A_JIQypxvp';

  const ADMIN_EMAIL = 'rasvet1pro@gmail.com';
  const BUCKET = 'materials';

  let supabase;
  try{
    if(!window.supabase) throw new Error('SDK не загрузился (нет интернета или CDN заблокирован).');
    if(SUPABASE_URL.includes('YOUR-PROJECT-REF') || SUPABASE_ANON_KEY.includes('YOUR-ANON')){
      throw new Error('Supabase ещё не настроен: впиши SUPABASE_URL и SUPABASE_ANON_KEY в начале файла.');
    }
    // Custom fetch: some sandboxed/embedded webviews proxy fetch() in a way
    // that chokes on a native Headers instance ("DataCloneError ... Headers
    // object could not be cloned") or randomly throws "Failed to fetch".
    // Using plain header objects and retrying once sidesteps both.
    async function robustFetch(input, init){
      const plainInit = init ? Object.assign({}, init) : {};
      if(plainInit.headers && typeof Headers !== 'undefined' && plainInit.headers instanceof Headers){
        const obj = {};
        plainInit.headers.forEach((v, k) => { obj[k] = v; });
        plainInit.headers = obj;
      }
      try{
        return await window.fetch(input, plainInit);
      }catch(err){
        // one quiet retry — covers a flaky first request / cold proxy
        await new Promise(r => setTimeout(r, 400));
        return await window.fetch(input, plainInit);
      }
    }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { fetch: robustFetch }
    });
  }catch(e){
    document.getElementById('auth').innerHTML =
      `<div class="auth-card"><div class="auth-msg error">${e.message}</div></div>`;
    return;
  }

  /* ================= AUTH (Supabase) ================= */
  const authEl = document.getElementById('auth');
  const appEl = document.getElementById('app');
  const authMsg = document.getElementById('authMsg');

  function showMsg(text, type){
    authMsg.innerHTML = `<div class="auth-msg ${type}">${text}</div>`;
  }
  function clearMsg(){ authMsg.innerHTML = ''; }
  function setBusy(btn, busy, labelBusy, labelNormal){
    btn.disabled = busy;
    btn.textContent = busy ? labelBusy : labelNormal;
  }
  // Wraps a Supabase call so a stuck connection can't leave the button
  // spinning forever — after `ms` we surface a clear timeout error instead.
  function withTimeout(promise, ms){
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
    ]);
  }
  // Speeds up login/register: instead of onAuthStateChange doing a separate
  // sequential DB round trip to fetch the username after sign-in finishes,
  // we fetch it in parallel with the auth call (login) or already know it
  // locally (register) and hand it off here — saves one full network round
  // trip on the critical path into the app.
  let authHandoff = null; // { userId, username, avatarUrl }
  let registrationGate = null; // Promise<boolean> while a sign-up is still creating its profile row

  const tabs = { login: document.getElementById('tabLogin'), register: document.getElementById('tabRegister') };
  const steps = {
    login: document.getElementById('stepLogin'),
    register: document.getElementById('stepRegister')
  };
  function showStep(name){
    Object.values(steps).forEach(s=>s.classList.remove('active'));
    steps[name].classList.add('active');
  }
  function goToLoginTab(){
    tabs.login.classList.add('active'); tabs.register.classList.remove('active');
    showStep('login');
  }
  function goToRegisterTab(){
    tabs.register.classList.add('active'); tabs.login.classList.remove('active');
    showStep('register');
  }
  tabs.login.addEventListener('click', ()=>{ clearMsg(); goToLoginTab(); });
  tabs.register.addEventListener('click', ()=>{ clearMsg(); goToRegisterTab(); });

  // ---- login (username + password) ----
  const btnLogin = document.getElementById('btnLogin');
  let loginReqId = 0;
  async function doLogin(){
    const username = document.getElementById('loginUsername').value.trim();
    const pass = document.getElementById('loginPassword').value;
    if(!username || !pass){ showMsg('Заполни логин и пароль.', 'error'); return; }
    clearMsg(); setBusy(btnLogin, true, 'Входим…', 'Войти');
    const myReq = ++loginReqId;
    const isStale = () => myReq !== loginReqId;

    try{
      // If they typed their email directly, skip the username lookup —
      // one less round trip, faster login.
      let email = username.includes('@') ? username.toLowerCase() : null;
      if(!email){
        // ilike = регистронезависимый поиск, чтобы "Sasha" и "sasha" считались одним логином
        const { data: profile, error: lookupErr } = await withTimeout(
          supabase.from('profiles').select('email').ilike('username', username).maybeSingle(),
          12000
        );
        if(isStale()) return;
        if(lookupErr){
          setBusy(btnLogin, false, 'Входим…', 'Войти');
          showMsg('Ошибка базы данных: ' + lookupErr.message, 'error');
          return;
        }
        if(!profile){
          setBusy(btnLogin, false, 'Входим…', 'Войти');
          showMsg('Нет аккаунта с таким логином.', 'error');
          return;
        }
        email = profile.email;
      }

      const [signInRes, profileHint] = await withTimeout(
        Promise.all([
          supabase.auth.signInWithPassword({ email, password: pass }),
          supabase.from('profiles').select('username,avatar_url').eq('email', email).maybeSingle()
            .then(r => r.data).catch(() => null)
        ]),
        12000
      );
      if(isStale()) return;
      setBusy(btnLogin, false, 'Входим…', 'Войти');
      const { error } = signInRes;
      if(error){ showMsg(error.message === 'Invalid login credentials' ? 'Неверный пароль.' : error.message, 'error'); return; }
      if(signInRes.data && signInRes.data.user && profileHint){
        authHandoff = { userId: signInRes.data.user.id, username: profileHint.username, avatarUrl: profileHint.avatar_url };
      }
      // onAuthStateChange handles entering the app
    }catch(e){
      if(isStale()) return;
      setBusy(btnLogin, false, 'Входим…', 'Войти');
      const timedOut = e.message === 'TIMEOUT';
      showMsg(
        timedOut
          ? 'Сервер долго не отвечает. Проверь связь и попробуй ещё раз — или зайди как гость.'
          : 'Не получилось связаться с сервером: ' + e.message,
        'error'
      );
    }
  }
  btnLogin.addEventListener('click', doLogin);
  document.getElementById('loginUsername').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
  document.getElementById('loginPassword').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });

  // ---- register (email + username + password, one step) ----
  const btnGetStarted = document.getElementById('btnGetStarted');
  let registerReqId = 0;
  async function doRegister(){
    const email = document.getElementById('regEmail').value.trim().toLowerCase();
    const username = document.getElementById('regUsername').value.trim();
    const p1 = document.getElementById('regPassword').value;
    const p2 = document.getElementById('regPassword2').value;

    if(!document.getElementById('regAgreeRules').checked){ showMsg('Нужно согласиться с Правилами использования.', 'error'); return; }
    if(!email || !email.includes('@')){ showMsg('Введи корректную почту.', 'error'); return; }
    if(!username){ showMsg('Придумай логин.', 'error'); return; }
    if(p1.length < 6){ showMsg('Пароль должен быть от 6 символов.', 'error'); return; }
    if(p1 !== p2){ showMsg('Пароли не совпадают.', 'error'); return; }

    clearMsg(); setBusy(btnGetStarted, true, 'Создаём…', 'Get Started');
    const myReq = ++registerReqId;
    const isStale = () => myReq !== registerReqId;
    let gateResolve = null, registrationOk = false;

    try{
      // проверяем почту и логин ОДНОВРЕМЕННО (параллельно), а не по очереди —
      // это вдвое сокращает время ожидания перед регистрацией
      const [emailRes, usernameRes] = await withTimeout(Promise.all([
        supabase.from('profiles').select('username').eq('email', email).maybeSingle(),
        supabase.from('profiles').select('username').ilike('username', username).maybeSingle()
      ]), 12000);
      if(isStale()) return;
      const { data: byEmail, error: byEmailErr } = emailRes;
      const { data: byUsername, error: byUsernameErr } = usernameRes;

      if(byEmailErr){
        setBusy(btnGetStarted, false, 'Создаём…', 'Get Started');
        showMsg('Ошибка базы данных: ' + byEmailErr.message, 'error');
        return;
      }
      if(byEmail){
        setBusy(btnGetStarted, false, 'Создаём…', 'Get Started');
        showMsg(`Эта почта уже используется (логин «${byEmail.username}»). Просто войди — не нужно регистрироваться заново.`, 'error');
        goToLoginTab();
        document.getElementById('loginUsername').value = byEmail.username;
        return;
      }
      if(byUsernameErr){
        setBusy(btnGetStarted, false, 'Создаём…', 'Get Started');
        showMsg('Ошибка базы данных: ' + byUsernameErr.message, 'error');
        return;
      }
      if(byUsername){
        setBusy(btnGetStarted, false, 'Создаём…', 'Get Started');
        showMsg('Такой логин уже занят, придумай другой.', 'error');
        return;
      }

      registrationGate = new Promise(r => { gateResolve = r; });
      const { data: signUpData, error: signUpErr } = await withTimeout(
        supabase.auth.signUp({ email, password: p1 }),
        12000
      );
      if(isStale()) return;
      if(signUpErr){
        setBusy(btnGetStarted, false, 'Создаём…', 'Get Started');
        showMsg('Не получилось создать аккаунт: ' + signUpErr.message, 'error');
        return;
      }
      if(!signUpData.session || !signUpData.user){
        setBusy(btnGetStarted, false, 'Создаём…', 'Get Started');
        showMsg('Аккаунт создан, но вход не выполнен автоматически. Проверь в настройках Supabase, что "Confirm email" выключен.', 'error');
        return;
      }

      const { error: profileErr } = await withTimeout(
        supabase.from('profiles').insert({ id: signUpData.user.id, username, email }),
        12000
      );
      if(isStale()) return;
      setBusy(btnGetStarted, false, 'Создаём…', 'Get Started');
      if(profileErr){
        showMsg('Аккаунт создан, но логин не сохранился: ' + profileErr.message, 'error');
        return;
      }
      // We already know the username locally — hand it straight to
      // onAuthStateChange so it doesn't re-fetch it from the DB.
      authHandoff = { userId: signUpData.user.id, username, avatarUrl: null };
      registrationOk = true;
      // onAuthStateChange handles entering the app
    }catch(e){
      if(isStale()) return;
      setBusy(btnGetStarted, false, 'Создаём…', 'Get Started');
      const timedOut = e.message === 'TIMEOUT';
      showMsg(
        timedOut
          ? 'Сервер долго не отвечает. Проверь связь и попробуй ещё раз — или зайди как гость.'
          : 'Не получилось связаться с сервером: ' + e.message,
        'error'
      );
    }finally{
      if(gateResolve){ const g = gateResolve; registrationGate = null; g(registrationOk); }
    }
  }
  btnGetStarted.addEventListener('click', doRegister);
  ['regEmail','regUsername','regPassword','regPassword2'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown', e=>{ if(e.key==='Enter') doRegister(); });
  });

  const regAgreeRules = document.getElementById('regAgreeRules');
  regAgreeRules.addEventListener('change', () => {
    btnGetStarted.disabled = !regAgreeRules.checked;
    btnGetStarted.style.opacity = regAgreeRules.checked ? '1' : '.5';
  });
  document.querySelectorAll('.js-open-rules').forEach(el => el.addEventListener('click', (e) => {
    e.preventDefault();
    const overlay = makeOverlay(`
      <h3 style="margin:0 0 10px;font-size:1.05rem;">Правила использования WRAITH ENGLISH</h3>
      <div style="font-size:.84rem;line-height:1.55;color:var(--text-dim);max-height:50vh;overflow:auto;">
        <p><b>1. Уважение к другим пользователям.</b> Запрещены оскорбления, травля, дискриминация и любые формы харассмента в чатах.</p>
        <p><b>2. Запрещённый контент.</b> Нельзя публиковать, обсуждать или распространять материалы, связанные с незаконной деятельностью, насилием, экстремизмом, а также материалы, эксплуатирующие несовершеннолетних.</p>
        <p><b>3. Спам и мошенничество.</b> Запрещена рассылка спама, фишинговых ссылок и попытки обмана других пользователей.</p>
        <p><b>4. Авторские права.</b> Не публикуй чужие материалы без разрешения правообладателя.</p>
        <p><b>5. Модерация.</b> Администрация сайта может удалять сообщения, нарушающие правила, а также ограничивать (мьютить), временно или навсегда банить участников за нарушения — в рамках групп, где эти сообщения были опубликованы. Личная переписка (ЛС) между пользователями не просматривается и не модерируется администрацией.</p>
        <p><b>6. Жалобы.</b> Если ты столкнулся с нарушением, используй кнопку «Report» на сообщении — жалоба попадёт администрации для рассмотрения.</p>
        <p><b>7. Возрастные ограничения.</b> Сервис предназначен для лиц старше 13 лет (или установленного законом возраста в твоей стране).</p>
        <p><b>8. Последствия нарушений.</b> Нарушение правил может привести к предупреждению, ограничению функций, временному или постоянному бану аккаунта.</p>
      </div>
      <button class="acct-btn" id="rulesCloseBtn" style="width:100%;margin-top:14px;">Понятно</button>
    `, 400);
    document.getElementById('rulesCloseBtn').addEventListener('click', () => overlay.remove());
  }));

  /* ---- Google sign-in ---- */
  async function doGoogle(btn){
    clearMsg();
    if(navigator.onLine === false){ showMsg('Нет подключения к интернету.', 'error'); return; }
    btn.disabled = true;
    try{
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } }
      });
      if(error) throw error;
    }catch(e){
      btn.disabled = false;
      showMsg('Не удалось войти через Google: ' + (e.message || e), 'error');
    }
  }
  ['btnGoogleLogin', 'btnGoogleReg'].forEach(id => {
    const b = document.getElementById(id);
    if(b) b.addEventListener('click', () => doGoogle(b));
  });
  (function showOAuthReturnError(){
    const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const q = new URLSearchParams(location.search);
    const err = h.get('error_description') || q.get('error_description');
    if(err){ showMsg('Google: ' + err.replace(/\+/g, ' '), 'error'); history.replaceState(null, '', location.pathname); }
  })();

  // First Google sign-in has no profile row yet — create one (nickname from the Google name, made unique).
  async function ensureProfileForUser(user){
    const { data: existing, error: e1 } = await supabase.from('profiles').select('username,avatar_url').eq('id', user.id).maybeSingle();
    if(e1) throw e1;
    if(existing && existing.username){ window.currentUserAvatarUrl = existing.avatar_url || null; return existing.username; }
    const email = (user.email || '').toLowerCase();
    const { data: byEmail } = await supabase.from('profiles').select('id').eq('email', email).maybeSingle();
    if(byEmail && byEmail.id !== user.id) throw new Error('Эта почта уже зарегистрирована с паролем — войди по логину и паролю.');
    const meta = user.user_metadata || {};
    const base = String(meta.full_name || meta.name || email.split('@')[0] || 'user').replace(/[^\p{L}\p{N}._-]+/gu, '').slice(0, 20) || 'user';
    let username = base;
    for(let i = 0; i < 8; i++){
      const { data: taken } = await supabase.from('profiles').select('id').ilike('username', username).maybeSingle();
      if(!taken) break;
      username = base.slice(0, 16) + Math.floor(1000 + Math.random() * 9000);
    }
    const avatar = meta.avatar_url || meta.picture || null;
    let { error } = await supabase.from('profiles').insert({ id: user.id, username, email, avatar_url: avatar });
    if(error){ ({ error } = await supabase.from('profiles').insert({ id: user.id, username, email })); }
    if(error) throw error;
    window.currentUserAvatarUrl = avatar;
    return username;
  }

  async function fetchUsername(userId){
    const { data } = await supabase.from('profiles').select('username').eq('id', userId).maybeSingle();
    return data ? data.username : null;
  }

  function enterApp(email, username){
    authEl.classList.add('hidden');
    appEl.classList.add('visible');
    warnStorageUnavailableIfNeeded();
    flushPendingSyncs(); // retry any Reading/Listening/Writing saves that couldn't reach the server last time
    renderUserFoot(email, username);
    document.querySelector('.nav-btn[data-section="reading"]').click();
    // Console /pm messages land here — checked periodically no matter which
    // screen the person is on (Reading, Listening, chats, anywhere).
    pollAdminBroadcasts();
    setInterval(pollAdminBroadcasts, 6000);
  }

  // Shows a full-screen ban notice with a live countdown; the moment it
  // hits zero the restriction is lifted immediately (no page reload needed).
  function showBanScreen(untilIso, scope){
    const screen = document.createElement('div');
    screen.className = 'ban-screen';
    screen.innerHTML = `
      <h2>🚫 You have been banned</h2>
      <p>${scope === 'site' ? 'You cannot access this site right now.' : 'You cannot access this group right now.'}</p>
      <div class="ban-timer" id="banTimerEl">--:--:--</div>
      <p>Access will be restored automatically when the timer reaches zero.</p>
    `;
    document.body.appendChild(screen);
    const until = new Date(untilIso).getTime();
    const timerEl = screen.querySelector('#banTimerEl');
    const tick = () => {
      const left = until - Date.now();
      if(left <= 0){
        screen.remove();
        clearInterval(iv);
        if(scope === 'site') location.reload();
        return;
      }
      const d = Math.floor(left/86400000);
      const h = Math.floor((left%86400000)/3600000);
      const m = Math.floor((left%3600000)/60000);
      const s = Math.floor((left%60000)/1000);
      timerEl.textContent = (d?`${d}d `:'') + `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    };
    tick();
    const iv = setInterval(tick, 1000);
  }

  function renderUserFoot(email, username){
    const admin = email === ADMIN_EMAIL;
    document.getElementById('sidebarFoot').innerHTML = `
      <div class="user-email">${username || email}${admin ? ' · admin' : ''}</div>
      <span class="logout" id="logoutBtn">Log out</span>`;
    document.getElementById('logoutBtn').addEventListener('click', async ()=>{
      await supabase.auth.signOut();
    });
  }

  // Real, verifiable test of whether localStorage actually persists writes
  // in this browser/webview — some in-app browsers (and private/incognito
  // modes) accept localStorage.setItem() without throwing but then don't
  // keep the value, or block it outright. This is the root cause behind
  // "Save shows a confirmation but nothing is there next time": the write
  // was silently swallowed and no part of the app noticed. Run this once at
  // startup so we can tell the person honestly, instead of only finding out
  // the next time they try to save.
  function storageWriteReadTest(){
    try{
      const k = '__storage_test__' + Date.now();
      localStorage.setItem(k, '1');
      const ok = localStorage.getItem(k) === '1';
      localStorage.removeItem(k);
      return ok;
    }catch(e){ return false; }
  }
  const storageAvailable = storageWriteReadTest();
  window.storageAvailable = storageAvailable;

  let storageWarningShown = false;
  function warnStorageUnavailableIfNeeded(){
    if(storageAvailable || storageWarningShown) return;
    storageWarningShown = true;
    const banner = document.createElement('div');
    banner.className = 'storage-warn-banner';
    banner.innerHTML = `
      <div style="flex:1;">
        <b>Прогресс не будет сохраняться</b><br>
        Этот браузер блокирует локальное хранилище (часто это приватный/инкогнито режим
        или встроенный браузер с ограничениями). Reading/Listening/Writing будут
        показывать «Сохранено», но прогресс исчезнет при повторном открытии.
        Попробуйте открыть сайт в обычном браузере (Chrome/Safari), не в режиме инкогнито.
      </div>
      <span class="swb-close" title="Закрыть">✕</span>`;
    banner.querySelector('.swb-close').addEventListener('click', () => banner.remove());
    document.body.appendChild(banner);
  }

  /* ---- guest mode (continue without login) ---- */
  let isGuest = false;
  window.isGuest = false;
  window.currentUserEmail = null;

  function renderGuestFoot(){
    document.getElementById('sidebarFoot').innerHTML = `
      <div class="user-email">Гость</div>
      <span class="logout" id="logoutBtn">Войти</span>`;
    document.getElementById('logoutBtn').addEventListener('click', exitGuestToLogin);
  }

  function enterGuestMode(){
    isGuest = true;
    window.isGuest = true;
    clearMsg();
    authEl.classList.add('hidden');
    appEl.classList.add('visible');
    warnStorageUnavailableIfNeeded();
    renderGuestFoot();
    document.getElementById('acctInitial').textContent = '?';
    document.querySelector('.nav-btn[data-section="reading"]').click();
  }

  function exitGuestToLogin(){
    isGuest = false;
    window.isGuest = false;
    closeAcctPopover();
    appEl.classList.remove('visible');
    authEl.classList.remove('hidden');
    clearMsg();
    goToLoginTab();
  }

  document.getElementById('guestLink').addEventListener('click', enterGuestMode);

  let currentUserEmail = null;
  let currentUserId = null;
  let currentUsername = null;
  let currentUserCreatedAt = null;

  /* ---- saved accounts (for quick account switching) ---- */
  const ACCOUNTS_KEY = 'wraith_saved_accounts';
  function loadSavedAccounts(){
    try{ return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]'); }
    catch(e){ return []; }
  }
  function saveSavedAccounts(list){ localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); }
  function upsertSavedAccount(entry){
    const list = loadSavedAccounts();
    const idx = list.findIndex(a => a.user_id === entry.user_id);
    if(idx >= 0) list[idx] = entry; else list.push(entry);
    saveSavedAccounts(list);
  }
  function removeSavedAccount(userId){
    saveSavedAccounts(loadSavedAccounts().filter(a => a.user_id !== userId));
  }

  // ---- Admin broadcast messages: shown to everyone (logged in or guest) ----
  function showBroadcastToast(name, message){
    const toast = document.getElementById('broadcastToast');
    if(!toast) return;
    toast.innerHTML = `<b>${name}:</b> ${message}`;
    toast.classList.add('show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => { toast.classList.remove('show'); }, 7000);
  }
  let lastSeenBroadcastId = parseInt(localStorage.getItem('lastSeenBroadcastId') || '0', 10);
  async function checkBroadcasts(){
    try{
      const { data, error } = await supabase
        .from('broadcasts').select('id,message,created_by').order('id', { ascending: false }).limit(1);
      if(error || !data || !data.length) return;
      const latest = data[0];
      if(latest.id > lastSeenBroadcastId){
        lastSeenBroadcastId = latest.id;
        localStorage.setItem('lastSeenBroadcastId', String(latest.id));
        showBroadcastToast(latest.created_by || 'Rasvet', latest.message);
      }
    }catch(e){ /* table may not exist yet — stay quiet */ }
  }
  checkBroadcasts();
  setInterval(checkBroadcasts, 5000);

  // ---- Presence / online count ----
  function getSessionId(){
    let id = localStorage.getItem('presenceSessionId');
    if(!id){
      id = (crypto.randomUUID ? crypto.randomUUID() : ('s' + Date.now().toString(36) + Math.random().toString(36).slice(2)));
      localStorage.setItem('presenceSessionId', id);
    }
    return id;
  }
  const presenceSessionId = getSessionId();
  // Ghost mode (admin only): while on, we skip presence heartbeats and
  // read-receipt writes, so the admin account shows as offline/last-seen
  // hidden and doesn't mark messages as read for other people.
  let ghostMode = localStorage.getItem('ghostMode') === '1';
  async function sendHeartbeat(){
    if(ghostMode){
      try{ await supabase.from('presence').delete().eq('session_id', presenceSessionId); }catch(e){}
      return;
    }
    try{
      await supabase.from('presence').upsert({
        session_id: presenceSessionId,
        user_id: currentUserId || null,
        username: currentUsername || null,
        last_seen: new Date().toISOString()
      });
    }catch(e){ /* table may not exist yet — stay quiet */ }
  }
  sendHeartbeat();
  setInterval(sendHeartbeat, 20000);

  async function updateOnlineBadge(){
    const badge = document.getElementById('onlineCount');
    if(!badge) return;
    try{
      const { data: settingRows } = await supabase.from('site_settings').select('key,value').in('key', ['online_mode','online_custom_value']);
      const settings = {};
      (settingRows || []).forEach(r => settings[r.key] = r.value);
      if(settings.online_mode === 'custom' && settings.online_custom_value){
        badge.textContent = settings.online_custom_value;
        return;
      }
      const cutoff = Date.now() - 60000;
      const { data: rows } = await supabase.from('presence').select('last_seen');
      const count = (rows || []).filter(r => new Date(r.last_seen).getTime() > cutoff).length;
      badge.textContent = String(Math.max(count, 1));
    }catch(e){ /* stay quiet, table may not exist yet */ }
  }
  updateOnlineBadge();
  setInterval(updateOnlineBadge, 15000);

  function openOnlineCustomModal(){
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = `
      <div class="confirm-modal" style="max-width:300px;">
        <h3 style="margin:0 0 14px;font-size:1rem;">Custom online count</h3>
        <input type="text" id="onlineCustomInput" placeholder="Например, 214" style="width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--line);margin-bottom:14px;">
        <div style="display:flex;gap:10px;">
          <button class="acct-btn" id="onlineCustomCancel" style="flex:1;">Отмена</button>
          <button class="acct-btn" id="onlineCustomSave" style="flex:1;background:var(--btn);color:#fff;">Сохранить</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
    document.getElementById('onlineCustomCancel').addEventListener('click', () => overlay.remove());
    document.getElementById('onlineCustomSave').addEventListener('click', async () => {
      const val = document.getElementById('onlineCustomInput').value.trim();
      if(!val) return;
      try{
        await supabase.from('site_settings').upsert({ key: 'online_mode', value: 'custom' });
        await supabase.from('site_settings').upsert({ key: 'online_custom_value', value: val });
        overlay.remove();
        updateOnlineBadge();
      }catch(e){ alert('Ошибка: ' + e.message); }
    });
  }

  function openOnlineRealModal(){
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = `
      <div class="confirm-modal" style="max-width:300px;">
        <h3 style="margin:0 0 14px;font-size:1rem;">Online count</h3>
        <div style="display:flex;gap:10px;">
          <button class="acct-btn" id="realCheckBtn" style="flex:1;">Check</button>
          <button class="acct-btn" id="realSetupBtn" style="flex:1;background:var(--btn);color:#fff;">Set up</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
    document.getElementById('realSetupBtn').addEventListener('click', async () => {
      try{
        await supabase.from('site_settings').upsert({ key: 'online_mode', value: 'real' });
        overlay.remove();
        updateOnlineBadge();
      }catch(e){ alert('Ошибка: ' + e.message); }
    });
    document.getElementById('realCheckBtn').addEventListener('click', () => {
      overlay.remove();
      openMembersList();
    });
  }

  async function openMembersList(){
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = `
      <div class="confirm-modal" style="max-width:380px;text-align:left;">
        <h3 style="margin:0 0 6px;font-size:1rem;">Участники</h3>
        <div id="membersBody">Загрузка…</div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });

    const body = document.getElementById('membersBody');
    try{
      const [{ data: profiles }, { data: presenceRows }] = await Promise.all([
        supabase.from('profiles').select('id,username'),
        supabase.from('presence').select('user_id,username,last_seen,session_id')
      ]);
      const list = (profiles || []).slice().sort((a,b) => a.username.localeCompare(b.username, 'ru'));
      const guestCount = (presenceRows || []).filter(r => !r.user_id && (Date.now() - new Date(r.last_seen).getTime()) < 120000).length;
      const lastSeenByUser = {};
      (presenceRows || []).forEach(r => { if(r.user_id) lastSeenByUser[r.user_id] = r.last_seen; });

      function exactTime(iso){
        if(!iso) return '';
        return new Date(iso).toLocaleString('ru', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
      }
      function timeAgo(iso){
        if(!iso) return 'давно не заходил(а)';
        const diffMs = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(diffMs / 60000);
        if(mins < 1) return 'сейчас на сайте · ' + exactTime(iso);
        if(mins < 60) return mins + ' мин назад · ' + exactTime(iso);
        const hrs = Math.floor(mins / 60);
        if(hrs < 24) return hrs + ' ч назад · ' + exactTime(iso);
        return Math.floor(hrs / 24) + ' дн назад · ' + exactTime(iso);
      }

      function renderList(){
        body.innerHTML = `
          <div class="members-list">
            ${list.map(p => `
              <div class="members-row" data-id="${p.id}" data-username="${p.username}">
                <div>
                  <div class="mr-name">${p.username}</div>
                  <div class="mr-sub">${timeAgo(lastSeenByUser[p.id])}</div>
                </div>
              </div>
            `).join('')}
            <div class="members-guest-count">Гости онлайн: ${guestCount}</div>
          </div>`;


        body.querySelectorAll('.members-row').forEach(row => {
          let tapCount = 0, tapTimer = null;
          row.addEventListener('click', () => {
            tapCount++;
            if(tapCount === 1){
              tapTimer = setTimeout(() => {
                tapCount = 0;
                renderDetail(row.dataset.id, row.dataset.username);
              }, 320);
            } else if(tapCount === 2){
              clearTimeout(tapTimer); tapCount = 0;
              navigator.clipboard && navigator.clipboard.writeText(row.dataset.username);
              const nameEl = row.querySelector('.mr-name');
              const original = nameEl.textContent;
              nameEl.textContent = 'Скопировано!';
              nameEl.classList.add('copy-flash');
              setTimeout(() => { nameEl.textContent = original; nameEl.classList.remove('copy-flash'); }, 900);
            }
          });
        });
      }

      function renderDetail(userId, username){
        body.innerHTML = `
          <div class="members-back" id="membersBackBtn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
            Назад к участникам
          </div>
          <div class="members-detail-row"><b>Никнейм</b>${username}</div>
          <div class="members-detail-row"><b>Активность</b>${timeAgo(lastSeenByUser[userId])}</div>
        `;
        document.getElementById('membersBackBtn').addEventListener('click', renderList);

      }

      renderList();
    }catch(e){
      body.innerHTML = `<div class="auth-msg error">Не получилось загрузить список: ${e.message}</div>`;
    }
  }

  // ==================== GROUPS + DIRECT MESSAGES ====================

  // ==================== ATTACHMENT CACHE + STORAGE BUCKET ROTATION ====================
  // Every account gets a 20MB quota for files/photos/voice messages it has
  // sent (tracked in the "user_uploads" table below). Once that's full,
  // sending a new attachment is blocked until the user clears their cache
  // from Settings. Separately — and independently of that per-user quota —
  // the actual storage objects are spread across 10 Supabase buckets
  // (chat-files, chat-files-1 … chat-files-9): the first bucket is filled
  // up to BUCKET_CAPACITY_BYTES, then uploads roll over to the next one,
  // and so on, tracked globally in site_settings.
  const CACHE_LIMIT_BYTES = 20 * 1024 * 1024; // 20MB per-user attachment cache
  const STORAGE_BUCKETS = ['chat-files','chat-files-1','chat-files-2','chat-files-3','chat-files-4','chat-files-5','chat-files-6','chat-files-7','chat-files-8','chat-files-9'];
  const BUCKET_CAPACITY_BYTES = 1024 * 1024 * 1024; // 1GB per bucket before rolling to the next of the 10

  /* Migration for the attachment cache / bucket-rotation feature:
     create table if not exists user_uploads (
       id uuid primary key default gen_random_uuid(),
       user_id uuid not null,
       bucket text not null,
       path text not null,
       size bigint not null,
       created_at timestamptz not null default now()
     );
     -- site_settings (already used for online_mode) also gets one more row,
     -- written automatically the first time someone uploads a file:
     --   key='storage_bucket_index'  value='0'..'9'
     -- (this is just a starting hint for which bucket to check first — the
     -- actual "is it full" decision is always made from Supabase Storage's
     -- real contents, see getBucketUsedBytes() below, so cache clean-ups
     -- genuinely free up room instead of a counter that only ever grows.)
     -- also create the 9 extra public storage buckets chat-files-1 … chat-files-9
     -- (chat-files itself should already exist), same settings as chat-files.
  */

  // Recursively lists every file inside a bucket (walking into userId
  // sub-folders, since uploads are stored as `${userId}/${filename}`) and
  // returns their real sizes from Storage metadata. Paginates in case a
  // folder ever holds more than 1000 objects.
  async function listAllBucketFiles(bucket, path = ''){
    let files = [];
    let offset = 0;
    const limit = 1000;
    while(true){
      let data;
      try{
        const res = await supabase.storage.from(bucket).list(path, { limit, offset });
        data = res.data;
      }catch(e){ break; }
      if(!data || data.length === 0) break;
      for(const entry of data){
        // Folders come back with id === null and no metadata.
        if(entry.id === null){
          const sub = await listAllBucketFiles(bucket, path ? `${path}/${entry.name}` : entry.name);
          files = files.concat(sub);
        }else{
          files.push({ path: path ? `${path}/${entry.name}` : entry.name, size: (entry.metadata && entry.metadata.size) || 0 });
        }
      }
      if(data.length < limit) break;
      offset += limit;
    }
    return files;
  }

  // Real (not estimated) number of bytes currently stored in a bucket,
  // read straight from Supabase Storage every time it's called.
  async function getBucketUsedBytes(bucket){
    const files = await listAllBucketFiles(bucket);
    return files.reduce((sum, f) => sum + f.size, 0);
  }

  // Picks which of the 10 storage buckets a new upload of `fileSize` bytes
  // should go into. Starts checking from the last known active bucket
  // (a hint saved in site_settings, just to avoid re-scanning buckets 0..N
  // every time) but the actual "is there room" check queries the bucket's
  // real current contents via getBucketUsedBytes(). This means a "Clean
  // data" wipe that frees space in the currently active bucket is picked
  // up immediately — no separate byte counter to keep in sync.
  async function getActiveStorageBucket(fileSize){
    let index = 0;
    try{
      const { data } = await supabase.from('site_settings').select('value').eq('key', 'storage_bucket_index').maybeSingle();
      if(data) index = parseInt(data.value, 10) || 0;
    }catch(e){}
    while(index < STORAGE_BUCKETS.length - 1){
      const used = await getBucketUsedBytes(STORAGE_BUCKETS[index]);
      if(used + fileSize <= BUCKET_CAPACITY_BYTES) break;
      index += 1;
    }
    try{
      await supabase.from('site_settings').upsert({ key: 'storage_bucket_index', value: String(index) });
    }catch(e){}
    return STORAGE_BUCKETS[index];
  }

  // Sum of everything a given user has personally sent (their 20MB quota).
  async function getUserCacheUsedBytes(userId){
    try{
      const { data } = await supabase.from('user_uploads').select('size').eq('user_id', userId);
      return (data||[]).reduce((sum, r) => sum + (r.size || 0), 0);
    }catch(e){ return 0; }
  }

  // Records one upload against the user's cache quota so it can be counted
  // and, later, deleted again via "Clean data" in Settings.
  async function logUserUpload(userId, bucket, path, size){
    try{ await supabase.from('user_uploads').insert({ user_id: userId, bucket, path, size }); }catch(e){}
  }

  // Shown when a send is blocked because the user's 20MB cache is full.
  // Auto-dismisses after 3 seconds; Cancel just closes it, Clear jumps to
  // Settings where the "Clean data" button lives.
  function showCacheFullWarning(usedBytes, fileSize){
    document.querySelectorAll('.cache-warn-overlay').forEach(el => el.remove());
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible cache-warn-overlay';
    overlay.innerHTML = `
      <div class="confirm-modal" style="max-width:320px;text-align:center;">
        <h3>Cache is full</h3>
        <p>Your 20MB attachment cache is full (${(usedBytes/1024/1024).toFixed(1)}MB / 20MB used). This file (${(fileSize/1024/1024).toFixed(1)}MB) can't be sent until you free up space.</p>
        <div style="display:flex;gap:10px;">
          <button class="acct-btn" id="cacheWarnCancel" style="flex:1;">Cancel</button>
          <button class="acct-btn" id="cacheWarnClear" style="flex:1;background:var(--tg-blue-deep);color:#fff;">Clear</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const dismiss = () => overlay.remove();
    const autoTimer = setTimeout(dismiss, 3000);
    overlay.querySelector('#cacheWarnCancel').addEventListener('click', () => { clearTimeout(autoTimer); dismiss(); });
    overlay.querySelector('#cacheWarnClear').addEventListener('click', () => { clearTimeout(autoTimer); dismiss(); renderSettingsView(); });
  }

  // Deletes every attachment this user has ever sent from Supabase Storage
  // (grouped by bucket, since each bucket needs its own .remove() call) and
  // wipes their user_uploads rows / quota back to 0. Messages themselves are
  // left untouched in the chat — their attachment_url will just stop
  // resolving, which is expected/known behaviour here.
  async function clearUserCacheData(userId){
    const { data: rows } = await supabase.from('user_uploads').select('bucket,path').eq('user_id', userId);
    const byBucket = {};
    (rows||[]).forEach(r => { (byBucket[r.bucket] = byBucket[r.bucket] || []).push(r.path); });
    for(const bucket of Object.keys(byBucket)){
      try{ await supabase.storage.from(bucket).remove(byBucket[bucket]); }catch(e){}
    }
    await supabase.from('user_uploads').delete().eq('user_id', userId);
  }

  function dmKeyFor(idA, idB){ return [idA, idB].sort().join('_'); }
  function timeAgoShort(iso){
    if(!iso) return '';
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs/60000);
    if(mins < 1) return 'сейчас';
    if(mins < 60) return mins+' мин';
    const hrs = Math.floor(mins/60);
    if(hrs < 24) return hrs+' ч';
    return Math.floor(hrs/24)+' дн';
  }
  function escapeHtmlChat(s){
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function linkify(text){
    const urlRe = /(https?:\/\/[^\s<]+)/g;
    return escapeHtmlChat(text).replace(urlRe, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  }
  function avatarHtml(name, url, sizeClass){
    const cls = 'avatar-circle' + (sizeClass ? ' '+sizeClass : '');
    if(url) return `<div class="${cls}"><img src="${url}" alt=""></div>`;
    const letter = (name||'?').trim().charAt(0).toUpperCase() || '?';
    return `<div class="${cls}">${letter}</div>`;
  }

  function requireLogin(container){
    if(currentUserId) return true;
    container.innerHTML = `<div class="auth-msg error" style="margin:14px;">Sign in to your account to use messages.</div>`;
    return false;
  }

  // Opens a full-screen, uncropped view of a chat image. The thumbnail in
  // the chat bubble is square (object-fit: cover), so this shows the whole
  // original photo instead, tapping/clicking the backdrop closes it.
  window.openImageLightbox = function(url){
    document.querySelectorAll('.img-lightbox-overlay').forEach(el => el.remove());
    const overlay = document.createElement('div');
    overlay.className = 'img-lightbox-overlay';
    overlay.innerHTML = `
      <button class="img-lightbox-close" title="Close">×</button>
      <img src="${url}" alt="">`;
    // Only tapping the backdrop (or the × button) closes it — tapping the
    // photo itself, like in Telegram, does nothing.
    overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.remove(); });
    overlay.querySelector('.img-lightbox-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('img').addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(overlay);
  };

  function makeOverlay(innerHtml, maxWidth){
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = `<div class="confirm-modal" style="max-width:${maxWidth||380}px;text-align:left;">${innerHtml}</div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
    return overlay;
  }

  // Small duration picker used by Mute/Ban — value + unit, or "Навсегда".
  // Calls onConfirm(ms) where ms is a duration in milliseconds, or null for permanent.
  function openDurationPicker(title, units, onConfirm){
    const overlay = makeOverlay(`
      <h3 style="margin:0 0 12px;font-size:1rem;">${escapeHtmlChat(title)}</h3>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;">
        <input type="number" id="durValue" min="1" value="10" class="field-input" style="width:100px;">
        <select id="durUnit" class="field-input" style="flex:1;">
          ${units.map(u=>`<option value="${u.mult}">${u.label}</option>`).join('')}
        </select>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin-bottom:16px;">
        <input type="checkbox" id="durPermanent"> Навсегда
      </label>
      <div style="display:flex;gap:10px;">
        <button class="acct-btn" id="durCancel" style="flex:1;">Отмена</button>
        <button class="acct-btn" id="durConfirm" style="flex:1;background:#c23a52;color:#fff;">Подтвердить</button>
      </div>
    `, 320);
    const permBox = document.getElementById('durPermanent');
    const valInput = document.getElementById('durValue');
    const unitSelect = document.getElementById('durUnit');
    permBox.addEventListener('change', () => {
      valInput.disabled = permBox.checked; unitSelect.disabled = permBox.checked;
    });
    document.getElementById('durCancel').addEventListener('click', () => overlay.remove());
    document.getElementById('durConfirm').addEventListener('click', () => {
      if(permBox.checked){ overlay.remove(); onConfirm(null); return; }
      const val = parseFloat(valInput.value) || 0;
      const mult = parseFloat(unitSelect.value);
      const ms = val * mult;
      if(ms <= 0){ alert('Укажи длительность больше нуля или выбери «Навсегда».'); return; }
      overlay.remove();
      onConfirm(ms);
    });
  }

  // Caches which user_ids are the site's admin/"Creator" account (profiles.is_admin),
  // refreshed at most once a minute, so every group chat can show a "Creator" badge.
  let creatorIdsCache = { ids: new Set(), fetchedAt: 0 };
  async function getCreatorIds(){
    if(Date.now() - creatorIdsCache.fetchedAt < 60000) return creatorIdsCache.ids;
    try{
      const { data } = await supabase.from('profiles').select('id').eq('is_admin', true);
      creatorIdsCache = { ids: new Set((data||[]).map(p => p.id)), fetchedAt: Date.now() };
    }catch(e){ /* profiles.is_admin not migrated yet */ }
    return creatorIdsCache.ids;
  }

  // Cache of sender_id -> avatar_url so chat bubbles can show the sender's
  // real profile photo (previously this was hardcoded to null, so photos
  // never appeared inside chats even though they were saved correctly).
  const senderAvatarCache = {};
  async function refreshSenderAvatars(userIds){
    const missing = [...new Set(userIds)].filter(id => id && !(id in senderAvatarCache));
    if(!missing.length) return;
    try{
      const { data } = await supabase.from('profiles').select('id,avatar_url').in('id', missing);
      (data||[]).forEach(p => { senderAvatarCache[p.id] = p.avatar_url || null; });
      missing.forEach(id => { if(!(id in senderAvatarCache)) senderAvatarCache[id] = null; });
    }catch(e){ /* stay quiet — bubbles just fall back to initials */ }
  }

  // Records mute/ban/kick actions for the site-wide moderation log (visible
  // to the Creator in "All Reports"). Silently no-ops if the table isn't
  // migrated yet.
  async function logModAction(action, targetUserId, targetUsername, groupId, groupName, details){
    try{
      await supabase.from('moderation_log').insert({
        actor_id: currentUserId, actor_username: currentUsername,
        action, target_user_id: targetUserId, target_username: targetUsername,
        group_id: groupId, group_name: groupName, details: details || ''
      });
    }catch(e){ /* moderation_log table not migrated yet */ }
  }

  // ============ Admin Console (/ban /unban /mute /unmute /pm) ============
  // Duration parser — accepts compact tokens like "1d2h30m10s" or a single
  // unit like "2h", using d/h/m/s (day/hour/min/sec). Returns milliseconds
  // or null if nothing recognizable was found.
  function parseDuration(str){
    if(!str) return null;
    const re = /(\d+)\s*(d(?:ays?)?|h(?:ours?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)/gi;
    let ms = 0, found = false, match;
    while((match = re.exec(str))){
      found = true;
      const val = parseInt(match[1], 10);
      const unit = match[2][0].toLowerCase();
      if(unit === 'd') ms += val * 86400000;
      else if(unit === 'h') ms += val * 3600000;
      else if(unit === 'm') ms += val * 60000;
      else if(unit === 's') ms += val * 1000;
    }
    return found ? ms : null;
  }
  function fmtDuration(ms){
    const d = Math.floor(ms/86400000); ms -= d*86400000;
    const h = Math.floor(ms/3600000); ms -= h*3600000;
    const m = Math.floor(ms/60000); ms -= m*60000;
    const s = Math.floor(ms/1000);
    return [d&&`${d}d`, h&&`${h}h`, m&&`${m}m`, s&&`${s}s`].filter(Boolean).join(' ') || '0s';
  }

  async function findUserByUsername(username){
    const { data } = await supabase.from('profiles').select('id,username').ilike('username', username).maybeSingle();
    return data;
  }
  async function consoleBan(username, durationStr, groupName){
    const target = await findUserByUsername(username);
    if(!target) return `Пользователь "${username}" не найден.`;
    const ms = parseDuration(durationStr);
    if(!ms) return 'Некорректный формат времени. Пример: 1d2h30m или 45m';
    const until = new Date(Date.now()+ms).toISOString();
    await supabase.from('profiles').update({ banned_until: until }).eq('id', target.id);
    logModAction('ban', target.id, target.username, null, null, `сайт, console: ${fmtDuration(ms)}`);
    return `${target.username} забанен на сайте на ${fmtDuration(ms)} (до ${new Date(until).toLocaleString('ru')}).`;
  }

  async function consoleUnban(username){
    const target = await findUserByUsername(username);
    if(!target) return `Пользователь "${username}" не найден.`;
    await supabase.from('profiles').update({ banned_until: null }).eq('id', target.id);
    logModAction('unban', target.id, target.username, null, null, 'console: все баны сняты');
    return `Бан для ${target.username} снят.`;
  }

  async function consolePm(username, message){
    const target = await findUserByUsername(username);
    if(!target) return `Пользователь "${username}" не найден.`;
    try{
      await supabase.from('admin_broadcasts').insert({ target_user_id: target.id, message, delivered: false });
    }catch(e){ return 'Не удалось отправить (нужна таблица admin_broadcasts): '+e.message; }
    return `Сообщение отправлено ${target.username}. Появится по центру экрана независимо от того, где он находится.`;
  }

  async function runConsoleCommand(raw){
    const trimmed = raw.trim();
    if(!trimmed.startsWith('/')) return 'Команда должна начинаться с /. Доступно: /ban /unban /pm';
    if(/^\/pm\s/i.test(trimmed)){
      const m = trimmed.match(/^\/pm\s+(\S+)\s+([\s\S]+)$/i);
      if(!m) return 'Использование: /pm ник сообщение';
      return await consolePm(m[1], m[2]);
    }
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    try{
      if(cmd === '/ban'){
        if(parts.length < 3) return 'Использование: /ban ник время';
        return await consoleBan(parts[1], parts[2], null);
      }
      if(cmd === '/unban'){
        if(parts.length < 2) return 'Использование: /unban ник';
        return await consoleUnban(parts[1]);
      }
      return `Неизвестная команда: ${cmd}. Доступно: /ban /unban /pm`;
    }catch(e){ return 'Ошибка: '+e.message; }
  }

  function openAdminConsole(){
    if(!isAdmin()) return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = `
      <div class="console-modal">
        <h3>&gt; ADMIN CONSOLE</h3>
        <div class="console-log" id="consoleLog"></div>
        <div class="console-input-row">
          <span>&gt;</span>
          <input type="text" id="consoleInput" placeholder="/ban user 1d2h ..." autocomplete="off">
        </div>
        <div class="console-help">
          /ban ник время · /unban ник · /pm ник сообщение<br>
          Время: комбинация d/h/m/s, например 1d2h30m
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
    const log = overlay.querySelector('#consoleLog');
    const input = overlay.querySelector('#consoleInput');
    function print(text, cls){
      const line = document.createElement('div');
      line.className = cls || 'cl-out';
      line.textContent = text;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    }
    print('Console ready. Type a command below.', 'cl-out');
    input.addEventListener('keydown', async (e) => {
      if(e.key !== 'Enter') return;
      const raw = input.value;
      if(!raw.trim()) return;
      input.value = '';
      print('> ' + raw, 'cl-cmd');
      const result = await runConsoleCommand(raw);
      print(result, /не найден|Ошибка|Использование|Некорректн|Неизвестная|нет группы/i.test(result) ? 'cl-err' : 'cl-out');
    });
    input.focus();
  }

  // ---- /pm broadcasts: shown centered, regardless of what screen the
  // person is currently on (Reading, Listening, chats, anywhere). ----
  async function pollAdminBroadcasts(){
    if(!currentUserId) return;
    try{
      const { data } = await supabase.from('admin_broadcasts').select('*').eq('target_user_id', currentUserId).eq('delivered', false).order('created_at', { ascending:true }).limit(1);
      const msg = data && data[0];
      if(!msg) return;
      await supabase.from('admin_broadcasts').update({ delivered: true }).eq('id', msg.id);
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay visible';
      overlay.innerHTML = `
        <div class="confirm-modal" style="max-width:360px;text-align:center;">
          <div style="font-size:1.6rem;margin-bottom:8px;">📩</div>
          <h3 style="margin:0 0 10px;font-size:1rem;">Сообщение от администрации</h3>
          <div style="font-size:.9rem;line-height:1.5;margin-bottom:16px;">${escapeHtmlChat(msg.message)}</div>
          <button class="acct-btn" id="pmCloseBtn" style="width:100%;background:var(--btn);color:#fff;">OK</button>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('#pmCloseBtn').addEventListener('click', () => overlay.remove());
    }catch(e){ /* admin_broadcasts table not migrated yet */ }
  }

  async function countMessages(filterFn){
    const q = filterFn(supabase.from('messages').select('id', { count: 'exact', head: true }));
    const res = await q;
    return res.count || 0;
  }

  async function computeTotalUnread(){
    if(!currentUserId) return 0;
    let total = 0;
    const { data: reads } = await supabase.from('dm_reads').select('dm_key,last_read_at').eq('user_id', currentUserId);
    for(const r of (reads || [])){
      total += await countMessages(q => q.eq('dm_key', r.dm_key).neq('sender_id', currentUserId).gt('created_at', r.last_read_at || '1970-01-01'));
    }
    return total;
  }

  const groupFab = document.getElementById('groupFab');
  const groupFullscreen = document.getElementById('groupFullscreen');
  const gfsBody = document.getElementById('gfsBody');
  const gfsTitle = document.getElementById('gfsTitle');
  const gfsCloseBtn = document.getElementById('gfsCloseBtn');
  const gfsMenuBtn = document.getElementById('gfsMenuBtn');
  const gfsExtraActions = document.getElementById('gfsExtraActions');
  const groupSideMenu = document.getElementById('groupSideMenu');
  const groupSideMenuOverlay = document.getElementById('groupSideMenuOverlay');
  let gfsView = 'list'; // 'list' | 'chat' | 'settings' | 'findpeople'

  function fillAvatarEl(el, name, url){
    if(!el) return;
    if(url){ el.innerHTML = `<img src="${url}" alt="">`; }
    else{ el.textContent = (name||'?').trim().charAt(0).toUpperCase() || '?'; }
  }
  function openSideMenu(){
    fillAvatarEl(document.getElementById('gsmAvatar'), currentUsername, window.currentUserAvatarUrl);
    document.getElementById('gsmName').textContent = currentUsername || '—';
    document.getElementById('gsmSub').textContent = currentUsername ? ('@'+currentUsername) : 'guest';
    groupSideMenu.classList.add('open');
    groupSideMenuOverlay.classList.add('open');
  }
  function closeSideMenu(){
    groupSideMenu.classList.remove('open');
    groupSideMenuOverlay.classList.remove('open');
  }
  gfsMenuBtn.addEventListener('click', openSideMenu);
  groupSideMenuOverlay.addEventListener('click', closeSideMenu);
  try{
    document.getElementById('gsmProfileRow').addEventListener('click', () => { closeSideMenu(); renderSettingsView(); });
    document.getElementById('gsmFindPeople').addEventListener('click', () => { closeSideMenu(); renderFindPeopleView(); });
    document.getElementById('gsmSavedMessages').addEventListener('click', () => {
      closeSideMenu();
      if(!currentUserId){ alert('Sign in to your account first.'); return; }
      groupFullscreen.classList.add('open');
      openDmChat(currentUserId, currentUsername + ' (Saved Messages)');
    });
    document.getElementById('gsmInviteFriends').addEventListener('click', () => {
      closeSideMenu();
      if(!currentUserId){ alert('Sign in to your account first.'); return; }
      if(navigator.share){
        navigator.share({ title: 'WRAITH ENGLISH', text: 'Join me on WRAITH ENGLISH', url: location.href.split('#')[0] }).catch(()=>{});
      } else if(navigator.clipboard){
        navigator.clipboard.writeText(location.href.split('#')[0]);
        alert('Ссылка на приложение скопирована — отправь её другу.');
      }
    });
    document.getElementById('gsmSettings').addEventListener('click', () => { closeSideMenu(); renderSettingsView(); });
    document.getElementById('gsmHelp').addEventListener('click', () => {
      closeSideMenu();
      const overlay = makeOverlay(`
        <h3 style="margin:0 0 10px;font-size:1.05rem;">Help &amp; FAQ</h3>
        <div style="font-size:.86rem;line-height:1.5;color:var(--text-dim);">
          <b>Как написать человеку?</b> Меню → Find People → выбери человека.<br><br>
          <b>Как сохранить заметку себе?</b> Меню → Saved Messages.<br><br>
          <b>Прогресс в Reading/Listening не сохраняется?</b> Обновление уже это чинит — жми Save при выходе.
        </div>
        <button class="acct-btn" id="helpCloseBtn" style="margin-top:16px;width:100%;">Закрыть</button>
      `, 360);
      document.getElementById('helpCloseBtn').addEventListener('click', () => overlay.remove());
    });
  }catch(e){ console.error('Group side menu wiring failed:', e); }

  gfsCloseBtn.addEventListener('click', () => {
    if(gfsView === 'list'){
      groupFullscreen.classList.remove('open');
    } else {
      renderChatListView();
    }
  });

  async function updateGroupUnreadBadge(){
    if(document.hidden) return; // don't poll while the tab is in the background
    const badgeEl = document.getElementById('groupUnreadBadge');
    const sideBadgeEl = document.getElementById('sidebarGroupsBadge');
    if(!currentUserId){
      if(badgeEl) badgeEl.style.display = 'none';
      if(sideBadgeEl) sideBadgeEl.style.display = 'none';
      return;
    }
    try{
      const total = await computeTotalUnread();
      const text = total > 99 ? '99+' : String(total);
      if(badgeEl){ badgeEl.textContent = text; badgeEl.style.display = total>0 ? 'inline-block' : 'none'; }
      if(sideBadgeEl){ sideBadgeEl.textContent = text; sideBadgeEl.style.display = total>0 ? 'inline-block' : 'none'; }
    }catch(e){ /* stay quiet — table may not exist yet */ }
  }

  groupFab.addEventListener('click', () => {
    groupFullscreen.classList.add('open');
    renderChatListView();
  });
  try{
    document.getElementById('sidebarGroupsCard').addEventListener('click', () => {
      groupFullscreen.classList.add('open');
      renderChatListView();
    });
  }catch(e){ console.error('Sidebar groups card wiring failed:', e); }
  updateGroupUnreadBadge();
  setInterval(updateGroupUnreadBadge, 30000);

  // ---------- Chat list (home screen) ----------
  async function renderChatListView(){
    gfsView = 'list';
    gfsTitle.textContent = 'Chats';
    if(gfsExtraActions) gfsExtraActions.innerHTML = '';
    gfsBody.classList.remove('chat-mode');
    gfsBody.style.position = 'relative';
    gfsBody.innerHTML = '<div style="padding:16px;color:var(--text-dim);">Загрузка…</div>';
    if(!requireLogin(gfsBody)) return;

    // Safe wrapper: a single missing table/column or RLS error must never
    // kill the whole list — before, one failed query left the "Загрузка…"
    // spinner stuck forever and NOTHING (chats or groups) ever rendered.
    const safe = async (promise, fallback) => {
      try{ const { data, error } = await promise; if(error) throw error; return data; }
      catch(e){ console.warn('chat list query failed, continuing without it:', e.message || e); return fallback; }
    };
    const safeCount = async (filterFn) => {
      try{ return await countMessages(filterFn); }
      catch(e){ console.warn('chat list unread count failed, continuing without it:', e.message || e); return 0; }
    };

    let items = [];
    try{
      const safeArr = async (promise) => (await safe(promise, [])) || [];

      // Step 1: figure out which groups/DMs the user is even part of.
      // The dm_key probe is filtered to dm_keys that actually contain this
      // user's id (dm_key is "idA_idB" sorted, so it's always a prefix or a
      // suffix match) instead of just grabbing the 500 most-recent messages
      // across the WHOLE table. That old approach meant any DM you hadn't
      // been active in recently could get crowded out of the top-500 by
      // totally unrelated traffic from other people's chats and silently
      // vanish from your chat list — this scopes the query to you, so every
      // DM you're actually part of gets found regardless of how much other
      // people are chatting.
      const dmKeyProbe = await safeArr(supabase.from('messages').select('dm_key')
        .or(`dm_key.ilike.${currentUserId}_%,dm_key.ilike.%_${currentUserId}`)
        .order('created_at',{ascending:false}).limit(3000));
      const myDmKeys = [...new Set(dmKeyProbe.map(m=>m.dm_key).filter(k => k && k.split('_').includes(currentUserId)))];
      const otherIds = myDmKeys.map(k => k.split('_').find(id => id!==currentUserId));

      // Step 2: fetch everything else in ONE parallel batch instead of
      // looping per-chat — this is what made the list slow before (a
      // sequential round trip per group/DM). Last message + unread count
      // are now computed client-side from these bulk results.
      const [otherProfiles, dmReads, dmMsgs] = await Promise.all([
        otherIds.length ? safeArr(supabase.from('profiles').select('id,username,avatar_url').in('id', otherIds)) : [],
        myDmKeys.length ? safeArr(supabase.from('dm_reads').select('dm_key,last_read_at').eq('user_id', currentUserId).in('dm_key', myDmKeys)) : [],
        myDmKeys.length ? safeArr(supabase.from('messages').select('dm_key,sender_id,body,created_at').in('dm_key', myDmKeys).order('created_at',{ascending:false}).limit(2000)) : []
      ]);

      const dmLast = {};
      for(const m of dmMsgs){ if(!(m.dm_key in dmLast)) dmLast[m.dm_key] = m; }
      const dmReadMap = {};
      for(const r of dmReads){ dmReadMap[r.dm_key] = r.last_read_at; }

      for(const key of myDmKeys){
        const otherId = key.split('_').find(id=>id!==currentUserId);
        const prof = otherProfiles.find(p=>p.id===otherId);
        if(!prof) continue;
        const cutoff = dmReadMap[key] || '1970-01-01';
        const unread = dmMsgs.filter(m => m.dm_key===key && m.sender_id!==currentUserId && m.created_at > cutoff).length;
        const lastMsg = dmLast[key];
        items.push({ type:'dm', id: otherId, name: prof.username, avatar_url: prof.avatar_url, unread,
          lastBody: lastMsg ? lastMsg.body : 'Нет сообщений', lastAt: lastMsg ? lastMsg.created_at : '1970-01-01' });
      }
      items.sort((a,b) => new Date(b.lastAt) - new Date(a.lastAt));
    }catch(e){
      console.error('renderChatListView failed:', e);
      gfsBody.innerHTML = `<div style="padding:30px 16px;text-align:center;color:var(--text-dim);">Не удалось загрузить чаты.<br><span style="font-size:12px;opacity:.7;">${escapeHtmlChat(e.message||String(e))}</span><br><button id="retryChatListBtn" style="margin-top:12px;padding:8px 16px;border-radius:8px;border:none;background:var(--accent,#3d5bef);color:#fff;">Повторить</button></div>`;
      const retryBtn = document.getElementById('retryChatListBtn');
      if(retryBtn) retryBtn.addEventListener('click', renderChatListView);
      return;
    }

    gfsBody.innerHTML = `
      <div id="chatListRows">
        ${items.length ? items.map(it => `
          <div class="chat-list-row" data-type="${it.type}" data-id="${it.id}">
            ${avatarHtml(it.name, it.avatar_url)}
            <div class="clr-text">
              <div class="clr-name">${escapeHtmlChat(it.name)}</div>
              <div class="clr-preview">${escapeHtmlChat(it.lastBody).replace(/<[^>]+>/g,'').slice(0,60)}</div>
            </div>
            ${it.unread>0 ? `<div class="pr-unread">${it.unread>99?'99+':it.unread}</div>` : ''}
          </div>`).join('') : '<div style="padding:30px 10px;text-align:center;color:var(--text-dim);">Пока нет чатов — открой меню (☰) → Find People и напиши кому-нибудь</div>'}
      </div>
    `;
    gfsBody.querySelectorAll('.chat-list-row').forEach(row => {
      row.addEventListener('click', () => {
          const it = items.find(x=>x.type==='dm' && x.id===row.dataset.id);
          if(it) openDmChat(it.id, it.name);
      });
    });
  }

  // ---------- Find people ----------
  function renderFindPeopleView(){
    gfsView = 'findpeople';
    gfsTitle.textContent = 'Find People';
    if(gfsExtraActions) gfsExtraActions.innerHTML = '';
    gfsBody.classList.remove('chat-mode');
    groupFullscreen.classList.add('open');
    gfsBody.innerHTML = `
      <input type="text" class="field-input" id="fpInput" placeholder="Введи ник…" style="margin-bottom:12px;">
      <div id="fpResults"></div>
    `;
    if(!requireLogin(gfsBody)) return;
    let t = null;
    document.getElementById('fpInput').addEventListener('input', e => {
      clearTimeout(t);
      const q = e.target.value.trim();
      if(!q){ document.getElementById('fpResults').innerHTML=''; return; }
      t = setTimeout(async () => {
        const { data } = await supabase.from('profiles').select('id,username,avatar_url').ilike('username', q+'%').limit(15);
        const el = document.getElementById('fpResults');
        const results = (data||[]).filter(p=>p.id!==currentUserId);
        el.innerHTML = results.length ? results.map(p => `
          <div class="chat-list-row" data-uid="${p.id}" data-uname="${escapeHtmlChat(p.username)}">
            ${avatarHtml(p.username, p.avatar_url)}
            <div class="clr-text"><div class="clr-name">${escapeHtmlChat(p.username)}</div></div>
          </div>`).join('') : '<div style="padding:14px;color:var(--text-dim);">Никого не найдено</div>';
        el.querySelectorAll('.chat-list-row').forEach(row => {
          row.addEventListener('click', () => openDmChat(row.dataset.uid, row.dataset.uname));
        });
      }, 300);
    });
  }

  // ---------- Settings ----------
  async function renderSettingsView(){
    gfsView = 'settings';
    gfsTitle.textContent = 'Settings';
    if(gfsExtraActions) gfsExtraActions.innerHTML = '';
    gfsBody.classList.remove('chat-mode');
    groupFullscreen.classList.add('open');
    gfsBody.innerHTML = `<div style="padding:16px;color:var(--text-dim);">Загрузка…</div>`;
    if(!requireLogin(gfsBody)) return;

    const { data: profile } = await supabase.from('profiles').select('avatar_url,show_last_seen').eq('id', currentUserId).maybeSingle();

    gfsBody.innerHTML = `
      <div class="settings-section">
        <h4>Profile</h4>
        <div class="avatar-upload-wrap">
          ${avatarHtml(currentUsername, profile && profile.avatar_url, 'lg')}
          <div>
            <label class="avatar-upload-btn" for="avatarFileInput">Change photo</label>
            <input type="file" id="avatarFileInput" accept="image/*">
          </div>
        </div>
        <div class="settings-row"><span>Username</span><b>${escapeHtmlChat(currentUsername)}</b></div>
      </div>
      ${isAdmin() ? `
      <div class="settings-section">
        <h4>Ghost Mode</h4>
        <div class="settings-row" id="ghostModeRow" style="cursor:pointer;">
          <span>👻 ${ghostMode ? 'Ghost mode: ON' : 'Ghost mode: off'}</span>
          <span style="color:${ghostMode ? '#c23a52' : 'var(--tg-blue-deep)'};font-weight:700;">${ghostMode ? 'Turn off' : 'Turn on'}</span>
        </div>
        <div style="font-size:.76rem;color:var(--text-dim);margin-top:6px;line-height:1.4;">
          Пока включено: ты не отображаешься в списке "в сети", твой last seen скрыт, и открытые тобой сообщения не отмечаются как прочитанные у отправителя.
        </div>
      </div>
      <div class="settings-section">
        <h4>Admin</h4>
        <button class="console-btn" id="openConsoleBtn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Console
        </button>
      </div>` : ''}
      <div class="settings-section">
        <h4>Privacy</h4>
        <div class="settings-row">
          <span>Show last seen to others</span>
          <label class="switch">
            <input type="checkbox" id="lastSeenToggle" ${(!profile || profile.show_last_seen !== false) ? 'checked' : ''}>
            <span class="switch-track"></span>
          </label>
        </div>
      </div>
      <div class="settings-section">
        <h4>Chat settings</h4>
        <div class="settings-row"><span>Notifications</span>
          <label class="switch"><input type="checkbox" id="notifToggle" checked><span class="switch-track"></span></label>
        </div>
        <div class="settings-row"><span>Auto-play attachments</span>
          <label class="switch"><input type="checkbox" id="autoplayToggle" checked><span class="switch-track"></span></label>
        </div>
      </div>
      <div class="settings-section">
        <h4>Data &amp; storage</h4>
        <div class="settings-row" id="clearCacheRow" style="cursor:pointer;">
          <span>Clear locally cached tool progress</span>
          <span style="color:var(--tg-blue-deep);font-weight:700;">Clear</span>
        </div>
        <div class="settings-row"><span>Attachment cache</span><b id="cacheUsageText">—</b></div>
        <div class="settings-row" id="cleanCacheDataRow" style="cursor:pointer;">
          <span>Clean data</span>
          <span style="color:#c23a52;font-weight:700;">Clean</span>
        </div>
      </div>
    `;


    document.getElementById('avatarFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if(!file) return;
      const ext = file.name.split('.').pop();
      const path = `${currentUserId}/avatar.${ext}`;
      try{
        const { error: upErr } = await supabase.storage.from('avatars').upload(path, file, { upsert: true });
        if(upErr){ alert('Ошибка загрузки: '+upErr.message); return; }
        const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);
        const url = pub.publicUrl + '?t=' + Date.now();
        await supabase.from('profiles').update({ avatar_url: url }).eq('id', currentUserId);
        window.currentUserAvatarUrl = url;
        renderSettingsView();
      }catch(err){ alert('Ошибка: '+err.message); }
    });
    if(isAdmin()){
      const ghostRow = document.getElementById('ghostModeRow');
      if(ghostRow) ghostRow.addEventListener('click', async () => {
        ghostMode = !ghostMode;
        localStorage.setItem('ghostMode', ghostMode ? '1' : '0');
        await sendHeartbeat(); // immediately drop/re-add presence row instead of waiting for the next tick
        renderSettingsView();
      });
      const consoleBtn = document.getElementById('openConsoleBtn');
      if(consoleBtn) consoleBtn.addEventListener('click', openAdminConsole);
    }
    document.getElementById('lastSeenToggle').addEventListener('change', async (e) => {
      await supabase.from('profiles').update({ show_last_seen: e.target.checked }).eq('id', currentUserId);
    });
    document.getElementById('clearCacheRow').addEventListener('click', () => {
      if(!confirm('Очистить локально сохранённый прогресс Reading/Listening/Writing на этом устройстве?')) return;
      try{
        Object.keys(localStorage).filter(k => k.startsWith('toolProgress:')).forEach(k => localStorage.removeItem(k));
        alert('Готово.');
      }catch(e){ alert('Ошибка: '+e.message); }
    });

    // Attachment cache usage (20MB quota) + "Clean data" button.
    const cacheUsageEl = document.getElementById('cacheUsageText');
    function refreshCacheUsageDisplay(){
      getUserCacheUsedBytes(currentUserId).then(used => {
        if(cacheUsageEl) cacheUsageEl.textContent = (used/1024/1024).toFixed(1) + 'MB / 20MB';
      });
    }
    refreshCacheUsageDisplay();
    document.getElementById('cleanCacheDataRow').addEventListener('click', () => {
      const overlay = makeOverlay(`
        <h3 style="margin:0 0 10px;font-size:1rem;">Delete data?</h3>
        <p style="font-size:.86rem;color:var(--text-dim);line-height:1.5;margin-bottom:18px;">Are you sure you want to delete data? This removes every file/photo/voice message you've sent from storage and frees your 20MB cache. Messages will stay in the chat.</p>
        <div style="display:flex;gap:10px;">
          <button class="acct-btn" id="cacheCleanCancel" style="flex:1;">Cancel</button>
          <button class="acct-btn" id="cacheCleanConfirm" style="flex:1;background:#c23a52;color:#fff;">Confirm</button>
        </div>
      `, 340);
      document.getElementById('cacheCleanCancel').addEventListener('click', () => overlay.remove());
      document.getElementById('cacheCleanConfirm').addEventListener('click', async () => {
        overlay.remove();
        try{
          await clearUserCacheData(currentUserId);
          refreshCacheUsageDisplay();
        }catch(e){ alert('Ошибка: '+e.message); }
      });
    });

  }

  // ---------- Direct messages ----------
  async function openDmChat(otherId, otherUsername){
    gfsView = 'chat';
    groupFullscreen.classList.add('open');
    gfsTitle.textContent = otherUsername;
    if(gfsExtraActions) gfsExtraActions.innerHTML = '';
    gfsBody.classList.add('chat-mode');
    const dmKey = dmKeyFor(currentUserId, otherId);
    gfsBody.innerHTML = `
      <div class="chat-window">
        <div id="pinnedBanner"></div>
        <div class="chat-messages" id="chatMessages">Загрузка…</div>
        <div class="typing-indicator" id="typingIndicator"></div>
        <div id="uploadProgressBar"></div>
        <div id="replyBar"></div>
        <div class="chat-input-row">
          <button class="chat-attach-btn" id="chatAttachBtn" title="Прикрепить файл">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <button class="chat-attach-btn" id="chatVoiceBtn" title="Голосовое сообщение">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg>
          </button>
          <input type="file" id="chatFileInput" style="display:none;">
          <input type="text" id="chatInput" placeholder="Сообщение…" maxlength="500" enterkeyhint="send">
          <button id="chatSendBtn">→</button>
        </div>
      </div>
    `;
    replyTarget = null; editTarget = null;
    if(!ghostMode) await supabase.from('dm_reads').upsert({ dm_key: dmKey, user_id: currentUserId, last_read_at: new Date().toISOString() });
    updateGroupUnreadBadge();

    let lastMsgs = [];
    let otherLastRead = null;
    const ctx = {
      reload: () => loadMessages(),
      get otherLastRead(){ return otherLastRead; },
      canReport: true,
      avatarFor: (uid) => senderAvatarCache[uid] || null,
      onReport: async (m) => {
        const reason = prompt('Причина жалобы (сообщение будет переслано владельцу сайта):');
        if(reason === null) return;
        try{
          await supabase.from('message_reports').insert({
            dm_key: dmKey, message_id: m.id, message_body: m.body,
            reporter_id: currentUserId, reporter_username: currentUsername, reason, status: 'pending'
          });
          alert('Жалоба отправлена.');
        }catch(e){ alert('Не удалось отправить жалобу (нужна таблица message_reports с колонкой dm_key): '+e.message); }
      }
    };
    let lastRenderSig = null;
    async function loadMessages(){
      const { data } = await supabase.from('messages').select('*').eq('dm_key', dmKey).order('created_at', { ascending:true }).limit(200);
      lastMsgs = data || [];
      await refreshSenderAvatars(lastMsgs.map(m => m.sender_id));
      try{
        const { data: readRow } = await supabase.from('dm_reads').select('last_read_at').eq('dm_key', dmKey).eq('user_id', otherId).maybeSingle();
        otherLastRead = readRow ? readRow.last_read_at : null;
      }catch(e){ otherLastRead = null; }
      const wrap = document.getElementById('chatMessages');
      if(!wrap) return;
      // otherLastRead is folded into the signature too (not just the
      // messages themselves) so the read-receipt ticks still update live
      // even on a poll tick where no message actually changed.
      const sig = messagesRenderSignature(lastMsgs) + '\u0003' + (otherLastRead || '');
      if(sig !== lastRenderSig){
        wrap.innerHTML = lastMsgs.map(m => renderBubble(m, ctx)).join('');
        wrap.scrollTop = wrap.scrollHeight;
        wireBubbleEvents(wrap, lastMsgs, ctx);
        lastRenderSig = sig;
      }
    }
    await loadMessages();
    const typingScopeKey = 'd_' + dmKey;
    // Realtime push for instant delivery — filtering by dm_key directly in
    // Postgres changes isn't reliable across supabase-js versions for
    // arbitrary text columns, so we listen broadly and just re-fetch this
    // conversation whenever any message lands; loadMessages() itself is
    // cheap (scoped query) so this stays fast.
    const realtimeChannel = supabase
      .channel('dm_messages_' + dmKey)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `dm_key=eq.${dmKey}` }, () => { loadMessages(); })
      .subscribe();
    const poll = setInterval(async () => {
      if(gfsView !== 'chat' || !groupFullscreen.classList.contains('open')){ clearInterval(poll); supabase.removeChannel(realtimeChannel); return; }
      await loadMessages();
      if(!ghostMode) await supabase.from('dm_reads').upsert({ dm_key: dmKey, user_id: currentUserId, last_read_at: new Date().toISOString() });
      try{
        const cutoff = new Date(Date.now() - 5000).toISOString();
        const { data: typers } = await supabase.from('typing_status').select('user_id').eq('scope_key', typingScopeKey).gt('updated_at', cutoff);
        const otherTyping = (typers||[]).some(t => t.user_id === otherId);
        const indEl = document.getElementById('typingIndicator');
        if(indEl) indEl.textContent = otherTyping ? (otherUsername + ' печатает…') : '';
      }catch(e){ /* typing_status table may not be migrated yet */ }
    }, 2000);

    setupChatSendHandlers(
      async (body, attachment, reply) => {
        const base = {
          dm_key: dmKey, sender_id: currentUserId, sender_username: currentUsername, body,
          attachment_url: attachment ? attachment.url : null,
          attachment_type: attachment ? attachment.type : null,
          attachment_name: attachment ? attachment.name : null
        };
        const extra = buildReplyExtra(reply);
        const tempId = 'temp_'+Date.now()+Math.random();
        const tempMsg = Object.assign({ id: tempId, created_at: new Date().toISOString() }, base, extra);
        lastMsgs.push(tempMsg);
        const wrap = document.getElementById('chatMessages');
        if(wrap){ wrap.insertAdjacentHTML('beforeend', renderBubble(tempMsg, ctx)); wrap.scrollTop = wrap.scrollHeight; }
        const result = await insertMessageWithFallback(base, extra);
        if(!result.success){
          lastMsgs = lastMsgs.filter(m => m.id !== tempId);
          const bubbleEl = wrap && wrap.querySelector(`[data-msgid="${tempId}"]`);
          if(bubbleEl) bubbleEl.outerHTML = `<div class="msg-bubble msg-failed" style="color:#e05a5a;font-size:12px;text-align:center;padding:6px;">Не удалось отправить: ${escapeHtmlChat(result.error ? result.error.message : 'ошибка')}</div>`;
          return;
        }
        await loadMessages();
      },
      async (target, newBody) => {
        try{ await supabase.from('messages').update({ body: newBody, edited_at: new Date().toISOString() }).eq('id', target.id); }
        catch(e){ console.error('edit failed (needs an "edited_at" column on messages)', e); }
        await loadMessages();
      },
      { scopeKey: typingScopeKey }
    );
  }

  // ---------- Shared chat bubble + send/upload wiring ----------
  const MESSAGE_EMOJIS = ['❤️','👍','👎','😂','😮','😢','🔥','🎉','🙏','👏','💯','🤔','😍','😡','🤯','😴'];
  let replyTarget = null;
  let editTarget = null;

  // A cheap fingerprint of everything a re-render of the message list would
  // actually change on screen (which messages exist, their body/edit/delete
  // state, reactions, attachment). The 2s poll in each chat calls this and
  // skips wiping+rebuilding the DOM when nothing changed — without it, a
  // playing voice message (or the loading ring on one still buffering) got
  // torn down and restarted every 2 seconds since the whole message list
  // was replaced wholesale on every poll tick.
  function messagesRenderSignature(msgs){
    return (msgs || []).map(m => [
      m.id, m.deleted_at || '', m.edited_at || '', m.body || '',
      m.attachment_url || '', JSON.stringify(m.reactions || {})
    ].join('\u0001')).join('\u0002');
  }

  function formatMsgTime(ts){
    try{ return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
    catch(e){ return ''; }
  }

  function formatVoiceTime(sec){
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  // Builds the markup for a voice message bubble: a round button that shows
  // a buffering ring with an × in the middle while the clip loads, and
  // flips to a ▶/❚❚ once it's ready — plus a waveform and duration, same as
  // Telegram. Actual behavior (buffering progress, play/pause, live
  // waveform fill) is wired up by wireVoiceMessages() after the bubble is
  // in the DOM.
  const VOICE_RING_CIRC = 2 * Math.PI * 14.5;
  function renderVoiceAttachment(url){
    const bars = Array.from({ length: 26 }, () => 5 + Math.floor(Math.random() * 17));
    const barsHtml = bars.map(h => `<span style="height:${h}px"></span>`).join('');
    return `
      <div class="voice-msg" data-voice-url="${escapeHtmlChat(url)}">
        <button type="button" class="voice-msg-btn" data-voice-state="loading" title="Загрузка…">
          <svg class="voice-ring" viewBox="0 0 34 34">
            <circle class="track" cx="17" cy="17" r="14.5"></circle>
            <circle class="fill" cx="17" cy="17" r="14.5" stroke-dasharray="${VOICE_RING_CIRC}" stroke-dashoffset="${VOICE_RING_CIRC}"></circle>
          </svg>
          <span class="voice-msg-icon">✕</span>
        </button>
        <div class="voice-msg-wave">${barsHtml}</div>
        <span class="voice-msg-time">0:00</span>
      </div>`;
  }

  // Wires every not-yet-wired .voice-msg box found under `wrap`: tracks
  // real download/buffering progress on the loading ring (× in the center,
  // fills as it loads — same idea as the upload ring used while sending),
  // switches to a play/pause button once it can play through, and animates
  // the waveform + countdown while playing. Only one voice message plays at
  // a time. Guarded by data-voice-wired so a bubble that's already playing
  // doesn't get torn down and restarted by the next poll re-render.
  function wireVoiceMessages(wrap){
    wrap.querySelectorAll('.voice-msg').forEach(box => {
      if(box.dataset.voiceWired) return;
      box.dataset.voiceWired = '1';
      const url = box.dataset.voiceUrl;
      const btn = box.querySelector('.voice-msg-btn');
      const icon = btn.querySelector('.voice-msg-icon');
      const ringFill = box.querySelector('.voice-ring .fill');
      const timeEl = box.querySelector('.voice-msg-time');
      const barEls = box.querySelectorAll('.voice-msg-wave span');
      const audio = new Audio();
      audio.preload = 'auto';

      function setRing(pct){
        const clamped = Math.min(1, Math.max(0, pct || 0));
        ringFill.setAttribute('stroke-dashoffset', String(VOICE_RING_CIRC - VOICE_RING_CIRC * clamped));
      }
      function setBarsPlayed(pct){
        const activeCount = Math.round(Math.min(1, Math.max(0, pct || 0)) * barEls.length);
        barEls.forEach((b, i) => b.classList.toggle('played', i < activeCount));
      }
      function markReady(){
        if(btn.dataset.voiceState === 'loading'){
          btn.dataset.voiceState = 'paused';
          icon.textContent = '▶';
          btn.title = 'Слушать';
          timeEl.textContent = formatVoiceTime(audio.duration);
        }
      }

      audio.addEventListener('progress', () => {
        try{
          if(audio.duration && isFinite(audio.duration) && audio.buffered.length){
            setRing(audio.buffered.end(audio.buffered.length - 1) / audio.duration);
          }
        }catch(e){}
      });
      audio.addEventListener('canplaythrough', () => { setRing(1); markReady(); });
      audio.addEventListener('loadedmetadata', () => { timeEl.textContent = formatVoiceTime(audio.duration); });
      // Fallback in case canplaythrough never fires (e.g. very short clip
      // served without proper byte-range support) — canplay is enough to
      // start playback even if the whole file isn't buffered yet.
      audio.addEventListener('canplay', () => { setTimeout(markReady, 400); });
      audio.addEventListener('error', () => {
        btn.dataset.voiceState = 'error';
        icon.textContent = '!';
        btn.title = 'Не удалось загрузить аудио';
      });
      audio.addEventListener('timeupdate', () => {
        if(!audio.duration || !isFinite(audio.duration)) return;
        timeEl.textContent = formatVoiceTime(audio.duration - audio.currentTime);
        setBarsPlayed(audio.currentTime / audio.duration);
      });
      audio.addEventListener('ended', () => {
        btn.dataset.voiceState = 'paused';
        icon.textContent = '▶';
        timeEl.textContent = formatVoiceTime(audio.duration);
        setBarsPlayed(0);
      });

      function togglePlay(){
        if(btn.dataset.voiceState === 'loading' || btn.dataset.voiceState === 'error') return;
        if(audio.paused){
          // Only one voice message plays at a time — pause any other
          // currently-playing clip on the page first.
          document.querySelectorAll('.voice-msg-btn[data-voice-state="playing"]').forEach(otherBtn => {
            if(otherBtn !== btn) otherBtn.click();
          });
          audio.play().catch(()=>{});
          btn.dataset.voiceState = 'playing';
          icon.textContent = '❚❚';
        } else {
          audio.pause();
          btn.dataset.voiceState = 'paused';
          icon.textContent = '▶';
        }
      }
      btn.addEventListener('click', togglePlay);
      box.querySelector('.voice-msg-wave').addEventListener('click', () => {
        if(btn.dataset.voiceState === 'loading' || btn.dataset.voiceState === 'error') return;
        if(audio.paused) togglePlay();
      });

      audio.src = url;
      audio.load();
    });
  }

  function renderBubble(m, ctx){
    ctx = ctx || {};
    const mine = m.sender_id === currentUserId;
    const deleted = !!m.deleted_at;
    let attHtml = '';
    if(!deleted && m.attachment_url){
      if(m.attachment_type === 'image'){
        attHtml = `<img class="att-image" src="${m.attachment_url}" alt="" data-lightbox-src="${escapeHtmlChat(m.attachment_url)}">`;
      } else if(m.attachment_type === 'audio'){
        attHtml = renderVoiceAttachment(m.attachment_url);
      } else {
        attHtml = `<a class="att-file" href="${m.attachment_url}" target="_blank" download="${escapeHtmlChat(m.attachment_name||'file')}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          ${escapeHtmlChat(m.attachment_name||'Файл')}
        </a>`;
      }
    }
    let replyHtml = '';
    if(!deleted && m.reply_to_id){
      replyHtml = `<span class="cb-reply-quote" data-reply-jump="${m.reply_to_id}">
        <span class="cb-rq-sender">${escapeHtmlChat(m.reply_to_sender||'')}</span>
        <span class="cb-rq-body">${escapeHtmlChat((m.reply_to_body||'').slice(0,80))}</span>
      </span>`;
    }
    const reactions = m.reactions || {};
    const reactKeys = Object.keys(reactions).filter(k => (reactions[k]||[]).length);
    const reactHtml = (!deleted && reactKeys.length) ? `<div class="cb-reactions">${reactKeys.map(emoji=>{
      const users = reactions[emoji]||[];
      const mineReacted = users.includes(currentUserId);
      return `<span class="cb-reaction-pill ${mineReacted?'mine-reacted':''}" data-react="${emoji}" data-msgid="${m.id}">${emoji} ${users.length}</span>`;
    }).join('')}</div>` : '';
    let ticksHtml = '';
    if(mine && !deleted){
      const read = ctx.otherLastRead && m.created_at && new Date(m.created_at) <= new Date(ctx.otherLastRead);
      ticksHtml = read
        ? `<svg width="15" height="10" viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5.5L4.5 9L11 1.5"/><path d="M5.5 5.5L9 9L15.5 1.5"/></svg>`
        : `<svg width="12" height="10" viewBox="0 0 13 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5.5L4.5 9L11 1.5"/></svg>`;
    }
    const metaHtml = `<span class="cb-meta">${m.edited_at?'<span class="cb-edited">edited</span>':''}${formatMsgTime(m.created_at)}${ticksHtml}</span>`;
    const actionBtn = deleted ? '' : `<button class="cb-actions-btn" data-msgact="${m.id}" title="Actions">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
    </button>`;
    const bodyHtml = deleted ? `<span class="cb-deleted">Message deleted</span>` : `${m.body ? linkify(m.body) : ''}${attHtml}`;
    const roleForBadge = ctx.getRole ? ctx.getRole(m.sender_id) : null;
    const roleBadgeHtml = roleForBadge === 'creator' ? '<span class="role-badge creator">Creator</span>'
      : roleForBadge === 'owner' ? '<span class="role-badge owner">Owner</span>'
      : roleForBadge === 'admin' ? '<span class="role-badge admin">Admin</span>' : '';
    return `
      <div class="chat-bubble-row ${mine?'mine':''}" data-msgid="${m.id}">
        ${avatarHtml(m.sender_username, ctx.avatarFor ? ctx.avatarFor(m.sender_id) : null, 'sm')}
        <div class="chat-bubble ${mine?'mine':''}">
          ${actionBtn}
          ${!mine ? `<span class="cb-sender">${escapeHtmlChat(m.sender_username||'?')}${roleBadgeHtml}</span>` : ''}
          ${replyHtml}
          ${bodyHtml}
          ${metaHtml}
          ${reactHtml}
        </div>
      </div>`;
  }

  // Wires up the "..." action menu, reaction pills, and reply-quote jump-to
  // for every bubble currently in the DOM. Called again after every re-render
  // since the messages list is replaced wholesale each poll.
  function wireBubbleEvents(wrap, msgs, ctx){
    const byId = {};
    (msgs||[]).forEach(m => { byId[m.id] = m; });
    wrap.querySelectorAll('[data-msgact]').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        const m = byId[btn.dataset.msgact];
        if(m) openMessageMenu(m, ctx, btn);
      });
    });
    wrap.querySelectorAll('[data-react]').forEach(pill=>{
      pill.addEventListener('click', ()=>{
        const m = byId[pill.dataset.msgid];
        if(m) toggleReaction(m, pill.dataset.react, ctx);
      });
    });
    wrap.querySelectorAll('[data-reply-jump]').forEach(q=>{
      q.addEventListener('click', ()=>{
        const target = wrap.querySelector(`[data-msgid="${q.dataset.replyJump}"]`);
        if(target){ target.scrollIntoView({ behavior:'smooth', block:'center' }); }
      });
    });
    // Tapping a photo thumbnail opens the full, uncropped image — wired via
    // a real listener (not an inline onclick) so it isn't fragile against
    // URLs containing quotes, and stopPropagation so tapping the photo
    // doesn't also trigger anything the surrounding bubble listens for.
    wrap.querySelectorAll('[data-lightbox-src]').forEach(img=>{
      img.addEventListener('click', (e)=>{
        e.stopPropagation();
        openImageLightbox(img.dataset.lightboxSrc);
      });
    });
    wireVoiceMessages(wrap);
  }

  function closeMsgCtxMenu(){
    document.querySelectorAll('.msg-ctx-menu, .msg-ctx-overlay').forEach(el => el.remove());
  }

  // Spawns a short-lived floating clone of the emoji at the tapped button's
  // position, which scales up, spins slightly, drifts upward and fades out
  // — a small "reaction just landed" flourish, independent of the picker
  // menu itself so it stays visible for its full animation even after the
  // menu (and its overlay) have been closed.
  function spawnEmojiFlyBurst(emoji, fromEl){
    const rect = fromEl.getBoundingClientRect();
    const burst = document.createElement('div');
    burst.className = 'emoji-fly-burst';
    burst.style.left = (rect.left + rect.width / 2) + 'px';
    burst.style.top = (rect.top + rect.height / 2) + 'px';
    burst.textContent = emoji;
    document.body.appendChild(burst);
    burst.addEventListener('animationend', () => burst.remove());
    setTimeout(() => burst.remove(), 900); // safety net if animationend doesn't fire
  }

  // Downloads a message's photo/file/voice attachment to the device — pulled
  // in as a blob first so the browser actually saves it instead of just
  // navigating to it (a plain <a download> can't force this cross-origin).
  async function downloadAttachment(m){
    if(!m.attachment_url) return;
    try{
      const resp = await fetch(m.attachment_url);
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = m.attachment_name || (m.attachment_type === 'image' ? 'photo.jpg' : 'file');
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
    }catch(e){
      // CORS or network hiccup — fall back to just opening it so the user
      // can still save it manually from the browser.
      window.open(m.attachment_url, '_blank');
    }
  }

  // ---------- Message action menu icons ----------
  // Plain, single-colour outline icons (same stroke style used everywhere
  // else in the app — attach/voice/download buttons, etc.) instead of the
  // platform's built-in colour emoji (📌🚩🔇⛔👢🗑…), which render as
  // multi-colour glyphs on most phones and look out of place next to the
  // rest of the UI's monochrome icon set.
  const MSG_ACTION_ICON_PATHS = {
    reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    forward: '<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    save: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>',
    unpin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/><line x1="2" y1="2" x2="22" y2="22"/>',
    report: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    mute: '<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/>',
    ban: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
    kick: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/>',
    delete: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'
  };
  function msgActionIcon(name){
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">${MSG_ACTION_ICON_PATHS[name] || ''}</svg>`;
  }

  function openMessageMenu(m, ctx, btnEl){
    closeMsgCtxMenu();
    const mine = m.sender_id === currentUserId;
    const overlay = document.createElement('div');
    overlay.className = 'msg-ctx-overlay';
    overlay.addEventListener('click', closeMsgCtxMenu);
    document.body.appendChild(overlay);

    const rect = btnEl.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'msg-ctx-menu';
    let left = mine ? rect.left - 160 : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - 190));
    let top = Math.min(rect.bottom + 4, window.innerHeight - 220);
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    const canModerate = ctx.isGroupOwner || ctx.isGroupAdmin || ctx.isSiteCreator;
    menu.innerHTML = `
      <div class="msg-ctx-emojis">${MESSAGE_EMOJIS.map(e=>`<button data-react-pick="${e}">${e}</button>`).join('')}</div>
      <button data-act="reply">${msgActionIcon('reply')} Reply</button>
      <button data-act="forward">${msgActionIcon('forward')} Forward</button>
      ${m.body ? `<button data-act="copy">${msgActionIcon('copy')} Copy</button>` : ''}
      ${m.attachment_url ? `<button data-act="save">${msgActionIcon('save')} Save</button>` : ''}
      ${mine && m.body ? `<button data-act="edit">${msgActionIcon('edit')} Edit</button>` : ''}
      ${ctx.canPin ? `<button data-act="pin">${ctx.pinnedId === m.id ? msgActionIcon('unpin') + ' Unpin' : msgActionIcon('pin') + ' Pin'}</button>` : ''}
      ${(!mine && ctx.canReport) ? `<button data-act="report">${msgActionIcon('report')} Report</button>` : ''}
      ${(!mine && ctx.isSiteCreator) ? `<button data-act="mute">${msgActionIcon('mute')} Mute</button><button data-act="ban" class="danger">${msgActionIcon('ban')} Ban</button>` : ''}
      ${(!mine && canModerate) ? `<button data-act="kick" class="danger">${msgActionIcon('kick')} Kick</button>` : ''}
      ${(mine || canModerate) ? `<button data-act="delete" class="danger">${msgActionIcon('delete')} Delete</button>` : ''}
    `;
    document.body.appendChild(menu);

    menu.querySelectorAll('[data-react-pick]').forEach(b=>{
      b.addEventListener('click', ()=>{
        b.classList.add('pop');
        spawnEmojiFlyBurst(b.dataset.reactPick, b);
        toggleReaction(m, b.dataset.reactPick, ctx);
        // Let the pop/burst actually be seen before the menu vanishes.
        setTimeout(closeMsgCtxMenu, 160);
      });
    });
    const replyBtn = menu.querySelector('[data-act="reply"]');
    if(replyBtn) replyBtn.addEventListener('click', ()=>{ startReply(m); closeMsgCtxMenu(); });
    const fwdBtn = menu.querySelector('[data-act="forward"]');
    if(fwdBtn) fwdBtn.addEventListener('click', ()=>{ openForwardPicker(m); closeMsgCtxMenu(); });
    const copyBtn = menu.querySelector('[data-act="copy"]');
    if(copyBtn) copyBtn.addEventListener('click', ()=>{ navigator.clipboard && navigator.clipboard.writeText(m.body||''); closeMsgCtxMenu(); });
    const saveBtn = menu.querySelector('[data-act="save"]');
    if(saveBtn) saveBtn.addEventListener('click', ()=>{ downloadAttachment(m); closeMsgCtxMenu(); });
    const editBtn = menu.querySelector('[data-act="edit"]');
    if(editBtn) editBtn.addEventListener('click', ()=>{ startEdit(m); closeMsgCtxMenu(); });
    const pinBtn = menu.querySelector('[data-act="pin"]');
    if(pinBtn) pinBtn.addEventListener('click', ()=>{
      if(ctx.pinnedId === m.id) ctx.onUnpin && ctx.onUnpin();
      else ctx.onPin && ctx.onPin(m);
      closeMsgCtxMenu();
    });
    const reportBtn = menu.querySelector('[data-act="report"]');
    if(reportBtn) reportBtn.addEventListener('click', ()=>{ ctx.onReport && ctx.onReport(m); closeMsgCtxMenu(); });
    const muteBtn = menu.querySelector('[data-act="mute"]');
    if(muteBtn) muteBtn.addEventListener('click', ()=>{ ctx.onMute && ctx.onMute(m); closeMsgCtxMenu(); });
    const banBtn = menu.querySelector('[data-act="ban"]');
    if(banBtn) banBtn.addEventListener('click', ()=>{ ctx.onBan && ctx.onBan(m); closeMsgCtxMenu(); });
    const kickBtn = menu.querySelector('[data-act="kick"]');
    if(kickBtn) kickBtn.addEventListener('click', ()=>{ ctx.onKick && ctx.onKick(m); closeMsgCtxMenu(); });
    const delBtn = menu.querySelector('[data-act="delete"]');
    if(delBtn) delBtn.addEventListener('click', ()=>{ if(confirm('Delete this message?')) deleteMessage(m, ctx); closeMsgCtxMenu(); });
  }

  // ---------- Forward message ----------
  async function openForwardPicker(m){
    if(!currentUserId) return;
    const overlay = makeOverlay(`
      <h3 style="margin:0 0 10px;font-size:1rem;">Forward to…</h3>
      <div id="fwdList" style="max-height:340px;overflow:auto;">Загрузка…</div>
      <button class="acct-btn" id="fwdCancel" style="width:100%;margin-top:12px;">Отмена</button>
    `, 340);
    document.getElementById('fwdCancel').addEventListener('click', () => overlay.remove());

    const { data: dmMsgs } = await supabase.from('messages').select('dm_key')
      .or(`dm_key.ilike.${currentUserId}_%,dm_key.ilike.%_${currentUserId}`).limit(3000);
    const otherIds = new Set();
    (dmMsgs||[]).forEach(r => { (r.dm_key||'').split('_').forEach(id => { if(id !== currentUserId) otherIds.add(id); }); });
    const { data: profiles } = otherIds.size
      ? await supabase.from('profiles').select('id,username,avatar_url').in('id', Array.from(otherIds))
      : { data: [] };

    const listEl = document.getElementById('fwdList');
    const rows = [
      ...(profiles||[]).map(p => ({ type:'dm', id:p.id, name:p.username, avatar_url:p.avatar_url }))
    ];
    if(!rows.length){ listEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);">Нет чатов для пересылки.</div>'; return; }
    listEl.innerHTML = rows.map(r => `
      <div class="fwd-modal-row" data-type="${r.type}" data-id="${r.id}" data-name="${escapeHtmlChat(r.name)}">
        ${avatarHtml(r.name, r.avatar_url, 'sm')}
        <span>${escapeHtmlChat(r.name)}</span>
      </div>`).join('');
    listEl.querySelectorAll('.fwd-modal-row').forEach(row => {
      row.addEventListener('click', async () => {
        const base = {
          sender_id: currentUserId, sender_username: currentUsername,
          body: (m.body ? '↪ ' + m.body : (m.body === null ? '↪ Forwarded message' : '')),
          attachment_url: m.attachment_url || null, attachment_type: m.attachment_type || null, attachment_name: m.attachment_name || null
        };
        base.dm_key = dmKeyFor(currentUserId, row.dataset.id);
        try{ await supabase.from('messages').insert(base); }catch(e){ alert('Ошибка пересылки: '+e.message); return; }
        overlay.remove();
      });
    });
  }

  async function toggleReaction(m, emoji, ctx){
    const reactions = Object.assign({}, m.reactions || {});
    const alreadyHadThisOne = (reactions[emoji] || []).includes(currentUserId);
    // One reaction per person: strip this user out of every emoji first...
    Object.keys(reactions).forEach(key => {
      const list = new Set(reactions[key] || []);
      list.delete(currentUserId);
      if(list.size) reactions[key] = Array.from(list); else delete reactions[key];
    });
    // ...then add them back only to the emoji they just tapped, unless that
    // was the one they already had (tapping it again just removes it).
    if(!alreadyHadThisOne){
      const list = new Set(reactions[emoji] || []);
      list.add(currentUserId);
      reactions[emoji] = Array.from(list);
    }
    try{ await supabase.from('messages').update({ reactions }).eq('id', m.id); }
    catch(e){ console.error('toggleReaction failed (needs a "reactions" jsonb column on messages)', e); }
    if(ctx && ctx.reload) ctx.reload();
  }

  // Deletes a message. Tries a soft delete first (keeps a "Message deleted"
  // placeholder in the conversation, like Telegram) — if the messages table
  // is missing deleted_at or any of the other columns being cleared here,
  // it drops just that column and retries, same fallback pattern as
  // insertMessageWithFallback. If soft delete isn't possible at all (no
  // deleted_at column on the table), it falls back to actually deleting the
  // row so the message still disappears either way. Before, a failed update
  // was only logged to the console and silently left the message in place —
  // this surfaces a real error to the user instead of pretending it worked.
  async function deleteMessage(m, ctx){
    let payload = {
      deleted_at: new Date().toISOString(), body: null,
      attachment_url: null, attachment_type: null, attachment_name: null
    };
    let error = null;
    for(let attempts = 0; attempts < 10; attempts++){
      if(Object.keys(payload).length === 0){ error = { message: 'no soft-delete columns available' }; break; }
      ({ error } = await supabase.from('messages').update(payload).eq('id', m.id));
      if(!error) break;
      const badCol = missingColumnFromError(error);
      if(badCol && Object.prototype.hasOwnProperty.call(payload, badCol)){
        const { [badCol]: _drop, ...rest } = payload;
        payload = rest;
        continue;
      }
      break;
    }
    if(error){
      console.warn('Soft delete unavailable, hard-deleting the row instead:', error.message);
      ({ error } = await supabase.from('messages').delete().eq('id', m.id));
    }
    if(error){
      console.error('deleteMessage failed:', error.message);
      alert('Не удалось удалить сообщение: ' + error.message);
      return;
    }
    if(ctx && ctx.reload) ctx.reload();
  }

  function renderReplyBar(){
    const bar = document.getElementById('replyBar');
    if(!bar) return;
    const input = document.getElementById('chatInput');
    if(editTarget){
      bar.innerHTML = `<div class="reply-bar" style="border-left-color:#e2a63d;">
        <div class="rb-text"><span class="rb-sender">Editing message</span><span class="rb-body">${escapeHtmlChat(editTarget.body||'')}</span></div>
        <button class="rb-close" id="replyBarClose">✕</button>
      </div>`;
      if(input) input.value = editTarget.body || '';
    } else if(replyTarget){
      bar.innerHTML = `<div class="reply-bar">
        <div class="rb-text"><span class="rb-sender">${escapeHtmlChat(replyTarget.sender_username||'')}</span><span class="rb-body">${escapeHtmlChat(replyTarget.body || (replyTarget.attachment_url ? 'Attachment' : ''))}</span></div>
        <button class="rb-close" id="replyBarClose">✕</button>
      </div>`;
    } else {
      bar.innerHTML = '';
    }
    const closeBtn = document.getElementById('replyBarClose');
    if(closeBtn) closeBtn.addEventListener('click', ()=>{
      if(editTarget){ editTarget = null; if(input) input.value = ''; } else { replyTarget = null; }
      renderReplyBar();
    });
  }

  function startReply(m){ editTarget = null; replyTarget = m; renderReplyBar(); document.getElementById('chatInput')?.focus(); }
  function startEdit(m){ replyTarget = null; editTarget = m; renderReplyBar(); document.getElementById('chatInput')?.focus(); }

  // ---- Upload with a real progress ring + cancel (×), like social apps.
  // Uses raw XHR against the Storage REST endpoint because the supabase-js
  // storage client doesn't expose upload progress events. No resizing or
  // recompression happens anywhere — files/photos are sent exactly as
  // picked, so a 4K photo stays 4K.
  async function uploadFileWithProgress(bucket, path, file, onProgress, controller){
    const { data: sessionData } = await supabase.auth.getSession();
    const token = (sessionData && sessionData.session && sessionData.session.access_token) || SUPABASE_ANON_KEY;
    const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
    try{
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
        xhr.setRequestHeader('x-upsert', 'true');
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.upload.onprogress = (e) => { if(e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
        xhr.onload = () => {
          if(xhr.status >= 200 && xhr.status < 300) resolve();
          else {
            // Surface Supabase's actual reason (e.g. "mime type not
            // supported", "The resource already exists") instead of just
            // the bare status code — that's what actually explains a 400.
            let detail = '';
            try{ detail = JSON.parse(xhr.responseText).message || xhr.responseText; }catch(e){ detail = xhr.responseText; }
            reject(new Error('Ошибка загрузки (' + xhr.status + ')' + (detail ? ': ' + detail : '')));
          }
        };
        xhr.onerror = () => reject(new Error('Сетевая ошибка при загрузке'));
        xhr.onabort = () => reject(new Error('CANCELLED'));
        if(controller) controller.xhr = xhr;
        xhr.send(file);
      });
    }catch(err){
      if(err.message === 'CANCELLED') throw err;
      // Fall back to the official supabase-js storage client (no progress
      // bar, but it builds the request exactly the way the working avatar
      // uploads elsewhere in the app do) before giving up — this recovers
      // from cases where the raw XHR request above was rejected for a
      // header/format reason that the SDK avoids.
      const { error } = await supabase.storage.from(bucket).upload(path, file, { upsert: true, contentType: file.type || 'application/octet-stream' });
      if(error) throw new Error(err.message + ' / retry: ' + error.message);
      if(onProgress) onProgress(1);
    }
  }

  // Renders the circular progress + × cancel bar into #uploadProgressBar.
  // Returns a controller object: { setProgress(0-1), done(), cancel() }.
  function showUploadProgress(label, onCancel){
    const host = document.getElementById('uploadProgressBar');
    if(!host) return { setProgress(){}, done(){}, cancel(){} };
    const R = 15, C = 2*Math.PI*R;
    host.innerHTML = `
      <div class="upload-progress-bar" id="uploadBarInner">
        <div class="upload-ring">
          <svg viewBox="0 0 34 34">
            <circle class="track" cx="17" cy="17" r="${R}"></circle>
            <circle class="fill" id="uploadRingFill" cx="17" cy="17" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}"></circle>
          </svg>
          <div class="pct" id="uploadPctText">0%</div>
        </div>
        <div class="upload-info">${escapeHtmlChat(label)}</div>
        <button class="upload-cancel-btn" id="uploadCancelBtn" title="Отменить">×</button>
      </div>`;
    const fillEl = document.getElementById('uploadRingFill');
    const pctEl = document.getElementById('uploadPctText');
    document.getElementById('uploadCancelBtn').addEventListener('click', () => { if(onCancel) onCancel(); });
    return {
      setProgress(frac){
        const pct = Math.max(0, Math.min(1, frac));
        fillEl.setAttribute('stroke-dashoffset', String(C * (1 - pct)));
        pctEl.textContent = Math.round(pct*100) + '%';
      },
      done(){ host.innerHTML = ''; },
      cancel(){ host.innerHTML = ''; }
    };
  }

  // Inserts a message; if the extra Telegram-style columns (reply_to_id,
  // reply_to_body, reply_to_sender) haven't been migrated into the DB yet,
  // falls back to a base insert so sending still works either way.
  // Pulls the missing column name out of a PostgREST "schema cache" error,
  // e.g. "Could not find the 'attachment_name' column of 'messages' in the
  // schema cache" -> "attachment_name". Returns null if it's some other error.
  function missingColumnFromError(error){
    if(!error || !error.message) return null;
    const m = error.message.match(/Could not find the '([^']+)' column/i);
    return m ? m[1] : null;
  }

  // Same idea, but for a column that DOES exist and got the request far
  // enough to hit a type check — e.g. reply_to_id is declared `uuid` in the
  // migration, so replying to a message whose id isn't in valid UUID form
  // (or whose messages.id column simply isn't of type uuid on this
  // particular DB) makes Postgres reject it with "invalid input syntax for
  // type uuid: ...". That error was previously falling straight through to
  // the user as "Не удалось отправить: invalid input syntax for type
  // uuid: ..." and the message — reply text included — never sent at all.
  // This finds which field in the payload actually held that bad value (or
  // falls back to reply_to_id, the only uuid-typed optional field we ever
  // send) so the caller can drop just that one field and retry — the reply
  // quote (sender + snippet) still gets saved and shown even if the
  // clickable "jump to original" link can't be wired up.
  function badUuidKeyFromError(error, payload){
    if(!error || !error.message) return null;
    if(!/invalid input syntax for type uuid/i.test(error.message)) return null;
    const m = error.message.match(/invalid input syntax for type uuid: "([^"]*)"/i);
    const badValue = m ? m[1] : null;
    if(badValue){
      const key = Object.keys(payload).find(k => payload[k] === badValue);
      if(key) return key;
    }
    if(Object.prototype.hasOwnProperty.call(payload, 'reply_to_id')) return 'reply_to_id';
    return null;
  }

  // Builds the reply_to_* fields for a new message, if replying. Skips
  // reply_to_id up front when the target is still a local optimistic echo
  // (id starts with "temp_", meaning the server hasn't confirmed it and
  // handed back a real id yet) — sending that straight to a `uuid` column
  // would always fail. The quote text/sender still get attached either way
  // so the Telegram-style reply preview always shows correctly; only the
  // "jump to original message" link needs a real id.
  function buildReplyExtra(reply){
    if(!reply) return {};
    const extra = { reply_to_body: (reply.body||'').slice(0,200), reply_to_sender: reply.sender_username };
    if(typeof reply.id === 'string' && !reply.id.startsWith('temp_')) extra.reply_to_id = reply.id;
    return extra;
  }

  async function insertMessageWithFallback(basePayload, extraPayload){
    // Try the richest payload first, then progressively drop any column
    // Postgres/PostgREST says it doesn't recognize, retrying until it either
    // succeeds or we run out of columns to drop. This means messages still
    // send even if the DB migration (see block below) hasn't been run yet —
    // instead of every single message silently failing forever.
    let payload = Object.assign({}, basePayload, extraPayload || {});
    for(let attempts = 0; attempts < 10; attempts++){
      const { error } = await supabase.from('messages').insert(payload);
      if(!error) return { success: true };
      const badCol = missingColumnFromError(error);
      if(badCol && Object.prototype.hasOwnProperty.call(payload, badCol)){
        console.warn(`Column "${badCol}" missing on messages table — dropping it and retrying. Run the migration below to fix permanently.`);
        const { [badCol]: _drop, ...rest } = payload;
        payload = rest;
        continue;
      }
      const badUuidKey = badUuidKeyFromError(error, payload);
      if(badUuidKey){
        console.warn(`Field "${badUuidKey}" wasn't a valid UUID for this table — dropping it and retrying so the rest of the message still sends.`);
        const { [badUuidKey]: _drop2, ...rest } = payload;
        payload = rest;
        continue;
      }
      console.error('Message insert failed:', error.message);
      return { success: false, error };
    }
    return { success: false, error: { message: 'Too many missing columns — check the messages table schema.' } };
  }
  /* Migration to run once in the Supabase SQL editor to enable reply-to,
     editing, deleting, reactions, pinned messages, and the typing indicator:
     alter table messages add column if not exists reply_to_id uuid;
     alter table messages add column if not exists reply_to_body text;
     alter table messages add column if not exists reply_to_sender text;
     alter table messages add column if not exists edited_at timestamptz;
     alter table messages add column if not exists deleted_at timestamptz;
     alter table messages add column if not exists reactions jsonb default '{}'::jsonb;
     alter table groups add column if not exists pinned_message_id uuid;
     create table if not exists typing_status (
       scope_key text not null,
       user_id uuid not null,
       username text,
       updated_at timestamptz not null default now(),
       primary key (scope_key, user_id)
     );
     -- also create a "chat-files" storage bucket (public) if it doesn't
     -- already exist — voice messages are uploaded there, same as images/files.

     -- Roles, moderation (mute/ban/kick), and reports:
     alter table groups add column if not exists description text;
     alter table group_members add column if not exists role text default 'member'; -- 'member' | 'admin'
     alter table group_members add column if not exists muted_until timestamptz;
     create table if not exists group_bans (
       group_id uuid not null,
       user_id uuid not null,
       banned_until timestamptz, -- null = permanent
       banned_by uuid,
       created_at timestamptz not null default now(),
       primary key (group_id, user_id)
     );
     create table if not exists message_reports (
       id uuid primary key default gen_random_uuid(),
       group_id uuid,
       group_name text,
       dm_key text,
       message_id uuid,
       message_body text,
       reporter_id uuid,
       reporter_username text,
       reason text,
       status text default 'pending',
       created_at timestamptz not null default now()
     );
     create table if not exists moderation_log (
       id uuid primary key default gen_random_uuid(),
       actor_id uuid,
       actor_username text,
       action text, -- 'mute' | 'ban' | 'kick'
       target_user_id uuid,
       target_username text,
       group_id uuid,
       group_name text,
       details text,
       created_at timestamptz not null default now()
     );
     -- "Creator" badge + the ability to join any group without a request:
     alter table profiles add column if not exists is_admin boolean default false;
     -- run once, with your own account's UUID from auth.users / profiles:
     -- update profiles set is_admin = true where id = 'YOUR-USER-UUID-HERE';

     -- Admin Console (/ban /unban /mute /unmute /delgroup /pm):
     alter table profiles add column if not exists banned_until timestamptz;
     create table if not exists admin_broadcasts (
       id uuid primary key default gen_random_uuid(),
       target_user_id uuid not null,
       message text not null,
       delivered boolean default false,
       created_at timestamptz not null default now()
     );
  */

  function setupChatSendHandlers(onSend, onEdit, opts){
    opts = opts || {};
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSendBtn');
    const attachBtn = document.getElementById('chatAttachBtn');
    const fileInput = document.getElementById('chatFileInput');
    const voiceBtn = document.getElementById('chatVoiceBtn');

    async function isMutedNow(){
      if(!opts.checkMuted) return false;
      const until = await opts.checkMuted();
      if(until && new Date(until) > new Date()){
        alert('Вы не можете писать — вы замьючены до ' + new Date(until).toLocaleString('ru'));
        return true;
      }
      return false;
    }

    // Voice recording state — declared up here so both send() and the mic
    // handler below can see it.
    let mediaRecorder = null;
    let audioStream = null;
    let audioChunks = [];
    let voiceState = 'idle'; // 'idle' | 'recording' | 'ready'
    let recordStartTs = 0;
    let recordTimerId = null;
    let voiceUIEl = null;

    function formatSecs(s){
      const m = Math.floor(s/60), sec = s%60;
      return String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');
    }

    async function send(){
      // A voice recording in progress or waiting to be sent takes over the
      // send button/Enter — that's the only way it gets sent now (tapping
      // the mic button again no longer sends it).
      if(voiceState === 'recording' || voiceState === 'ready'){
        await finalizeAndSendVoice();
        return;
      }
      const body = input.value.trim();
      if(!body) return;
      if(!editTarget && await isMutedNow()) return;
      input.value = '';
      if(editTarget){
        const target = editTarget; editTarget = null; renderReplyBar();
        await onEdit(target, body);
      } else {
        const reply = replyTarget; replyTarget = null; renderReplyBar();
        await onSend(body, null, reply);
      }
    }
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', e => {
      if(e.key === 'Enter' || e.keyCode === 13){ e.preventDefault(); send(); }
    });

    // "X is typing…" — writes a lightweight typing_status row (throttled to
    // once every 2.5s) that the other side polls for while chatting.
    if(opts.scopeKey){
      let lastTypingSent = 0;
      input.addEventListener('input', () => {
        const now = Date.now();
        if(now - lastTypingSent < 2500) return;
        lastTypingSent = now;
        supabase.from('typing_status').upsert({
          scope_key: opts.scopeKey, user_id: currentUserId, username: currentUsername, updated_at: new Date().toISOString()
        }).then(()=>{}).catch(()=>{ /* table may not be migrated yet */ });
      });
    }

    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if(!file) return;
      if(await isMutedNow()) return;
      // 25MB cap — high enough that a real 4K photo (no recompression
      // happens anywhere in this app) won't get rejected; only guards
      // against accidentally picking a huge unrelated file.
      if(file.size > 25*1024*1024){ alert('Файл слишком большой (максимум 25 МБ).'); return; }
      // 20MB per-user attachment cache: block the send and show the
      // Cancel/Clear warning instead of uploading if this would go over.
      const usedBytes = await getUserCacheUsedBytes(currentUserId);
      if(usedBytes + file.size > CACHE_LIMIT_BYTES){
        showCacheFullWarning(usedBytes, file.size);
        return;
      }
      const bucket = await getActiveStorageBucket(file.size);
      const path = `${currentUserId}/${Date.now()}_${file.name}`;
      const controller = {};
      const progress = showUploadProgress(file.name, () => {
        if(controller.xhr) controller.xhr.abort();
      });
      try{
        await uploadFileWithProgress(bucket, path, file, (frac) => progress.setProgress(frac), controller);
        progress.done();
        const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
        await logUserUpload(currentUserId, bucket, path, file.size);
        const isImage = file.type.startsWith('image/');
        const reply = replyTarget; replyTarget = null; renderReplyBar();
        await onSend('', { url: pub.publicUrl, type: isImage ? 'image' : 'file', name: file.name }, reply);
      }catch(e){
        progress.cancel();
        if(e.message !== 'CANCELLED') alert('Ошибка загрузки: '+e.message);
      }
    });

    // Voice messages: tap the mic to start recording — the text field is
    // replaced by a Telegram-style row of thin animated bars plus a
    // running mm:ss timer. Tapping the mic again only *stops* the capture
    // (bars freeze); actually sending happens only via the send button or
    // Enter, same as a text message. The ✕ button discards it and restores
    // the normal input.
    function buildVoiceUI(){
      const row = input.closest('.chat-input-row');
      const ui = document.createElement('div');
      ui.className = 'voice-record-ui';
      let barsHtml = '';
      const BAR_COUNT = 40;
      for(let i=0;i<BAR_COUNT;i++){
        const dur = 650 + (i % 6) * 70;
        const delay = (i % 9) * 60;
        barsHtml += `<span style="animation-duration:${dur}ms;animation-delay:-${delay}ms;"></span>`;
      }
      ui.innerHTML = `
        <button type="button" class="voice-record-cancel" id="voiceCancelBtn" title="Отменить">✕</button>
        <span class="voice-record-dot"></span>
        <span class="voice-record-timer" id="voiceTimer">00:00</span>
        <div class="voice-bars" id="voiceBars">${barsHtml}</div>
      `;
      row.insertBefore(ui, input);
      input.style.display = 'none';
      if(attachBtn) attachBtn.style.display = 'none';
      document.getElementById('voiceCancelBtn').addEventListener('click', cancelRecording);
      return ui;
    }

    function teardownVoiceUI(){
      if(voiceUIEl){ voiceUIEl.remove(); voiceUIEl = null; }
      input.style.display = '';
      if(attachBtn) attachBtn.style.display = '';
    }

    function cancelRecording(){
      if(recordTimerId){ clearInterval(recordTimerId); recordTimerId = null; }
      if(mediaRecorder && mediaRecorder.state !== 'inactive'){
        mediaRecorder.onstop = null;
        mediaRecorder.stop();
      }
      if(audioStream) audioStream.getTracks().forEach(t => t.stop());
      audioChunks = [];
      mediaRecorder = null;
      voiceState = 'idle';
      voiceBtn.classList.remove('recording');
      voiceBtn.title = 'Голосовое сообщение';
      teardownVoiceUI();
    }

    async function startRecording(){
      if(await isMutedNow()) return;
      if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
        alert('Голосовые сообщения не поддерживаются в этом браузере.'); return;
      }
      try{
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(audioStream);
        audioChunks = [];
        mediaRecorder.addEventListener('dataavailable', e => { if(e.data.size) audioChunks.push(e.data); });
        mediaRecorder.start();
        voiceState = 'recording';
        voiceBtn.classList.add('recording');
        voiceBtn.title = 'Остановить запись';
        voiceUIEl = buildVoiceUI();
        recordStartTs = Date.now();
        recordTimerId = setInterval(() => {
          const t = document.getElementById('voiceTimer');
          if(t) t.textContent = formatSecs(Math.floor((Date.now() - recordStartTs)/1000));
        }, 250);
      }catch(e){ alert('Нет доступа к микрофону: '+e.message); }
    }

    // Stops capturing but keeps the audio queued — sending still needs the
    // send button or Enter.
    function stopRecordingOnly(){
      if(recordTimerId){ clearInterval(recordTimerId); recordTimerId = null; }
      voiceState = 'ready';
      voiceBtn.classList.remove('recording');
      voiceBtn.title = 'Голосовое сообщение';
      const bars = document.getElementById('voiceBars');
      if(bars) bars.classList.add('stopped');
      if(audioStream) audioStream.getTracks().forEach(t => t.stop());
      if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    }

    async function finalizeAndSendVoice(){
      if(voiceState === 'recording') stopRecordingOnly();
      await new Promise(resolve => {
        if(!mediaRecorder || mediaRecorder.state === 'inactive') return resolve();
        mediaRecorder.addEventListener('stop', resolve, { once:true });
      });
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      teardownVoiceUI();
      voiceState = 'idle';
      mediaRecorder = null; audioChunks = [];
      if(blob.size < 800) return; // too short / accidental tap
      const usedBytes = await getUserCacheUsedBytes(currentUserId);
      if(usedBytes + blob.size > CACHE_LIMIT_BYTES){
        showCacheFullWarning(usedBytes, blob.size);
        return;
      }
      const bucket = await getActiveStorageBucket(blob.size);
      const path = `${currentUserId}/${Date.now()}_voice.webm`;
      const controller = {};
      const progress = showUploadProgress('Голосовое сообщение', () => { if(controller.xhr) controller.xhr.abort(); });
      try{
        await uploadFileWithProgress(bucket, path, blob, (frac) => progress.setProgress(frac), controller);
        progress.done();
        const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
        await logUserUpload(currentUserId, bucket, path, blob.size);
        const reply = replyTarget; replyTarget = null; renderReplyBar();
        await onSend('', { url: pub.publicUrl, type: 'audio', name: 'Voice message' }, reply);
      }catch(e){
        progress.cancel();
        if(e.message !== 'CANCELLED') alert('Ошибка загрузки: '+e.message);
      }
    }

    if(voiceBtn){
      voiceBtn.addEventListener('click', async () => {
        if(voiceState === 'idle') await startRecording();
        else if(voiceState === 'recording') stopRecordingOnly();
        // voiceState === 'ready': tapping the mic again does nothing —
        // only the send button / Enter sends it now.
      });
    }
  }

  async function handleAuthChange(event, session){
    if(session && session.user && session.user.email){
      // Supabase fires this event (e.g. TOKEN_REFRESHED) whenever the tab
      // regains focus/visibility, not just on real sign-in. If the app is
      // already open for this same user, just refresh the stored tokens
      // quietly and stop — don't re-render/reset the UI (that was causing
      // the reset to the default section + layout jump when switching tabs).
      // Regardless of which Supabase event fired (SIGNED_IN, TOKEN_REFRESHED,
      // INITIAL_SESSION, etc.) — if the app is already showing for this same
      // user, this is just Supabase re-confirming the session (e.g. after the
      // tab regained focus/visibility). Never re-run enterApp() in that case,
      // since that's what was resetting the current section and causing the
      // layout jump.
      const alreadyInApp = appEl.classList.contains('visible') && currentUserId === session.user.id;
      if(alreadyInApp){
        currentUserEmail = session.user.email;
        window.currentUserEmail = currentUserEmail;
        upsertSavedAccount({
          user_id: session.user.id,
          email: session.user.email,
          username: currentUsername,
          access_token: session.access_token,
          refresh_token: session.refresh_token
        });
        return;
      }
      currentUserEmail = session.user.email;
      window.currentUserEmail = currentUserEmail;
      isGuest = false;
      window.isGuest = false;
      currentUserId = session.user.id;
      currentUserCreatedAt = session.user.created_at;
      if(registrationGate){
        const ok = await registrationGate;
        if(!ok){ await supabase.auth.signOut(); return; }
      }
      let username;
      if(authHandoff && authHandoff.userId === session.user.id && authHandoff.username){
        username = authHandoff.username;
        window.currentUserAvatarUrl = authHandoff.avatarUrl || null;
        authHandoff = null;
      } else {
        username = await fetchUsername(session.user.id);
        supabase.from('profiles').select('avatar_url').eq('id', session.user.id).maybeSingle()
          .then(({ data }) => { window.currentUserAvatarUrl = data ? data.avatar_url : null; });
      }
      if(!username){
        try{ username = await ensureProfileForUser(session.user); }
        catch(e){ console.error(e); showMsg('Не удалось создать профиль: ' + (e.message || e), 'error'); await supabase.auth.signOut(); return; }
      }
      currentUsername = username;
      // Site-wide ban check — someone banned via /ban user time (no group)
      // gets signed out immediately and sees a countdown instead of the app.
      try{
        const { data: banRow } = await supabase.from('profiles').select('banned_until').eq('id', session.user.id).maybeSingle();
        if(banRow && banRow.banned_until && new Date(banRow.banned_until) > new Date()){
          const until = banRow.banned_until;
          await supabase.auth.signOut();
          showBanScreen(until, 'site');
          return;
        }
      }catch(e){ /* profiles.banned_until not migrated yet */ }
      upsertSavedAccount({
        user_id: session.user.id,
        email: session.user.email,
        username: username,
        access_token: session.access_token,
        refresh_token: session.refresh_token
      });
      enterApp(currentUserEmail, username);
    } else {
      currentUserEmail = null;
      window.currentUserEmail = null;
      currentUserId = null;
      currentUsername = null;
      currentUserCreatedAt = null;
      // Supabase can fire this "no session" event well after page load (e.g.
      // its own slow initial session check finishing late) — by that point
      // the person may already be mid-typing on the login/register form. Only
      // reset/clear the screen if they were actually logged in before; a
      // no-op here is what stopped the login/register fields (and whichever
      // tab they'd switched to) from getting wiped out from under them.
      const wasLoggedIn = appEl.classList.contains('visible');
      if(wasLoggedIn){
        appEl.classList.remove('visible');
        authEl.classList.remove('hidden');
        clearMsg();
        closeAcctPopover();
        goToLoginTab();
        document.getElementById('loginUsername').value = '';
        document.getElementById('loginPassword').value = '';
      }
    }
  }
  // Run the handler outside supabase-js's callback (calling other supabase methods inside it can deadlock).
  supabase.auth.onAuthStateChange((event, session) => {
    setTimeout(() => { handleAuthChange(event, session).catch(err => console.error('auth change failed', err)); }, 0);
  });

  /* ---- account FAB / popover ---- */
  const acctFab = document.getElementById('acctFab');
  const acctPopover = document.getElementById('acctPopover');
  const deleteOverlay = document.getElementById('deleteOverlay');

  function openAcctPopover(){ acctPopover.classList.add('open'); }
  function closeAcctPopover(){ acctPopover.classList.remove('open'); }

  function openCreatedDateEditor(){
    const fakeKey = 'fakeCreatedAt_' + currentUserId;
    const existing = JSON.parse(localStorage.getItem(fakeKey) || 'null') || {
      year: new Date().getFullYear(), month: 0, day: 1, hour: 0, minute: 0, second: 0
    };
    const months = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.innerHTML = `
      <div class="confirm-modal" style="max-width:340px;">
        <h3 style="margin:0 0 14px;font-size:1rem;">Изменить дату регистрации</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
          <div>
            <label style="font-size:.72rem;color:var(--text-dim);">Год</label>
            <input type="text" id="cdeYear" value="${existing.year}" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--line);">
          </div>
          <div>
            <label style="font-size:.72rem;color:var(--text-dim);">Месяц</label>
            <select id="cdeMonth" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--line);">
              ${months.map((m,i)=>`<option value="${i}" ${i===existing.month?'selected':''}>${m}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="font-size:.72rem;color:var(--text-dim);">День</label>
            <input type="text" id="cdeDay" value="${existing.day}" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--line);">
          </div>
          <div></div>
          <div>
            <label style="font-size:.72rem;color:var(--text-dim);">Часы</label>
            <input type="text" id="cdeHour" value="${existing.hour}" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--line);">
          </div>
          <div>
            <label style="font-size:.72rem;color:var(--text-dim);">Минуты</label>
            <input type="text" id="cdeMinute" value="${existing.minute}" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--line);">
          </div>
          <div>
            <label style="font-size:.72rem;color:var(--text-dim);">Секунды</label>
            <input type="text" id="cdeSecond" value="${existing.second}" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--line);">
          </div>
        </div>
        <div style="display:flex;gap:10px;margin-top:8px;">
          <button class="acct-btn" id="cdeCancel" style="flex:1;">Отмена</button>
          <button class="acct-btn" id="cdeSave" style="flex:1;background:var(--btn);color:#fff;">Сохранить</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    document.getElementById('cdeCancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
    document.getElementById('cdeSave').addEventListener('click', () => {
      const val = {
        year: document.getElementById('cdeYear').value.trim() || existing.year,
        month: parseInt(document.getElementById('cdeMonth').value, 10),
        day: document.getElementById('cdeDay').value.trim() || existing.day,
        hour: document.getElementById('cdeHour').value.trim() || '0',
        minute: document.getElementById('cdeMinute').value.trim() || '0',
        second: document.getElementById('cdeSecond').value.trim() || '0'
      };
      localStorage.setItem(fakeKey, JSON.stringify(val));
      overlay.remove();
      renderAccountPopover();
    });
  }

  function renderAccountPopover(){
    const created = currentUserCreatedAt ? new Date(currentUserCreatedAt) : null;
    const RU_MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    const pad2 = n => String(n).padStart(2,'0');
    const fakeKey = 'fakeCreatedAt_' + currentUserId;
    const fakeRaw = isAdmin() ? localStorage.getItem(fakeKey) : null;
    const fake = fakeRaw ? JSON.parse(fakeRaw) : null;
    const createdStr = fake
      ? `${pad2(fake.day)} ${RU_MONTHS_GEN[fake.month]} ${fake.year} г., ${pad2(fake.hour)}:${pad2(fake.minute)}:${pad2(fake.second)}`
      : (created ? created.toLocaleString('ru-RU', {
          day:'2-digit', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit'
        }) : '—');
    const initial = ((currentUsername || currentUserEmail || '?').trim()[0] || '?').toUpperCase();
    document.getElementById('acctInitial').textContent = initial;

    const others = loadSavedAccounts().filter(a => a.user_id !== currentUserId);
    const othersHtml = others.map(a => `
      <div class="acct-row" data-uid="${a.user_id}">
        <div class="acct-row-avatar">${(a.username || a.email || '?')[0].toUpperCase()}</div>
        <div>
          <div class="acct-row-name">${a.username || a.email}</div>
          <div class="acct-row-email">${a.email}</div>
        </div>
      </div>`).join('');

    acctPopover.innerHTML = `
      <div class="acct-head">
        <div class="acct-avatar-lg">${initial}</div>
        <div>
          <div class="acct-name">${currentUsername || currentUserEmail}</div>
          <div class="acct-email">${currentUserEmail}</div>
        </div>
      </div>
      <div class="acct-created" id="acctCreatedEl">Account created<br><b>${createdStr}</b></div>
      <div class="acct-actions">
        <button class="acct-btn" id="acctChangeBtn">Change</button>
        <button class="acct-btn" id="acctSignOutBtn">Sign out</button>
      </div>
      <div class="acct-switcher" id="acctSwitcher" style="display:none;">
        ${othersHtml}
        <div class="acct-row acct-row-add" id="acctAddBtn">
          <div class="acct-row-avatar plus">+</div>
          <div class="acct-row-name">Add account</div>
        </div>
      </div>
      <div class="acct-delete" id="acctDeleteBtn">Delete account</div>
    `;

    if(isAdmin()){
      const bcWrap = document.createElement('div');
      bcWrap.className = 'acct-broadcast';
      bcWrap.innerHTML = `
        <label>Send message to everyone</label>
        <div class="acct-broadcast-row">
          <input type="text" id="broadcastInput" placeholder="Твоё сообщение…" maxlength="200">
          <button id="broadcastSendBtn">Send</button>
        </div>`;
      acctPopover.insertBefore(bcWrap, document.getElementById('acctDeleteBtn'));

      const bInput = document.getElementById('broadcastInput');
      const bBtn = document.getElementById('broadcastSendBtn');
      async function sendBroadcast(){
        const msg = bInput.value.trim();
        if(!msg) return;
        bBtn.disabled = true; bBtn.textContent = '…';
        try{
          const { error } = await supabase.from('broadcasts').insert({
            message: msg, created_by: currentUsername || 'Rasvet'
          });
          if(error){ alert('Не получилось отправить: ' + error.message); }
          else { bInput.value = ''; }
        }catch(e){
          alert('Ошибка сети: ' + e.message);
        }
        bBtn.disabled = false; bBtn.textContent = 'Send';
      }
      bBtn.addEventListener('click', sendBroadcast);
      bInput.addEventListener('keydown', e => { if(e.key === 'Enter') sendBroadcast(); });

      const onlineWrap = document.createElement('div');
      onlineWrap.className = 'acct-broadcast';
      onlineWrap.innerHTML = `
        <label>Online count</label>
        <div class="acct-broadcast-row">
          <button id="onlineRealBtn" style="flex:1;background:var(--panel);color:var(--text);">Real</button>
          <button id="onlineCustomBtn" style="flex:1;background:var(--panel);color:var(--text);">Custom</button>
        </div>`;
      acctPopover.insertBefore(onlineWrap, document.getElementById('acctDeleteBtn'));
      document.getElementById('onlineRealBtn').addEventListener('click', openOnlineRealModal);
      document.getElementById('onlineCustomBtn').addEventListener('click', openOnlineCustomModal);
    }

    if(isAdmin()){
      const createdEl = document.getElementById('acctCreatedEl');
      createdEl.style.cursor = 'pointer';
      let tapCount = 0, tapTimer = null;
      createdEl.addEventListener('click', () => {
        tapCount++;
        if(tapCount === 1){
          tapTimer = setTimeout(() => { tapCount = 0; }, 400);
        } else if(tapCount === 2){
          clearTimeout(tapTimer); tapCount = 0;
          openCreatedDateEditor();
        }
      });
    }

    document.getElementById('acctChangeBtn').addEventListener('click', ()=>{
      const sw = document.getElementById('acctSwitcher');
      sw.style.display = sw.style.display === 'none' ? 'flex' : 'none';
    });

    document.getElementById('acctSignOutBtn').addEventListener('click', async ()=>{
      const uid = currentUserId;
      closeAcctPopover();
      await supabase.auth.signOut();
      removeSavedAccount(uid);
    });

    acctPopover.querySelectorAll('.acct-row[data-uid]').forEach(row=>{
      row.addEventListener('click', async ()=>{
        const uid = row.dataset.uid;
        const acc = loadSavedAccounts().find(a => a.user_id === uid);
        if(!acc) return;
        closeAcctPopover();
        const { error } = await supabase.auth.setSession({
          access_token: acc.access_token,
          refresh_token: acc.refresh_token
        });
        if(error){
          alert('Could not switch to that account — the session expired, please sign in to it again.');
          removeSavedAccount(uid);
        }
      });
    });

    document.getElementById('acctAddBtn').addEventListener('click', async ()=>{
      closeAcctPopover();
      // scope:'local' — просто освобождает экран для входа в другой аккаунт,
      // не отзывая токены уже сохранённых аккаунтов
      await supabase.auth.signOut({ scope: 'local' });
    });

    document.getElementById('acctDeleteBtn').addEventListener('click', ()=>{
      closeAcctPopover();
      deleteOverlay.classList.add('visible');
    });
  }

  function renderGuestPopover(){
    acctPopover.innerHTML = `
      <div class="acct-head" style="flex-direction:column; text-align:center; gap:10px;">
        <div class="acct-avatar-lg">?</div>
        <div>
          <div class="acct-name">Гостевой доступ</div>
          <div class="acct-email">Войдите в профиль, чтобы сохранять прогресс</div>
        </div>
      </div>
      <div class="acct-actions">
        <button class="acct-btn" id="acctGoLoginBtn" style="flex:1;">Войти</button>
      </div>`;
    document.getElementById('acctGoLoginBtn').addEventListener('click', exitGuestToLogin);
  }

  acctFab.addEventListener('click', (e)=>{
    e.stopPropagation();
    if(acctPopover.classList.contains('open')){ closeAcctPopover(); return; }
    if(isGuest){ renderGuestPopover(); openAcctPopover(); return; }
    renderAccountPopover(); openAcctPopover();
  });
  document.addEventListener('click', (e)=>{
    if(!acctPopover.classList.contains('open')) return;
    if(!acctPopover.contains(e.target) && !acctFab.contains(e.target)) closeAcctPopover();
  });

  /* ---- delete account ---- */
  document.getElementById('cancelDeleteBtn').addEventListener('click', ()=>{
    deleteOverlay.classList.remove('visible');
  });
  document.getElementById('acceptDeleteBtn').addEventListener('click', async ()=>{
    const btn = document.getElementById('acceptDeleteBtn');
    btn.disabled = true; btn.textContent = 'Deleting…';
    const uid = currentUserId;
    try{
      await supabase.from('profiles').delete().eq('id', uid);
      removeSavedAccount(uid);
      await supabase.auth.signOut();
      // Примечание: анонимный ключ Supabase не может удалить саму запись
      // в auth.users — для полного удаления учётки нужна Edge Function
      // с service_role ключом. Здесь удаляются профиль и данные, и
      // пользователь выходит из системы.
    }catch(err){
      alert('Could not fully delete the account: ' + err.message);
    }
    btn.disabled = false; btn.textContent = 'Accept';
    deleteOverlay.classList.remove('visible');
  });

  /* ================= APP DATA ================= */
  const SKILLS = ['reading','listening','writing','speaking'];
  const LABELS = { reading:'Reading', listening:'Listening', writing:'Writing', speaking:'Speaking' };
  const PARTS = {
    reading:   ['Part 1','Part 2','Part 3'],
    listening: ['Part 1','Part 2','Part 3','Part 4'],
    writing:   ['Task 1','Task 2'],
    speaking:  ['Part 1','Part 2','Part 3']
  };

  function freshConfig(){
    const cfg = {};
    SKILLS.forEach(sk => cfg[sk] = PARTS[sk].map(()=>true));
    return cfg;
  }

  async function getUpload(section){
    const { data, error } = await supabase.from('uploads').select('*').eq('section', section).maybeSingle();
    if(error){ console.error(error); return null; }
    return data;
  }
  async function saveUpload(section, file){
    const path = `${section}/${Date.now()}_${file.name}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true });
    if(upErr) throw upErr;
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const { error: dbErr } = await supabase.from('uploads').upsert({
      section, name: file.name, url: pub.publicUrl, uploaded_at: new Date().toISOString()
    });
    if(dbErr) throw dbErr;
  }
  async function removeUpload(section){
    const { error } = await supabase.from('uploads').delete().eq('section', section);
    if(error) throw error;
  }

  let customMocks = [];
  let mockCounter = 0;
  let currentSection = null;

  const contentEl = document.getElementById('content');
  const navButtons = document.querySelectorAll('.nav-btn');

  function isAdmin(){
    return currentUserEmail === ADMIN_EMAIL;
  }

  function setActiveNav(section){
    navButtons.forEach(b => b.classList.toggle('active', b.dataset.section === section));
  }

  navButtons.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      currentSection = btn.dataset.section;
      setActiveNav(currentSection);
      if(currentSection === 'custommock'){ renderMockList(); }
      else if(currentSection === 'fullmock'){ renderFullMock(); }
      else if(currentSection === 'reading'){ renderReadingSection(); }
      else if(currentSection === 'listening'){ renderListeningSection(); }
      else if(currentSection === 'writing'){ renderWritingSection(); }
      else if(currentSection === 'learning'){ renderLearningSection(); }
      else { renderSkillSection(currentSection); }
    });
  });

  /* ---------- sub-tools: loaded on demand from /docs (used to be 7 MB of base64 inside this file) ---------- */
  async function getEmbeddedDoc(key){
    try{
      const res = await fetch('docs/' + encodeURIComponent(key));
      if(!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    }catch(e){
      console.error('Не удалось загрузить материал', key, e);
      return '<p style="padding:24px;font-family:sans-serif;color:#c23a52">Не удалось загрузить материал. Проверь интернет и обнови страницу.</p>';
    }
  }

  /* ---------- FULLSCREEN TOOL (used by Reading passages/full tests and Writing) ---------- */
  const cachedToolIframes = {};
  let currentToolFileKey = null;
  let currentToolOnExit = null;

  // Auto-save a snapshot whenever the person leaves the app/tab while a
  // Reading/Listening/Writing/Learning tool is open, even if they never hit
  // the in-app exit button (closing the Telegram Mini App, switching apps,
  // or the OS killing the page all skip that button entirely). This is on
  // top of — not instead of — the explicit Save/Cancel choice on exit; it
  // just means progress isn't silently lost if the person never gets that
  // dialog in the first place.
  function autoSaveOpenTool(){
    if(!currentToolFileKey) return;
    const iframe = document.getElementById('fsFrame');
    if(!iframe) return;
    saveToolStateToStorage(currentToolFileKey, iframe); // synchronous local safety net, always attempted first
    // Best-effort server push too. This won't always finish if the page is
    // actually being torn down right this instant, but visibilitychange
    // fires on every tab-switch/app-background too (not only real closes),
    // so most of the time it does complete — and if it doesn't,
    // flushPendingSyncs() catches it on the next reconnect/app open.
    const state = serializeToolState(iframe);
    if(state && currentUserId){
      pushToolStateToServer(currentToolFileKey, state).then(ok => {
        if(ok) clearPendingSync(currentToolFileKey); else markPendingSync(currentToolFileKey);
      });
    }
  }
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'hidden') autoSaveOpenTool(); });
  window.addEventListener('pagehide', autoSaveOpenTool);
  window.addEventListener('beforeunload', autoSaveOpenTool);

  // Speaking and the Grammar "W Training" tool are excluded from the
  // persistence fix below — left exactly as before, per request.
  const NO_PERSIST_TOOLS = ['speaking-ai.html'];

  // Scoped by account (falls back to a shared "guest" bucket when signed
  // out) so progress saved under one account never bleeds into another
  // account on the same device — this app supports switching between saved
  // accounts, and progress needs to follow the account, not the device.
  function toolStorageKey(fileKey){ return 'toolProgress:' + (currentUserId || 'guest') + ':' + fileKey; }

  // Reads current answers out of a live tool iframe in a way that doesn't
  // depend on knowing that tool's internal code:
  //  1) every <input>/<textarea>/<select> with an id
  //  2) every contenteditable element with an id (this is how the Writing
  //     tool's essay boxes work — they're not <textarea>s, so without this
  //     the actual essay text was never captured at all)
  //  3) every element currently marked as an answer choice (class
  //     "selected"/"chosen"/"picked", the pattern Reading & Listening use
  //     for their TRUE/FALSE/NOT GIVEN & multiple-choice buttons)
  //  4) best-effort: if the tool exposes the common top-level `state` /
  //     `currentPassage` variables that the multi-part Listening and full
  //     Reading tests use internally to track every part (not just the one
  //     currently on screen), grab those too via an in-realm eval. Regular
  //     property access (iframe.contentWindow.state) can't see these because
  //     top-level `let`/`const` don't attach to `window`, only `var` does —
  //     eval'ing inside that window's own realm can still reach them. This
  //     is wrapped in try/catch and is purely additive: tools that don't use
  //     this pattern are unaffected.
  function serializeToolState(iframe){
    try{
      const doc = iframe.contentDocument;
      if(!doc || !doc.body) return null;
      const state = { inputs: {}, editable: {}, selected: [] };
      doc.querySelectorAll('input[id], textarea[id], select[id]').forEach(el=>{
        state.inputs[el.id] = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
      });
      doc.querySelectorAll('[contenteditable][id]').forEach(el=>{
        state.editable[el.id] = el.innerHTML;
      });
      doc.querySelectorAll('.selected, .chosen, .picked, .active-choice').forEach(el=>{
        const key = el.id ? ('#' + el.id) : el.getAttribute('onclick');
        if(key) state.selected.push(key);
      });
      try{
        const win = iframe.contentWindow;
        if(win && win.eval){
          const snapshot = win.eval(
            '(function(){ try{ ' +
            '  if(typeof state==="undefined") return null; ' +
            '  return JSON.stringify({ state: state, currentPassage: (typeof currentPassage!=="undefined"?currentPassage:0) }); ' +
            '}catch(e){ return null; } })()'
          );
          if(snapshot) state.globalState = snapshot;
        }
      }catch(e){ /* tool doesn't use this pattern — fine, DOM-level capture above still applies */ }
      return state;
    }catch(e){ console.error('serializeToolState failed', e); return null; }
  }

  // Returns true/false for whether the write actually landed. This return
  // value matters: previously nothing checked it, so the exit toast always
  // claimed "Progress saved" even when localStorage.setItem() silently
  // failed (private/incognito mode, storage disabled by the browser, quota
  // exceeded) — which is exactly the bug being reported: the confirmation
  // shows, but nothing is really there next time.
  function saveToolStateToStorage(fileKey, iframe){
    if(!fileKey || NO_PERSIST_TOOLS.includes(fileKey)) return true; // nothing meant to persist here — not a failure
    // Progress only persists for signed-in accounts. A guest has no
    // account to attach the save to, so there is nothing to write —
    // this also guarantees one guest's in-progress answers on a shared
    // device never leak into another guest session.
    if(!currentUserId) return true;
    const state = serializeToolState(iframe);
    if(!state) return false; // couldn't even read the iframe — genuine failure
    try{
      localStorage.setItem(toolStorageKey(fileKey), JSON.stringify(state));
      // Belt-and-suspenders: some browsers/webviews accept setItem without
      // throwing but don't actually keep the value. Read it straight back
      // to confirm the write really landed before telling the caller (and
      // therefore the person) that it succeeded.
      const verify = localStorage.getItem(toolStorageKey(fileKey));
      return typeof verify === 'string' && verify.length > 0;
    }catch(e){
      console.error('saveToolStateToStorage failed', e);
      return false;
    }
  }

  function clearToolStateFromStorage(fileKey){
    if(!fileKey) return;
    try{ localStorage.removeItem(toolStorageKey(fileKey)); }catch(e){}
  }

  /* ---- Server-side sync (Supabase) for Reading/Listening/Writing/Learning
     progress — this is the real "always there" guarantee. localStorage
     alone can never be 100% reliable: it lives in one specific browser on
     one specific device, and private/incognito modes, "clear data on
     close" settings, storage-restricted in-app browsers, reinstalls, or
     simply opening the site on a different device/browser will all wipe or
     miss it — no client-side trick fixes that, because the data was never
     anywhere but that one local store. Mirroring every save to the
     person's account on the server means progress survives all of that,
     the same way saved chat messages already do in this app.

     Migration — run once in the Supabase SQL editor:
       create table if not exists tool_progress (
         user_id uuid not null,
         file_key text not null,
         state jsonb not null,
         updated_at timestamptz not null default now(),
         primary key (user_id, file_key)
       );
     (No RLS statements here to match how the other tables in this file —
     uploads, group_bans, admin_broadcasts, etc. — are already set up; add
     row-level security consistent with however those are configured.)
  */
  function withTimeout(promise, ms){
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
  }

  // Which fileKeys have local changes the server doesn't have yet (e.g. the
  // last save happened while offline). Tracked per-account so a flaky
  // connection never silently drops progress — it just retries later
  // instead of being treated as successfully saved.
  function pendingSyncStorageKey(){ return 'toolProgressPending:' + (currentUserId || 'guest'); }
  function getPendingSyncKeys(){
    try{ return JSON.parse(localStorage.getItem(pendingSyncStorageKey()) || '[]'); }catch(e){ return []; }
  }
  function markPendingSync(fileKey){
    try{
      const set = new Set(getPendingSyncKeys());
      set.add(fileKey);
      localStorage.setItem(pendingSyncStorageKey(), JSON.stringify([...set]));
    }catch(e){}
  }
  function clearPendingSync(fileKey){
    try{
      const set = new Set(getPendingSyncKeys());
      set.delete(fileKey);
      localStorage.setItem(pendingSyncStorageKey(), JSON.stringify([...set]));
    }catch(e){}
  }

  async function pushToolStateToServer(fileKey, state){
    if(!currentUserId) return false;
    try{
      const { error } = await withTimeout(
        supabase.from('tool_progress').upsert({
          user_id: currentUserId, file_key: fileKey, state, updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,file_key' }),
        8000
      );
      return !error;
    }catch(e){ console.error('pushToolStateToServer failed', e); return false; }
  }

  async function fetchToolStateFromServer(fileKey){
    if(!currentUserId) return null;
    try{
      const { data, error } = await withTimeout(
        supabase.from('tool_progress').select('state,updated_at').eq('user_id', currentUserId).eq('file_key', fileKey).maybeSingle(),
        6000
      );
      if(error || !data) return null;
      return data.state;
    }catch(e){ return null; }
  }

  // Retries every fileKey that couldn't reach the server last time —
  // called on reconnect and shortly after signing in, so a save made while
  // offline still ends up backed up as soon as a connection exists again.
  async function flushPendingSyncs(){
    if(!currentUserId) return;
    for(const fileKey of getPendingSyncKeys()){
      try{
        const raw = localStorage.getItem(toolStorageKey(fileKey));
        if(!raw){ clearPendingSync(fileKey); continue; }
        const ok = await pushToolStateToServer(fileKey, JSON.parse(raw));
        if(ok) clearPendingSync(fileKey);
      }catch(e){}
    }
  }
  window.addEventListener('online', flushPendingSyncs);

  // Saves to both places: localStorage first (instant, synchronous —
  // covers the same-device/same-session case even with no network at all),
  // then the account on the server (the part that makes this reliable
  // across a wiped browser, a reinstall, or a different device). Returns
  // which of the two actually succeeded so the caller can tell the person
  // the truth instead of a blanket "Saved".
  async function persistToolState(fileKey, iframe){
    if(!fileKey || NO_PERSIST_TOOLS.includes(fileKey)) return { local: true, server: true };
    const localOk = saveToolStateToStorage(fileKey, iframe);
    if(!currentUserId) return { local: localOk, server: true }; // guest: no account to back this up to
    const state = serializeToolState(iframe);
    let serverOk = false;
    if(state) serverOk = await pushToolStateToServer(fileKey, state);
    if(serverOk) clearPendingSync(fileKey); else markPendingSync(fileKey);
    return { local: localOk, server: serverOk };
  }

  // Replays a previously-saved answer state into a freshly loaded iframe by
  // setting input/contenteditable content (firing input/change so any
  // oninput handlers run) and re-clicking the same answer buttons the
  // person clicked before — this drives the tool's own selection logic
  // exactly as a real click would, so it stays correct no matter how that
  // tool tracks answers. Also restores the tool's own internal `state` /
  // `currentPassage` (when present — see serializeToolState) and asks it to
  // re-render via `loadPassage`, which recovers answers on parts of a
  // multi-part Listening/Reading test other than the one visible at save
  // time. Returns true once it's confident the restore actually landed, so
  // the caller can retry if the tool's own content hasn't rendered yet.
  function restoreToolState(fileKey, iframe){
    if(!fileKey || NO_PERSIST_TOOLS.includes(fileKey)) return true;
    // No account, nothing was ever saved for it (see saveToolStateToStorage) —
    // don't even look, just report "restore complete" so the caller stops retrying.
    if(!currentUserId) return true;
    let raw;
    try{ raw = localStorage.getItem(toolStorageKey(fileKey)); }catch(e){ return true; }
    if(!raw) return true;
    let state;
    try{ state = JSON.parse(raw); }catch(e){ return true; }
    const doc = iframe.contentDocument;
    if(!doc) return false;

    // Best-effort restore of the tool's own internal state object first —
    // this repopulates parts of the test that aren't the currently-rendered
    // one, then asks the tool to redraw itself from that data.
    if(state.globalState){
      try{
        const win = iframe.contentWindow;
        if(win && win.eval){
          win.eval(
            '(function(){ try{ ' +
            '  var saved = ' + JSON.stringify(state.globalState) + '; ' +
            '  var parsed = JSON.parse(saved); ' +
            '  if(typeof state!=="undefined" && parsed && parsed.state){ ' +
            '    for(var i=0;i<state.length && i<parsed.state.length;i++){ Object.assign(state[i], parsed.state[i]); } ' +
            '  } ' +
            '  if(typeof loadPassage==="function"){ loadPassage(parsed.currentPassage||0); } ' +
            '}catch(e){} })()'
          );
        }
      }catch(e){ /* tool doesn't support this — DOM-level restore below still runs */ }
    }

    let foundAny = false;

    Object.keys(state.inputs || {}).forEach(id=>{
      const el = doc.getElementById(id);
      if(!el) return;
      foundAny = true;
      if(el.type === 'checkbox' || el.type === 'radio') el.checked = state.inputs[id];
      else el.value = state.inputs[id];
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    Object.keys(state.editable || {}).forEach(id=>{
      const el = doc.getElementById(id);
      if(!el) return;
      foundAny = true;
      el.innerHTML = state.editable[id];
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    (state.selected || []).forEach(key=>{
      let el = null;
      if(key.startsWith('#')){
        el = doc.getElementById(key.slice(1));
      } else {
        doc.querySelectorAll('[onclick]').forEach(cand=>{
          if(!el && cand.getAttribute('onclick') === key) el = cand;
        });
      }
      if(el){ foundAny = true; el.click(); }
    });

    // Nothing had matching elements to restore into yet — this is normal
    // for tools (Listening, full Reading tests) that build their question
    // area with JS a beat after the iframe's own load event fires, which is
    // exactly when this function first runs. The caller retries a few times
    // so this eventually catches on once that content exists.
    const hadAnythingToRestore =
      Object.keys(state.inputs || {}).length ||
      Object.keys(state.editable || {}).length ||
      (state.selected || []).length;
    return !hadAnythingToRestore || foundAny;
  }

  function enterFullscreenTool(fileKey, onExit, opts){
    const hideExitBtn = opts && opts.hideExitBtn;
    appEl.classList.add('fs-tool');
    currentToolFileKey = fileKey;
    currentToolOnExit = onExit;
    contentEl.innerHTML = `
      <div class="fs-tool-wrap" id="fsToolWrap">
        ${hideExitBtn ? '' : `<button class="fs-exit-btn" id="fsExitBtn" title="Main menu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>`}
      </div>`;
    const wrap = document.getElementById('fsToolWrap');

    let iframe = cachedToolIframes[fileKey];
    if(iframe){
      wrap.appendChild(iframe); // reattach — keeps all its in-progress state intact
    } else {
      iframe = document.createElement('iframe');
      iframe.className = 'fs-iframe';
      iframe.id = 'fsFrame';
      iframe.setAttribute('allow', 'microphone; autoplay; speaker-selection');
      iframe.setAttribute('allowfullscreen', '');
      // Real fix for the "Save does nothing" bug: the old code only ever
      // kept the previous iframe alive in memory, which is wiped the
      // moment the app/page reloads (e.g. reopening the Mini App) — so
      // "Save" looked like it worked but nothing actually survived. Now,
      // once this freshly-created iframe finishes loading, any progress
      // that was saved to localStorage last time is replayed into it.
      //
      // The Listening tool and the full-length Reading tests build their
      // question area with JavaScript a beat AFTER their own document
      // finishes loading (so the iframe's "load" event — which is what we
      // listen for below — fires before those questions actually exist in
      // the DOM). A single restore attempt right on "load" would silently
      // find nothing to restore into, which is exactly the bug being
      // reported: "Save" shows a confirmation, but reopening shows nothing.
      // So instead of one attempt, retry on a short schedule until either
      // the restore reports success or we give up — this costs nothing for
      // tools that were already ready immediately.
      iframe.addEventListener('load', ()=>{
        const delays = [0, 60, 150, 300, 600, 1000, 1800];
        let attempt = 0;
        const tryRestore = ()=>{
          const ok = restoreToolState(fileKey, iframe);
          attempt++;
          if(!ok && attempt < delays.length) setTimeout(tryRestore, delays[attempt]);
        };
        tryRestore();
        // In parallel, pull the account's copy from the server — this is
        // what recovers progress on a device that never had it locally at
        // all (new phone, reinstalled app, browser data was cleared). If
        // the server has a copy and there's nothing still-unsynced sitting
        // locally, it overwrites the local cache and gets replayed the
        // same way. Purely additive: does nothing when there's no account,
        // no server row yet, or the request times out.
        if(currentUserId && !NO_PERSIST_TOOLS.includes(fileKey) && !getPendingSyncKeys().includes(fileKey)){
          fetchToolStateFromServer(fileKey).then(remote => {
            if(!remote) return;
            if(getPendingSyncKeys().includes(fileKey)) return; // a newer local save started sync in the meantime — don't clobber it
            try{ localStorage.setItem(toolStorageKey(fileKey), JSON.stringify(remote)); }catch(e){}
            restoreToolState(fileKey, iframe);
          }).catch(()=>{});
        }
      }, { once: true });
      wrap.insertAdjacentHTML('beforeend', '<div class="fs-loading">Загрузка…</div>');
      getEmbeddedDoc(fileKey).then(html => {
        const ld = wrap.querySelector('.fs-loading'); if(ld) ld.remove();
        if(!wrap.isConnected) return; // person left before it finished loading
        iframe.srcdoc = html;
        wrap.appendChild(iframe);
      });
    }

    const exitBtn = document.getElementById('fsExitBtn');
    if(exitBtn){
      exitBtn.addEventListener('click', handleToolExit);
    }
  }

  // Guests have nothing to save (see saveToolStateToStorage — it's a no-op
  // without an account), so showing them the "Save data?" dialog is
  // misleading: tapping Save looks like it worked but silently does
  // nothing. For guests we skip the dialog entirely and just reset,
  // exactly like tapping Cancel would. Signed-in users still get the
  // normal Save/Cancel choice.
  function handleToolExit(){
    if(isGuest){ finishExitTool(false); return; }
    confirmExitTool();
  }

  // Shown whenever the person leaves a Reading/Listening/Writing/Learning
  // tool — lets them keep their in-progress work (Save) or wipe it back to
  // a fresh, unsolved state (Cancel). Doesn't apply to the Group/chat area.
  function confirmExitTool(){
    const overlay = makeOverlay(`
      <h3 style="margin:0 0 8px;font-size:1.05rem;">Save data?</h3>
      <div style="font-size:.85rem;color:var(--text-dim);margin-bottom:18px;">
        Save keeps everything you've done so far so it's still there next time.
        Cancel throws it away and leaves it fresh/unsolved.
      </div>
      <div style="display:flex;gap:10px;">
        <button class="acct-btn" id="exitCancelBtn" style="flex:1;">Cancel</button>
        <button class="acct-btn" id="exitSaveBtn" style="flex:1;background:var(--btn);color:#fff;">Save</button>
      </div>
    `, 340);
    document.getElementById('exitSaveBtn').addEventListener('click', () => { overlay.remove(); finishExitTool(true); });
    document.getElementById('exitCancelBtn').addEventListener('click', () => { overlay.remove(); finishExitTool(false); });
  }

  function finishExitTool(save){
    const iframe = document.getElementById('fsFrame');
    const holder = document.getElementById('toolCacheHolder');
    const fileKey = currentToolFileKey;
    let persistPromise = null;
    if(iframe){
      if(save){
        cachedToolIframes[fileKey] = iframe;
        holder.appendChild(iframe); // also parked here for an instant same-session resume
        // Local write happens synchronously inside persistToolState before
        // it hits its first await, so it's already done by the time this
        // line returns — the server round-trip is what keeps running.
        persistPromise = persistToolState(fileKey, iframe);
      } else {
        clearToolStateFromStorage(fileKey);
        clearPendingSync(fileKey);
        delete cachedToolIframes[fileKey];
        iframe.remove(); // fully discarded — next open starts fresh
      }
    }
    appEl.classList.remove('fs-tool');
    const onExit = currentToolOnExit;
    currentToolFileKey = null; currentToolOnExit = null;
    if(onExit) onExit();

    const toast = document.getElementById('broadcastToast');
    if(!toast) return;
    if(!save){
      toast.innerHTML = '↺ Progress cleared — starting fresh next time';
      toast.classList.add('show');
      clearTimeout(toast._hideTimer);
      toast._hideTimer = setTimeout(() => { toast.classList.remove('show'); }, 3000);
      return;
    }
    // Don't make the person wait on the network to see a result — show the
    // optimistic message now (the local half is already done), then
    // correct it once the server round-trip (or its timeout) resolves.
    // This is the actual fix for "says saved but isn't": the message you
    // end up seeing is never disconnected from what really happened —
    // it's just shown in two steps instead of pretending the second one
    // already finished.
    toast.innerHTML = '✓ Progress saved';
    toast.classList.add('show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => { toast.classList.remove('show'); }, 3000);
    if(persistPromise){
      persistPromise.then(result => {
        if(result.server) return; // backed up to the account — matches what's already shown
        const toast2 = document.getElementById('broadcastToast');
        if(!toast2) return;
        toast2.innerHTML = result.local
          ? '✓ Saved on this device — will back up to your account once you\'re back online'
          : '⚠ Not saved — this browser is blocking storage';
        if(!result.local) warnStorageUnavailableIfNeeded();
        toast2.classList.add('show');
        clearTimeout(toast2._hideTimer);
        toast2._hideTimer = setTimeout(() => { toast2.classList.remove('show'); }, 6000);
      });
    }
  }

  /* ---------- READING (Passage 1 / 2 / 3 + Full Test) ----------
     Each tab (Passage 1 / Passage 2 / Passage 3 / Full Test) shows a
     grid of test cards first — nothing opens immediately. Picking a
     card is what opens it fullscreen, exactly like Full Test already
     did. Passage 3's list starts empty; add more entries to any of
     the arrays below as new material comes in — the grid and the
     fullscreen viewer both pick it up automatically. */
  const READING_PASSAGE_SETS = {
    passage1: [
      { id:'p1-1', label:'Test 1', file:'reading-passage-1.html' },
      { id:'p1-2', label:'The Rise of Urban Beekeeping', file:'reading-passage-1-beekeeping.html' },
      { id:'p1-3', label:'Coral Reefs Under Threat', file:'reading-passage-1-coral-reefs-under-threat.html' },
      { id:'p1-4', label:'The Accidental Discovery of Penicillin', file:'reading-passage-1-the-accidental-discovery-of-penicillin.html' },
      { id:'p1-5', label:'The Engineering of Roman Roads', file:'reading-passage-1-the-engineering-of-roman-roads.html' },
      { id:'p1-6', label:'The History of Chocolate', file:'reading-passage-1-the-history-of-chocolate.html' },
      { id:'p1-7', label:'The Invention of the Printing Press', file:'reading-passage-1-the-invention-of-the-printing-press.html' },
      { id:'p1-8', label:'The Migration of Monarch Butterflies', file:'reading-passage-1-the-migration-of-monarch-butterflies.html' },
      { id:'p1-9', label:'The Rise of Vertical Farming', file:'reading-passage-1-the-rise-of-vertical-farming.html' },
      { id:'p1-10', label:'The Science of Sleep', file:'reading-passage-1-the-science-of-sleep.html' }
    ],
    passage2: [
      { id:'p2-1', label:'Test 1', file:'reading-passage-2.html' },
      { id:'p2-2', label:'The Development of Public Libraries', file:'reading-passage-2-the-development-of-public-libraries.html' },
      { id:'p2-3', label:'The Psychology of Colour in Marketing', file:'reading-passage-2-the-psychology-of-colour-in-marketing.html' },
      { id:'p2-4', label:'Harnessing Wind Power', file:'reading-passage-2-harnessing-wind-power.html' },
      { id:'p2-5', label:'The Growth of Online Shopping', file:'reading-passage-2-the-growth-of-online-shopping.html' },
      { id:'p2-6', label:'Urban Green Spaces and Wellbeing', file:'reading-passage-2-urban-green-spaces-and-wellbeing.html' },
      { id:'p2-7', label:'The History of the Magnetic Compass', file:'reading-passage-2-the-history-of-the-magnetic-compass.html' },
      { id:'p2-8', label:'Understanding Nutrition Labels', file:'reading-passage-2-understanding-nutrition-labels.html' },
      { id:'p2-9', label:'The Evolution of Photography', file:'reading-passage-2-the-evolution-of-photography.html' },
      { id:'p2-10', label:'Remote Work and Productivity', file:'reading-passage-2-remote-work-and-productivity.html' }
    ],
    passage3: [
      { id:'p3-1', label:'Artificial Intelligence and Creative Work', file:'reading-passage-3-artificial-intelligence-and-creative-work.html' },
      { id:'p3-2', label:'The Debate Over Genetically Modified Crops', file:'reading-passage-3-the-debate-over-genetically-modified-crops.html' },
      { id:'p3-3', label:'Cognitive Biases in Everyday Decisions', file:'reading-passage-3-cognitive-biases-in-everyday-decisions.html' },
      { id:'p3-4', label:'The Economics of Overfishing', file:'reading-passage-3-the-economics-of-overfishing.html' },
      { id:'p3-5', label:'Language Extinction and Revitalisation', file:'reading-passage-3-language-extinction-and-revitalisation.html' },
      { id:'p3-6', label:'Understanding Black Holes', file:'reading-passage-3-understanding-black-holes.html' },
      { id:'p3-7', label:'Urbanisation and Biodiversity Loss', file:'reading-passage-3-urbanisation-and-biodiversity-loss.html' },
      { id:'p3-8', label:'The Placebo Effect in Medicine', file:'reading-passage-3-the-placebo-effect-in-medicine.html' },
      { id:'p3-9', label:'Automation and the Future of Work', file:'reading-passage-3-automation-and-the-future-of-work.html' },
      { id:'p3-10', label:'The Ethics of Space Exploration', file:'reading-passage-3-the-ethics-of-space-exploration.html' }
    ]
  };
  const READING_FULL_TESTS = [
    { id:'full29', label:'Full Test 1', file:'reading-full-29.html' },
    { id:'full34', label:'Full Test 2', file:'reading-full-34.html' },
    { id:'full35', label:'Full Test 3', file:'reading-full-35.html' },
    { id:'full36', label:'Full Test 4', file:'reading-full-36.html' },
    { id:'full37', label:'Full Test 5', file:'reading-full-37.html' },
    { id:'full38', label:'Full Test 6', file:'reading-full-38.html' },
    { id:'full39', label:'Full Test 7', file:'reading-full-39.html' },
    { id:'full40', label:'Full Test 8', file:'reading-full-40.html' },
    { id:'full41', label:'Full Test 9', file:'reading-full-41.html' },
    { id:'full42', label:'Full Test 10', file:'reading-full-42.html' }
  ];

  const READING_TABS = [
    { id:'passage1', label:'Passage 1', color:'c-blue' },
    { id:'passage2', label:'Passage 2', color:'c-purple' },
    { id:'passage3', label:'Passage 3', color:'c-orange' },
    { id:'full',     label:'Full Test', color:'' }
  ];
  let readingActive = 'full';

  function readingList(tabId){
    return tabId === 'full' ? READING_FULL_TESTS : (READING_PASSAGE_SETS[tabId] || []);
  }

  function renderReadingSection(){
    if(!READING_TABS.some(t => t.id === readingActive)) readingActive = 'full';

    const subnavHtml = `
      <div class="subnav">
        ${READING_TABS.map(t => `
          <button class="subnav-btn ${t.color} ${t.id === readingActive ? 'active' : ''}" data-tab="${t.id}">
            ${t.label}
          </button>`).join('')}
      </div>`;

    const items = readingList(readingActive);
    const subLabel = readingActive === 'full' ? 'Reading · 40 questions' : 'Reading';

    const body = items.length
      ? `<div class="full-list">${items.map((it,i)=>`
          <div class="full-item cycle-border" data-id="${it.id}">
            <div class="fi-icon">${i+1}</div>
            <div class="fi-label">${it.label}</div>
            <div class="fi-sub">${subLabel}</div>
          </div>`).join('')}</div>`
      : `<p style="color:var(--text-faint);font-size:.88rem;">Nothing here yet.</p>`;

    contentEl.innerHTML = `
      <div class="content-head">
        <div><h1>Reading</h1></div>
      </div>
      <div class="pane pane-fill">${subnavHtml}${body}</div>`;

    contentEl.querySelectorAll('.subnav-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        readingActive = btn.dataset.tab;
        renderReadingSection();
      });
    });
    contentEl.querySelectorAll('.full-item').forEach(el=>{
      el.addEventListener('click', ()=>{
        const it = readingList(readingActive).find(x=>x.id===el.dataset.id);
        if(it) openReadingItem(it);
      });
    });
  }

  function openReadingItem(it){
    enterFullscreenTool(it.file, renderReadingSection);
  }

  /* ---------- LISTENING (Full Test — same grid pattern as Reading) ---------- */
  const LISTENING_FULL_TESTS = [
    { id:'lt-1',  label:'Listening Test 1',  file:'listening-test-1.html' },
    { id:'lt-2',  label:'Listening Test 2',  file:'listening-test-2.html' },
    { id:'lt-3',  label:'Listening Test 3',  file:'listening-test-3.html' },
    { id:'lt-4',  label:'Listening Test 4',  file:'listening-test-4.html' },
    { id:'lt-5',  label:'Listening Test 5',  file:'listening-test-5.html' },
    { id:'lt-6',  label:'Listening Test 6',  file:'listening-test-6.html' },
    { id:'lt-7',  label:'Listening Test 7',  file:'listening-test-7.html' },
    { id:'lt-8',  label:'Listening Test 8',  file:'listening-test-8.html' },
    { id:'lt-9',  label:'Listening Test 9',  file:'listening-test-9.html' },
    { id:'lt-10', label:'Listening Test 10', file:'listening-test-10.html' }
  ];

  const LISTENING_TABS = [
    { id:'full', label:'Full Test', color:'' }
  ];
  let listeningActive = 'full';

  function listeningList(tabId){
    return tabId === 'full' ? LISTENING_FULL_TESTS : [];
  }

  function renderListeningSection(){
    if(!LISTENING_TABS.some(t => t.id === listeningActive)) listeningActive = 'full';

    const subnavHtml = `
      <div class="subnav">
        ${LISTENING_TABS.map(t => `
          <button class="subnav-btn ${t.color} ${t.id === listeningActive ? 'active' : ''}" data-tab="${t.id}">
            ${t.label}
          </button>`).join('')}
      </div>`;

    const items = listeningList(listeningActive);
    const subLabel = 'Listening';

    const body = items.length
      ? `<div class="full-list">${items.map((it,i)=>`
          <div class="full-item cycle-border" data-id="${it.id}">
            <div class="fi-icon">${i+1}</div>
            <div class="fi-label">${it.label}</div>
            <div class="fi-sub">${subLabel}</div>
          </div>`).join('')}</div>`
      : `<p style="color:var(--text-faint);font-size:.88rem;">Nothing here yet.</p>`;

    contentEl.innerHTML = `
      <div class="content-head">
        <div><h1>Listening</h1></div>
      </div>
      <div class="pane pane-fill">${subnavHtml}${body}</div>`;

    contentEl.querySelectorAll('.subnav-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        listeningActive = btn.dataset.tab;
        renderListeningSection();
      });
    });
    contentEl.querySelectorAll('.full-item').forEach(el=>{
      el.addEventListener('click', ()=>{
        const it = listeningList(listeningActive).find(x=>x.id===el.dataset.id);
        if(it) openListeningItem(it);
      });
    });
  }

  function openListeningItem(it){
    enterFullscreenTool(it.file, renderListeningSection);
  }

  /* ---------- WRITING (Task 1 / Task 2 — same grid pattern, all blue) ----------
     Cards are labelled "W WRITING Tool" like Reading's Full Test cards are
     labelled "Full Test" — add more entries to WRITING_SETS as new writing
     material comes in. */
  const WRITING_SETS = {
    task1: [
      { id:'w1-1', label:'W WRITING Tool 1', file:'writing-tool.html' }
    ],
    task2: [
      { id:'w2-1', label:'W WRITING Tool 1', file:'writing-tool.html' }
    ]
  };
  const WRITING_TABS = [
    { id:'task1', label:'Task 1' },
    { id:'task2', label:'Task 2' }
  ];
  let writingActive = 'task1';

  function renderWritingSection(){
    if(!WRITING_TABS.some(t => t.id === writingActive)) writingActive = 'task1';

    const subnavHtml = `
      <div class="subnav">
        ${WRITING_TABS.map(t => `
          <button class="subnav-btn c-blue ${t.id === writingActive ? 'active' : ''}" data-tab="${t.id}">
            ${t.label}
          </button>`).join('')}
      </div>`;

    const items = WRITING_SETS[writingActive] || [];
    const body = items.length
      ? `<div class="full-list">${items.map((it,i)=>`
          <div class="full-item cycle-border-blue" data-id="${it.id}">
            <div class="fi-icon">${i+1}</div>
            <div class="fi-label">${it.label}</div>
            <div class="fi-sub">Writing</div>
          </div>`).join('')}</div>`
      : `<p style="color:var(--text-faint);font-size:.88rem;">Nothing here yet.</p>`;

    contentEl.innerHTML = `
      <div class="content-head">
        <div><h1>Writing</h1></div>
      </div>
      <div class="pane pane-fill">${subnavHtml}${body}</div>`;

    contentEl.querySelectorAll('.subnav-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        writingActive = btn.dataset.tab;
        renderWritingSection();
      });
    });
    contentEl.querySelectorAll('.full-item').forEach(el=>{
      el.addEventListener('click', ()=>{
        const it = (WRITING_SETS[writingActive] || []).find(x=>x.id===el.dataset.id);
        if(it) openWritingItem(it);
      });
    });
  }

  function openWritingItem(it){
    enterFullscreenTool(it.file, renderWritingSection);
  }

  /* ---------- LEARNING (Vocabulary / Grammar) ---------- */
  const LEARNING_SETS = {
    vocabulary: [
      { id:'l-vocab-1', label:'W Vocab', file:'w-vocab.html' }
    ],
    grammar: [
      { id:'l-grammar-1', label:'W Training', file:'w-training.html' }
    ]
  };
  const LEARNING_TABS = [
    { id:'vocabulary', label:'Vocabulary', color:'c-purple' },
    { id:'grammar',    label:'Grammar',    color:'c-blue' }
  ];
  let learningActive = 'vocabulary';

  function renderLearningSection(){
    if(!LEARNING_TABS.some(t => t.id === learningActive)) learningActive = 'vocabulary';

    const subnavHtml = `
      <div class="subnav">
        ${LEARNING_TABS.map(t => `
          <button class="subnav-btn ${t.color} ${t.id === learningActive ? 'active' : ''}" data-tab="${t.id}">
            ${t.label}
          </button>`).join('')}
      </div>`;

    const items = LEARNING_SETS[learningActive] || [];
    const body = items.length
      ? `<div class="full-list">${items.map((it,i)=>`
          <div class="full-item cycle-border" data-id="${it.id}">
            <div class="fi-icon">${i+1}</div>
            <div class="fi-label">${it.label}</div>
            <div class="fi-sub">${LABELS_LEARNING[learningActive]}</div>
          </div>`).join('')}</div>`
      : `<p style="color:var(--text-faint);font-size:.88rem;">Nothing here yet.</p>`;

    contentEl.innerHTML = `
      <div class="content-head">
        <div><h1>Learning</h1></div>
      </div>
      <div class="pane pane-fill">${subnavHtml}${body}</div>`;

    contentEl.querySelectorAll('.subnav-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        learningActive = btn.dataset.tab;
        renderLearningSection();
      });
    });
    contentEl.querySelectorAll('.full-item').forEach(el=>{
      el.addEventListener('click', ()=>{
        const it = (LEARNING_SETS[learningActive] || []).find(x=>x.id===el.dataset.id);
        if(it) openLearningItem(it);
      });
    });
  }

  const LABELS_LEARNING = { vocabulary:'Vocabulary', grammar:'Grammar' };

  function openLearningItem(it){
    enterFullscreenTool(it.file, renderLearningSection, { hideExitBtn: true });
  }

  /* Exposed for embedded Learning tools (Vocab/Grammar) — their own "W"
     button calls this (via window.parent) to exit fullscreen back into
     the Learning section grid, same Save/Cancel confirmation as the
     normal fs-exit-btn shows. */
  window.exitToAppMenu = function(){
    currentToolOnExit = renderLearningSection;
    handleToolExit();
  };

  /* ---------- SKILL SECTION (with admin upload) ---------- */
  async function renderSkillSection(section){
    contentEl.innerHTML = `<div class="pane"><p style="color:var(--text-faint)">Loading…</p></div>`;
    const file = await getUpload(section);
    const admin = isAdmin();

    let body;
    if(file){
      body = `
        <div class="upload-card">
          <div class="file-row">
            <div>
              <div class="file-name">${file.name}</div>
              <div class="file-meta">uploaded ${new Date(file.uploaded_at).toLocaleString('en-GB')}</div>
            </div>
          </div>
          <div class="file-actions">
            <a class="mini-btn primary" href="${file.url}" target="_blank" rel="noopener">Open / download</a>
            ${admin ? `<button class="mini-btn" id="replaceFile">Replace</button><button class="mini-btn danger" id="removeFile">Delete</button>` : ``}
          </div>
          ${admin ? `<div class="admin-note">Stored in the cloud and visible to every visitor on any device.</div>` : ``}
        </div>`;
    } else {
      body = `<p style="color:var(--text-faint);font-size:.88rem;">Nothing here yet.</p>`;
    }

    const speakingAiCard = section === 'speaking' ? `
      <div class="full-list" style="margin-bottom:22px;">
        <div class="full-item cycle-border" id="speakingAiCard">
          <div class="fi-icon">🎙️</div>
          <div class="fi-label">Speaking with AI</div>
          <div class="fi-sub">Live voice practice with Duply</div>
        </div>
      </div>` : ``;

    contentEl.innerHTML = `
      <div class="content-head">
        <div>
          <h1>${LABELS[section]}</h1>
        </div>
        ${admin ? `<button class="add-btn" id="uploadPlus" title="Upload file">+</button>` : ``}
      </div>
      <div class="pane">${speakingAiCard}${body}</div>
      <input type="file" id="fileInput" style="display:none">`;

    const speakingAiCardEl = document.getElementById('speakingAiCard');
    if(speakingAiCardEl){
      speakingAiCardEl.addEventListener('click', ()=>{
        enterFullscreenTool('speaking-ai.html', ()=>renderSkillSection(section));
      });
    }

    const fileInput = document.getElementById('fileInput');
    const trigger = () => fileInput.click();
    const plus = document.getElementById('uploadPlus');
    if(plus) plus.addEventListener('click', trigger);
    const replaceBtn = document.getElementById('replaceFile');
    if(replaceBtn) replaceBtn.addEventListener('click', trigger);
    const removeBtn = document.getElementById('removeFile');
    if(removeBtn) removeBtn.addEventListener('click', async ()=>{
      removeBtn.disabled = true;
      try{ await removeUpload(section); } catch(err){ alert('Could not delete: ' + err.message); }
      renderSkillSection(section);
    });

    fileInput.addEventListener('change', async (e)=>{
      const f = e.target.files[0];
      if(!f) return;
      contentEl.querySelector('.pane').innerHTML = `<p style="color:var(--text-faint)">Uploading…</p>`;
      try{
        await saveUpload(section, f);
      }catch(err){
        alert('Could not upload the file: ' + err.message);
      }
      renderSkillSection(section);
    });
  }

  /* ---------- FULL MOCK (ready-made mocks) ----------
     Same materials show up in both Full Mock (straight run-through) and
     Custom Mock (as a base you can then customize). Add entries here as
     mocks get uploaded — both views pick them up automatically. */
  const FULL_MOCKS = [
    // { id:'mock1', label:'Mock 1', file:'full-mock-1.html' }
  ];

  function renderFullMock(){
    const body = FULL_MOCKS.length
      ? `<div class="full-list">${FULL_MOCKS.map((m,i)=>`
          <div class="full-item cycle-border" data-id="${m.id}">
            <div class="fi-icon">${i+1}</div>
            <div class="fi-label">${m.label}</div>
            <div class="fi-sub">Full Mock</div>
          </div>`).join('')}</div>`
      : `<p style="color:var(--text-faint);font-size:.88rem;">Nothing here yet.</p>`;

    contentEl.innerHTML = `
      <div class="content-head">
        <div><h1>Full Mock</h1></div>
      </div>
      <div class="pane pane-fill">${body}</div>`;

    contentEl.querySelectorAll('.full-item').forEach(el=>{
      el.addEventListener('click', ()=>{
        const m = FULL_MOCKS.find(x=>x.id===el.dataset.id);
        if(m) enterFullscreenTool(m.file, renderFullMock);
      });
    });
  }

  /* ---------- CUSTOM MOCK: LIST ---------- */
  function renderMockList(){
    const cards = customMocks.map(m => `
      <div class="mock-card cycle-border" data-id="${m.id}">
        <div class="name">${m.name}</div>
        <div class="meta">${summarize(m.config)}</div>
      </div>`).join('');

    contentEl.innerHTML = `
      <div class="content-head">
        <div><h1>Custom Mock</h1></div>
      </div>
      <div class="pane">
        <div class="mock-grid">
          ${cards}
          <div class="mock-card add" id="addMock">+ Create Custom Mock</div>
        </div>
      </div>`;

    document.getElementById('addMock').addEventListener('click', ()=>{
      if(FULL_MOCKS.length){ renderMockPicker(); }
      else { createCustomMock(null); }
    });

    contentEl.querySelectorAll('.mock-card[data-id]').forEach(card=>{
      card.addEventListener('click', ()=> renderMockConfig(Number(card.dataset.id)));
    });
  }

  function createCustomMock(baseId){
    mockCounter++;
    const base = FULL_MOCKS.find(m => m.id === baseId);
    const m = {
      id: mockCounter,
      name: base ? `Custom ${base.label}` : `Custom Mock ${mockCounter}`,
      baseId: base ? base.id : null,
      config: freshConfig()
    };
    customMocks.push(m);
    renderMockConfig(m.id);
  }

  /* ---------- CUSTOM MOCK: pick a base mock (same materials as Full Mock) ---------- */
  function renderMockPicker(){
    const body = `<div class="full-list">${FULL_MOCKS.map((m,i)=>`
      <div class="full-item cycle-border" data-id="${m.id}">
        <div class="fi-icon">${i+1}</div>
        <div class="fi-label">${m.label}</div>
        <div class="fi-sub">Custom Mock</div>
      </div>`).join('')}</div>`;

    contentEl.innerHTML = `
      <div class="content-head">
        <div>
          <div class="crumb" id="backToList">← Custom Mock</div>
          <h1 style="margin-top:8px;">Choose a base mock</h1>
        </div>
      </div>
      <div class="pane pane-fill">${body}</div>`;

    document.getElementById('backToList').addEventListener('click', renderMockList);
    contentEl.querySelectorAll('.full-item').forEach(el=>{
      el.addEventListener('click', ()=> createCustomMock(el.dataset.id));
    });
  }

  function summarize(cfg){
    const active = SKILLS.filter(sk => cfg[sk].some(Boolean));
    if(active.length === 0) return 'nothing selected';
    return active.map(sk => LABELS[sk]).join(' · ');
  }

  /* ---------- CUSTOM MOCK: CONFIG (unchanged customization UI) ---------- */
  function renderMockConfig(id){
    const mock = customMocks.find(m => m.id === id);
    if(!mock) return renderMockList();

    const cards = SKILLS.map(sk => skillCardHtml(sk, mock.config[sk])).join('');

    contentEl.innerHTML = `
      <div class="content-head">
        <div>
          <div class="crumb" id="backToList">← Custom Mock <span>/ ${mock.name}</span></div>
          <h1 style="margin-top:8px;">${mock.name}</h1>
        </div>
      </div>
      <div class="pane">
        <div class="config-grid" id="configGrid">${cards}</div>
        <div class="order-box">
          <h4>ORDER</h4>
          <div class="order-list" id="orderList"></div>
        </div>
        <div class="actions-row">
          <button class="btn primary" id="startMock">Start Test</button>
          <button class="btn ghost" id="renameMock">Rename</button>
        </div>
      </div>`;

    document.getElementById('backToList').addEventListener('click', renderMockList);
    document.getElementById('startMock').addEventListener('click', ()=>{
      const order = computeOrder(mock.config);
      if(order.length === 0){ alert('Pick at least one part to start.'); return; }
      const base = FULL_MOCKS.find(m => m.id === mock.baseId);
      if(base && base.file){
        enterFullscreenTool(base.file, ()=>renderMockConfig(id));
      } else {
        alert('Materials not uploaded yet. Once they are, the test will run in this order:\n\n' +
          order.map((o,i)=> `${i+1}. ${LABELS[o.sk]} — ${o.parts.join(', ')}`).join('\n'));
      }
    });
    document.getElementById('renameMock').addEventListener('click', ()=>{
      const name = prompt('New name:', mock.name);
      if(name && name.trim()){ mock.name = name.trim(); renderMockConfig(id); }
    });

    bindChips(mock);
    updateOrder(mock);
  }

  function skillCardHtml(sk, activeArr){
    const disabled = !activeArr.some(Boolean);
    const chips = PARTS[sk].map((p,i)=>
      `<div class="part-chip ${activeArr[i] ? 'on':''}" data-sk="${sk}" data-idx="${i}">${p}</div>`
    ).join('');
    return `
      <div class="skill-card ${disabled ? 'disabled':''}" data-skcard="${sk}">
        <div class="sk-head">
          <div class="sk-title">${LABELS[sk]}</div>
          <div class="sk-status"></div>
        </div>
        <div class="parts">${chips}</div>
      </div>`;
  }

  function bindChips(mock){
    document.querySelectorAll('.part-chip').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        const sk = chip.dataset.sk, idx = Number(chip.dataset.idx);
        mock.config[sk][idx] = !mock.config[sk][idx];
        chip.classList.toggle('on', mock.config[sk][idx]);
        const card = document.querySelector(`.skill-card[data-skcard="${sk}"]`);
        const disabled = !mock.config[sk].some(Boolean);
        card.classList.toggle('disabled', disabled);
        updateOrder(mock);
      });
    });
  }

  function computeOrder(cfg){
    return SKILLS
      .map(sk => ({ sk, parts: PARTS[sk].filter((p,i)=> cfg[sk][i]) }))
      .filter(o => o.parts.length > 0);
  }

  function updateOrder(mock){
    const order = computeOrder(mock.config);
    const list = document.getElementById('orderList');
    if(order.length === 0){
      list.innerHTML = `<div class="order-empty">Nothing selected — the test is empty.</div>`;
      return;
    }
    list.innerHTML = order.map((o,i)=> `
      <div class="order-item">
        <span class="num">${i+1}.</span>
        <span class="nm">${LABELS[o.sk]}</span>
        <span class="pt">— ${o.parts.join(', ')}</span>
      </div>`).join('');
  }

})();
