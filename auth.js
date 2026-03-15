/* ─────────────────────────────────────────────────────────
   Auth — Login / Registratie
   Beheert gebruikerssessie en synchroniseert instellingen
   met de server-side SQLite database.
   ───────────────────────────────────────────────────────── */

const Auth = (() => {
  const API = "/proxy";
  const KEY_TOKEN    = "auth_token";
  const KEY_USERNAME = "auth_username";
  const KEY_USERID   = "auth_userid";

  // ── Sessie ────────────────────────────────────────────────

  function _store(key, val) {
    try { localStorage.setItem(key, val); } catch(e) {}
    try { sessionStorage.setItem(key, val); } catch(e) {}
  }
  function _read(key) {
    try { const v = sessionStorage.getItem(key); if (v) return v; } catch(e) {}
    try { return localStorage.getItem(key) || ""; } catch(e) {}
    return "";
  }
  function _remove(key) {
    try { localStorage.removeItem(key); } catch(e) {}
    try { sessionStorage.removeItem(key); } catch(e) {}
  }

  function getToken()    { return _read(KEY_TOKEN); }
  function getUsername() { return _read(KEY_USERNAME); }
  function getUserId()   { return parseInt(_read(KEY_USERID) || "0"); }
  function isLoggedIn()  { return getToken().length > 0; }

  function _saveSession(data) {
    _store(KEY_TOKEN,    data.token);
    _store(KEY_USERNAME, data.username);
    _store(KEY_USERID,   String(data.userId));
  }

  function _clearSession() {
    _remove(KEY_TOKEN);
    _remove(KEY_USERNAME);
    _remove(KEY_USERID);
  }

  function _headers(extra = {}) {
    return { "Content-Type": "application/json", "X-Auth-Token": getToken(), ...extra };
  }

  // ── API calls ─────────────────────────────────────────────

  async function register(username, password) {
    const res = await fetch(`${API}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Registratie mislukt.");
    _saveSession(data);
    return data;
  }

  async function login(username, password) {
    const res = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login mislukt.");
    _saveSession(data);
    return data;
  }

  async function logout() {
    await fetch(`${API}/auth/logout`, { method: "POST", headers: _headers() }).catch(() => {});
    _clearSession();
  }

  async function verify() {
    if (!isLoggedIn()) return false;
    try {
      const res = await fetch(`${API}/auth/me`, { headers: _headers() });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Instellingen ophalen/opslaan ──────────────────────────

  async function loadSettings() {
    const res = await fetch(`${API}/user/settings`, { headers: _headers() });
    if (!res.ok) return {};
    return res.json();
  }

  async function saveSettings(obj) {
    await fetch(`${API}/user/settings`, {
      method: "POST",
      headers: _headers(),
      body: JSON.stringify(obj),
    });
  }

  // ── Transacties ophalen/opslaan ───────────────────────────

  async function loadTransactions() {
    const res = await fetch(`${API}/user/transactions`, { headers: _headers() });
    if (!res.ok) return [];
    return res.json();
  }

  async function saveTransactions(transactions) {
    await fetch(`${API}/user/transactions`, {
      method: "POST",
      headers: _headers(),
      body: JSON.stringify(transactions),
    });
  }

  async function loadDividends() {
    const res = await fetch(`${API}/user/dividends`, { headers: _headers() });
    if (!res.ok) return [];
    return res.json();
  }

  async function saveDividends(dividends) {
    await fetch(`${API}/user/dividends`, {
      method: "POST",
      headers: _headers(),
      body: JSON.stringify(dividends),
    });
  }

  return {
    getToken, getUsername, getUserId, isLoggedIn,
    register, login, logout, verify,
    loadSettings, saveSettings,
    loadTransactions, saveTransactions,
    loadDividends, saveDividends,
  };
})();

// ── Login overlay UI ──────────────────────────────────────────

let _pendingLoginUser = null;
let _pendingLoginPass = null;

function renderAuthOverlay() {
  const overlay = document.getElementById("auth-overlay");
  overlay.innerHTML = `
    <div class="auth-box">
      <h1 class="auth-title">Portfolio Analyser</h1>
      <p class="auth-sub">Log in of maak een account aan</p>

      <div class="auth-tabs">
        <button class="auth-tab active" id="auth-tab-login" onclick="authShowTab('login')">Inloggen</button>
        <button class="auth-tab" id="auth-tab-register" onclick="authShowTab('register')">Account aanmaken</button>
      </div>

      <div id="auth-form-login">
        <input class="auth-input" id="auth-login-user" type="text" placeholder="Gebruikersnaam" autocomplete="username">
        <input class="auth-input" id="auth-login-pass" type="password" placeholder="Wachtwoord" autocomplete="current-password">
        <button class="auth-btn" onclick="authDoLogin()">Inloggen</button>
      </div>

      <div id="auth-form-register" style="display:none">
        <input class="auth-input" id="auth-reg-user" type="text" placeholder="Gebruikersnaam" autocomplete="username">
        <input class="auth-input" id="auth-reg-pass" type="password" placeholder="Wachtwoord (min. 6 tekens)" autocomplete="new-password">
        <input class="auth-input" id="auth-reg-pass2" type="password" placeholder="Wachtwoord herhalen" autocomplete="new-password">
        <button class="auth-btn" onclick="authDoRegister()">Account aanmaken</button>
      </div>

      <div id="auth-form-totp" style="display:none">
        <p style="color:var(--muted);font-size:13px;margin-bottom:12px">Voer de 6-cijferige code in uit je authenticator-app.</p>
        <input class="auth-input" id="auth-totp-code" type="text" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code">
        <button class="auth-btn" onclick="authDoTotp()">Bevestigen</button>
        <button class="auth-btn" style="background:var(--surface);border:1px solid var(--border);color:var(--muted);margin-top:8px" onclick="authShowTotpBackup()">Backup code gebruiken</button>
        <div id="auth-totp-backup" style="display:none;margin-top:8px">
          <input class="auth-input" id="auth-backup-code" type="text" placeholder="Backup code (bijv. 4h8f9n2h)" autocomplete="off">
          <button class="auth-btn" onclick="authDoTotpBackup()">Inloggen met backup code</button>
        </div>
      </div>

      <div id="auth-error" class="auth-error" style="display:none"></div>
    </div>
  `;
  overlay.classList.remove("hidden");

  overlay.querySelectorAll(".auth-input").forEach(input => {
    input.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      const loginVisible = document.getElementById("auth-form-login").style.display !== "none";
      const totpVisible  = document.getElementById("auth-form-totp").style.display  !== "none";
      if (totpVisible)  authDoTotp();
      else if (loginVisible) authDoLogin();
      else authDoRegister();
    });
  });
}

function authShowTotpBackup() {
  document.getElementById("auth-totp-backup").style.display = "";
}

function authShowTab(tab) {
  document.getElementById("auth-form-login").style.display    = tab === "login"    ? "" : "none";
  document.getElementById("auth-form-register").style.display = tab === "register" ? "" : "none";
  document.getElementById("auth-tab-login").classList.toggle("active",    tab === "login");
  document.getElementById("auth-tab-register").classList.toggle("active", tab === "register");
  document.getElementById("auth-error").style.display = "none";
}

function authShowError(msg) {
  const el = document.getElementById("auth-error");
  el.textContent = msg;
  el.style.display = "block";
}

async function authDoLogin() {
  const username = document.getElementById("auth-login-user").value.trim();
  const password = document.getElementById("auth-login-pass").value;
  if (!username || !password) { authShowError("Vul alle velden in."); return; }
  const btn = document.querySelector("#auth-form-login .auth-btn");
  btn.disabled = true; btn.textContent = "Bezig...";
  try {
    const res  = await fetch("/proxy/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login mislukt.");
    if (data.totp_required) {
      // Sla credentials op voor de tweede stap
      _pendingLoginUser = username;
      _pendingLoginPass = password;
      document.getElementById("auth-form-login").style.display = "none";
      document.getElementById("auth-form-totp").style.display  = "";
      document.getElementById("auth-totp-code").focus();
      return;
    }
    _saveSession(data);
    await authOnSuccess();
  } catch (e) {
    authShowError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Inloggen";
  }
}

async function authDoTotp() {
  const code = document.getElementById("auth-totp-code").value.trim();
  if (!code) { authShowError("Voer de code in."); return; }
  const btn = document.querySelector("#auth-form-totp .auth-btn");
  btn.disabled = true; btn.textContent = "Bezig...";
  try {
    const res  = await fetch("/proxy/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: _pendingLoginUser, password: _pendingLoginPass, totpCode: code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Code onjuist.");
    _saveSession(data);
    _pendingLoginUser = null; _pendingLoginPass = null;
    await authOnSuccess();
  } catch (e) {
    authShowError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Bevestigen";
  }
}

async function authDoTotpBackup() {
  const code = document.getElementById("auth-backup-code").value.trim();
  if (!code) { authShowError("Voer een backup code in."); return; }
  try {
    const res  = await fetch("/proxy/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: _pendingLoginUser, password: _pendingLoginPass, backupCode: code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Ongeldige backup code.");
    _saveSession(data);
    _pendingLoginUser = null; _pendingLoginPass = null;
    await authOnSuccess();
  } catch (e) {
    authShowError(e.message);
  }
}

async function authDoRegister() {
  const username = document.getElementById("auth-reg-user").value.trim();
  const password = document.getElementById("auth-reg-pass").value;
  const password2 = document.getElementById("auth-reg-pass2").value;
  if (!username || !password) { authShowError("Vul alle velden in."); return; }
  if (password !== password2) { authShowError("Wachtwoorden komen niet overeen."); return; }
  const btn = document.querySelector("#auth-form-register .auth-btn");
  btn.disabled = true; btn.textContent = "Bezig...";
  try {
    await Auth.register(username, password);
    await authOnSuccess();
  } catch (e) {
    authShowError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Account aanmaken";
  }
}

async function authOnSuccess() {
  // Laad gebruikersinstellingen (API keys etc.) vanuit de server
  try {
    const settings = await Auth.loadSettings();
    if (settings.t212_key)    { T212.setApiKey(settings.t212_key); }
    if (settings.t212_secret) { T212.setApiSecret(settings.t212_secret); }
    if (settings.t212_env)    { T212.setEnv(settings.t212_env); }
  } catch (e) {
    console.warn("[auth] Kon instellingen niet laden:", e);
  }

  // Laad transacties vanuit de server in _allTransactions
  try {
    const txs  = await Auth.loadTransactions();
    const divs = await Auth.loadDividends();
    if (typeof _allTransactions !== "undefined") {
      _allTransactions.length = 0;
      _allTransactions.push(...txs);
    }
    if (typeof _allDividends !== "undefined") {
      _allDividends.length = 0;
      _allDividends.push(...divs);
    }
  } catch (e) {
    console.warn("[auth] Kon transacties niet laden:", e);
  }

  // Verberg overlay, toon app
  document.getElementById("auth-overlay").classList.add("hidden");
  document.getElementById("app-root").classList.remove("hidden");

  // Toon gebruikersnaam in header
  const userEl = document.getElementById("header-username");
  if (userEl) userEl.textContent = Auth.getUsername();

  // Start de app
  if (typeof window._startApp === "function") window._startApp();
}

async function authInit() {
  try {
    renderAuthOverlay(); // toon altijd eerst het loginscherm
    if (!Auth.isLoggedIn()) return;
    // Token aanwezig — verifieer met server
    const valid = await Auth.verify();
    if (!valid) {
      Auth.logout();
      return;
    }
    await authOnSuccess();
  } catch (e) {
    console.error("[auth] authInit fout:", e);
    renderAuthOverlay();
  }
}

// ── 2FA beheer ────────────────────────────────────────────────

async function totpLoadStatus() {
  try {
    const res  = await fetch("/proxy/auth/totp/status", { headers: { "X-Auth-Token": Auth.getToken() } });
    const data = await res.json();
    document.getElementById("totp-disabled").style.display = data.enabled ? "none" : "";
    document.getElementById("totp-enabled").style.display  = data.enabled ? "" : "none";
    document.getElementById("totp-setup").style.display         = "none";
    document.getElementById("totp-backup-codes").style.display  = "none";
  } catch (e) { /* stil falen */ }
}

async function totpSetup() {
  try {
    const res  = await fetch("/proxy/auth/totp/setup", {
      method: "POST", headers: { "X-Auth-Token": Auth.getToken() }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById("totp-qr").src         = data.qr;
    document.getElementById("totp-secret").textContent = data.secret;
    document.getElementById("totp-disabled").style.display = "none";
    document.getElementById("totp-setup").style.display    = "";
    document.getElementById("totp-verify-code").value = "";
    document.getElementById("totp-verify-code").focus();
  } catch (e) {
    alert("Fout: " + e.message);
  }
}

function totpCancelSetup() {
  document.getElementById("totp-setup").style.display    = "none";
  document.getElementById("totp-disabled").style.display = "";
}

async function totpConfirm() {
  const code   = document.getElementById("totp-verify-code").value.trim();
  const status = document.getElementById("totp-setup-status");
  if (!code) { status.className = "account-status err"; status.textContent = "Voer de code in."; return; }
  try {
    const res  = await fetch("/proxy/auth/totp/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": Auth.getToken() },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    // Toon backup codes
    document.getElementById("totp-setup").style.display        = "none";
    document.getElementById("totp-backup-codes").style.display = "";
    document.getElementById("totp-codes-list").innerHTML =
      data.backupCodes.map(c => `<span class="totp-code">${c}</span>`).join("");
  } catch (e) {
    status.className = "account-status err";
    status.textContent = e.message;
  }
}

function totpBackupDone() {
  document.getElementById("totp-backup-codes").style.display = "none";
  document.getElementById("totp-enabled").style.display      = "";
}

async function totpDisable() {
  const pw     = document.getElementById("totp-disable-pw").value;
  const status = document.getElementById("totp-disable-status");
  if (!pw) { status.className = "account-status err"; status.textContent = "Voer je wachtwoord in."; return; }
  try {
    const res  = await fetch("/proxy/auth/totp/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": Auth.getToken() },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById("totp-disable-pw").value = "";
    totpLoadStatus();
  } catch (e) {
    status.className = "account-status err";
    status.textContent = e.message;
  }
}

async function authLogout() {
  await Auth.logout();
  location.reload();
}

function _pwStatus(msg, type) {
  const el = document.getElementById("pw-status");
  el.className = `account-status ${type}`;
  el.textContent = msg;
}

async function changePassword() {
  const oldPw = document.getElementById("pw-old").value;
  const newPw = document.getElementById("pw-new").value;
  const newPw2 = document.getElementById("pw-new2").value;
  if (!oldPw || !newPw) { _pwStatus("Vul alle velden in.", "err"); return; }
  if (newPw !== newPw2)  { _pwStatus("Nieuwe wachtwoorden komen niet overeen.", "err"); return; }
  try {
    const res  = await fetch("/proxy/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: Auth.getUsername(), oldPassword: oldPw, newPassword: newPw }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    _pwStatus("Wachtwoord gewijzigd.", "ok");
    document.getElementById("pw-old").value = "";
    document.getElementById("pw-new").value = "";
    document.getElementById("pw-new2").value = "";
  } catch (e) {
    _pwStatus(e.message || "Wijzigen mislukt.", "err");
  }
}

async function requestResetCode() {
  const username = Auth.getUsername();
  try {
    await fetch("/proxy/auth/request-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
  } catch (e) { /* stil falen */ }
  // Toon stap 2 ongeacht resultaat (geef geen info prijs of account bestaat)
  document.getElementById("pw-step1").style.display = "none";
  document.getElementById("pw-step2").style.display = "";
  _pwStatus("Code aangevraagd. Bekijk de proxy-logs op je Pi (docker logs portfolio-proxy).", "ok");
}

async function changePasswordWithCode() {
  const code   = document.getElementById("pw-code").value.trim();
  const newPw  = document.getElementById("pw-new-r").value;
  const newPw2 = document.getElementById("pw-new-r2").value;
  if (!code || !newPw)  { _pwStatus("Vul alle velden in.", "err"); return; }
  if (newPw !== newPw2) { _pwStatus("Wachtwoorden komen niet overeen.", "err"); return; }
  try {
    const res  = await fetch("/proxy/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: Auth.getUsername(), resetToken: code, newPassword: newPw }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    _pwStatus("Wachtwoord gewijzigd. Je wordt uitgelogd...", "ok");
    setTimeout(() => authLogout(), 2000);
  } catch (e) {
    _pwStatus(e.message || "Wijzigen mislukt.", "err");
  }
}
