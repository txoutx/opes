const state = {
  token: localStorage.getItem("opoweb_token"),
  user: null,
  oppositions: [],
  currentAttemptId: null,
  currentQuestions: [],
  authMode: "login",
  busy: false
};

const $ = selector => document.querySelector(selector);

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Error de conexion");
  return data;
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll("[data-auth-mode]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.authMode === mode);
  });
  $("#password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("#authSubmit").textContent = mode === "login" ? "Entrar" : "Crear cuenta";
}

async function init() {
  document.querySelectorAll("[data-auth-mode]").forEach(btn => btn.addEventListener("click", () => setAuthMode(btn.dataset.authMode)));
  $("#authForm").addEventListener("submit", submitAuth);
  $("#logoutBtn").addEventListener("click", logout);
  $("#oppositionSelect").addEventListener("change", updateSelectedOpposition);
  $("#startTestBtn").addEventListener("click", () => startTest("test"));
  $("#startExamBtn").addEventListener("click", () => startTest("exam"));
  $("#startMistakesBtn").addEventListener("click", startMistakes);
  $("#submitTestBtn").addEventListener("click", submitTest);
  $("#newTestFromResults").addEventListener("click", () => startTest("test"));

  if (state.token) {
    try {
      state.user = await api("/api/me");
      await showApp();
    } catch {
      logout();
    }
  }
}

function setBusy(isBusy, text = "") {
  state.busy = isBusy;
  ["authSubmit", "startTestBtn", "startExamBtn", "startMistakesBtn", "submitTestBtn", "newTestFromResults"].forEach(id => {
    const el = $(`#${id}`);
    if (el) el.disabled = isBusy;
  });
  if (text) setMessage(text, false);
}

function setMessage(text, isError = true) {
  const el = $("#appMessage");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = isError ? "var(--bad)" : "var(--gold)";
}

async function submitAuth(event) {
  event.preventDefault();
  $("#authMessage").textContent = "";
  setBusy(true);
  try {
    const data = await api(`/api/${state.authMode}`, {
      method: "POST",
      body: JSON.stringify({ username: $("#username").value, password: $("#password").value })
    });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("opoweb_token", state.token);
    await showApp();
  } catch (error) {
    $("#authMessage").textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function showApp() {
  $("#authView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  $("#currentUser").textContent = state.user.username;
  const data = await api("/api/oppositions");
  state.oppositions = data.oppositions;
  $("#oppositionSelect").innerHTML = data.oppositions.map(o => `<option value="${o.id}">${escapeHtml(o.name)} (${o.questions})</option>`).join("");
  updateSelectedOpposition();
  await refreshDashboard();
}

function logout() {
  localStorage.removeItem("opoweb_token");
  state.token = null;
  state.user = null;
  state.currentAttemptId = null;
  state.currentQuestions = [];
  $("#appView").classList.add("hidden");
  $("#authView").classList.remove("hidden");
}

function updateSelectedOpposition() {
  const selected = state.oppositions.find(o => o.id === $("#oppositionSelect").value);
  if (!selected) return;
  $("#selectedTitle").textContent = selected.name;
  $("#selectedMeta").textContent = `${selected.questions} preguntas disponibles. Los tests salen solo de este banco.`;
}

async function refreshDashboard() {
  const data = await api("/api/dashboard");
  renderStats(data.stats.topics);
  renderAttempts(data.attempts);
}

function renderStats(topics) {
  if (!topics.length) {
    $("#statsList").innerHTML = `<div class="emptyState">Haz un test y corrígelo para ver tus porcentajes por tema.</div>`;
    return;
  }
  $("#statsList").innerHTML = topics.map(t => `
    <div class="statRow">
      <strong>${escapeHtml(t.topic)}</strong>
      <span class="meta">${escapeHtml(labelForOpposition(t.oppositionId))} - ${t.correct}/${t.total} aciertos, ${t.wrong} fallos</span>
      <div class="bar" title="${t.successRate}% aciertos"><span style="width:${t.successRate}%"></span></div>
      <span class="meta">${t.successRate}% aciertos - ${t.failRate}% fallos</span>
    </div>
  `).join("");
}

function renderAttempts(attempts) {
  if (!attempts.length) {
    $("#attemptList").innerHTML = `<div class="emptyState">Tus últimos resultados aparecerán aquí.</div>`;
    return;
  }
  $("#attemptList").innerHTML = attempts.map(a => `
    <div class="attemptRow">
      <strong>${a.score}/${a.total} (${Math.round((a.score / a.total) * 100)}%)</strong>
      <span class="meta">${escapeHtml(labelForOpposition(a.oppositionId))} - ${modeLabel(a.mode)}</span>
      <span class="meta">${new Date(a.completedAt).toLocaleString()}</span>
    </div>
  `).join("");
}

async function startTest(mode) {
  setBusy(true, mode === "exam" ? "Preparando simulacro..." : "Preparando test...");
  try {
    const data = await api("/api/tests", {
      method: "POST",
      body: JSON.stringify({ oppositionId: $("#oppositionSelect").value, mode })
    });
    renderTest(data, mode);
    setMessage("");
  } catch (error) {
    setMessage(error.message);
  } finally {
    setBusy(false);
  }
}

async function startMistakes() {
  setBusy(true, "Buscando tus fallos...");
  try {
    const data = await api("/api/tests/mistakes", {
      method: "POST",
      body: JSON.stringify({ oppositionId: $("#oppositionSelect").value })
    });
    renderTest(data, "mistakes");
    setMessage("");
  } catch (error) {
    setMessage(error.message);
  } finally {
    setBusy(false);
  }
}

function renderTest(data, mode) {
  state.currentAttemptId = data.attemptId;
  state.currentQuestions = data.questions;
  $("#resultPanel").classList.add("hidden");
  $("#testPanel").classList.remove("hidden");
  $("#testMode").textContent = modeLabel(mode);
  $("#testTitle").textContent = `${labelForOpposition($("#oppositionSelect").value)} - ${data.questions.length} preguntas`;
  $("#answeredCount").textContent = `0/${data.questions.length} respondidas`;
  $("#questionList").innerHTML = data.questions.map((q, index) => `
    <article class="question">
      <span class="pill">${escapeHtml(q.topic || "Sin tema")}</span>
      <h3>${index + 1}. ${escapeHtml(q.prompt)}</h3>
      <div class="options">
        ${Object.entries(q.options).map(([key, value]) => `
          <label class="option">
            <input type="radio" name="q_${q.id}" value="${key}">
            <span><strong>${key.toUpperCase()})</strong> ${escapeHtml(value)}</span>
          </label>
        `).join("")}
      </div>
    </article>
  `).join("");
  $("#questionList").addEventListener("change", updateAnsweredCount, { once: true });
  document.querySelectorAll("#questionList input[type='radio']").forEach(input => input.addEventListener("change", updateAnsweredCount));
  window.scrollTo({ top: $("#testPanel").offsetTop - 12, behavior: "smooth" });
}

function updateAnsweredCount() {
  const answered = new Set([...document.querySelectorAll("#questionList input[type='radio']:checked")].map(input => input.name));
  $("#answeredCount").textContent = `${answered.size}/${state.currentQuestions.length} respondidas`;
}

async function submitTest() {
  const answers = {};
  for (const question of state.currentQuestions) {
    const selected = document.querySelector(`input[name="q_${cssEscape(question.id)}"]:checked`);
    if (selected) answers[question.id] = selected.value;
  }
  setBusy(true, "Corrigiendo...");
  try {
    const data = await api(`/api/tests/${state.currentAttemptId}/submit`, {
      method: "POST",
      body: JSON.stringify({ answers })
    });
    renderResults(data);
    await refreshDashboard();
    setMessage("");
  } catch (error) {
    setMessage(error.message);
  } finally {
    setBusy(false);
  }
}

function renderResults(data) {
  $("#testPanel").classList.add("hidden");
  $("#resultPanel").classList.remove("hidden");
  $("#resultTitle").textContent = `Resultado: ${data.score}/${data.total} (${data.percent}%)`;
  $("#resultList").innerHTML = data.results.map((r, index) => `
    <div class="resultRow ${r.correct ? "ok" : "bad"}">
      <span class="pill">${r.correct ? "Correcta" : "Fallo"} - ${escapeHtml(r.topic || "Sin tema")}</span>
      <strong>${index + 1}. ${escapeHtml(r.prompt)}</strong>
      <span>Tu respuesta: ${formatAnswer(r.selected, r.options)}</span>
      <span>Respuesta correcta: ${formatAnswer(r.correctAnswer, r.options)}</span>
      <span class="meta">${escapeHtml(r.explanation || "")}</span>
    </div>
  `).join("");
  window.scrollTo({ top: $("#resultPanel").offsetTop - 12, behavior: "smooth" });
}

function formatAnswer(key, options) {
  if (!key) return "Sin contestar";
  return `${key.toUpperCase()}) ${escapeHtml(options[key] || "")}`;
}

function labelForOpposition(id) {
  return state.oppositions.find(o => o.id === id)?.name || id;
}

function modeLabel(mode) {
  return { test: "Test 20", exam: "Simulacro 100", mistakes: "Test de fallos" }[mode] || mode;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function cssEscape(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

init();
