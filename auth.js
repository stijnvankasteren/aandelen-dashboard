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

  function getToken()    { return localStorage.getItem(KEY_TOKEN)    || ""; }
  function getUsername() { return localStorage.getItem(KEY_USERNAME) || ""; }
  function getUserId()   { return parseInt(localStorage.getItem(KEY_USERID) || "0"); }
  function isLoggedIn()  { return getToken().length > 0; }

  function _saveSession(data) {
    localStorage.setItem(KEY_TOKEN,    data.token);
    localStorage.setItem(KEY_USERNAME, data.username);
    localStorage.setItem(KEY_USERID,   data.userId);
  }

  function _clearSession() {
    localStorage.removeItem(KEY_TOKEN);
    localStorage.removeItem(KEY_USERNAME);
    localStorage.removeItem(KEY_USERID);
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

      <div id="auth-error" class="auth-error" style="display:none"></div>
    </div>
  `;
  overlay.classList.remove("hidden");

  // Enter key support
  overlay.querySelectorAll(".auth-input").forEach(input => {
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const isLogin = document.getElementById("auth-form-login").style.display !== "none";
        isLogin ? authDoLogin() : authDoRegister();
      }
    });
  });
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
    await Auth.login(username, password);
    await authOnSuccess();
  } catch (e) {
    authShowError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Inloggen";
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
  if (!Auth.isLoggedIn()) {
    renderAuthOverlay();
    return;
  }
  // Token aanwezig — verifieer met server
  const valid = await Auth.verify();
  if (!valid) {
    Auth.logout();
    renderAuthOverlay();
    return;
  }
  await authOnSuccess();
}

async function authLogout() {
  await Auth.logout();
  location.reload();
}

async function changePassword() {
  const oldPw  = document.getElementById("pw-old").value;
  const newPw  = document.getElementById("pw-new").value;
  const newPw2 = document.getElementById("pw-new2").value;
  const status = document.getElementById("pw-status");

  status.className = "account-status";
  status.classList.remove("hidden");

  if (!oldPw || !newPw) { status.className += " err"; status.textContent = "Vul alle velden in."; return; }
  if (newPw !== newPw2) { status.className += " err"; status.textContent = "Nieuwe wachtwoorden komen niet overeen."; return; }

  try {
    const res = await fetch("/proxy/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: Auth.getUsername(), oldPassword: oldPw, newPassword: newPw }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    status.className += " ok";
    status.textContent = "Wachtwoord gewijzigd.";
    document.getElementById("pw-old").value  = "";
    document.getElementById("pw-new").value  = "";
    document.getElementById("pw-new2").value = "";
  } catch (e) {
    status.className += " err";
    status.textContent = e.message || "Wijzigen mislukt.";
  }
}
