const state = {
  token: localStorage.getItem("opoweb_token"),
  user: null,
  oppositions: [],
  selectedOppositionId: null,
  testSets: [],
  mistakeTopics: [],
  libraryMode: "test",
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
  document.querySelectorAll("[data-library-mode]").forEach(btn => btn.addEventListener("click", () => setLibraryMode(btn.dataset.libraryMode)));
  $("#authForm").addEventListener("submit", submitAuth);
  $("#logoutBtn").addEventListener("click", logout);
  $("#resetProgressBtn").addEventListener("click", resetProgress);
  $("#backToOppositionsBtn").addEventListener("click", showOppositionPicker);
  $("#submitTestBtn").addEventListener("click", submitTest);
  $("#newTestFromResults").addEventListener("click", showLibrary);

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
  ["authSubmit", "resetProgressBtn", "submitTestBtn", "newTestFromResults", "backToOppositionsBtn"].forEach(id => {
    const el = $(`#${id}`);
    if (el) el.disabled = isBusy;
  });
  document.querySelectorAll(".oppositionCard, .testSetBtn, .mistakeTopicBtn, [data-library-mode]").forEach(el => {
    el.disabled = isBusy;
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
  renderOppositionMenu();
  showOppositionPicker();
  await refreshDashboard();
}

function logout() {
  localStorage.removeItem("opoweb_token");
  state.token = null;
  state.user = null;
  state.selectedOppositionId = null;
  state.currentAttemptId = null;
  state.currentQuestions = [];
  $("#appView").classList.add("hidden");
  $("#authView").classList.remove("hidden");
}

function renderOppositionMenu() {
  $("#oppositionMenu").innerHTML = state.oppositions.map(o => `
    <button class="oppositionCard" data-opposition-id="${escapeHtml(o.id)}">
      <span class="cardKicker">${escapeHtml(o.questions)} preguntas</span>
      <strong>${escapeHtml(o.name)}</strong>
      <span>Ver tests numerados</span>
    </button>
  `).join("");
  document.querySelectorAll(".oppositionCard").forEach(btn => {
    btn.addEventListener("click", () => selectOpposition(btn.dataset.oppositionId));
  });
}

async function selectOpposition(oppositionId) {
  state.selectedOppositionId = oppositionId;
  setBusy(true, "Cargando tests...");
  try {
    const selected = currentOpposition();
    const data = await api(`/api/test-sets?oppositionId=${encodeURIComponent(oppositionId)}`);
    state.testSets = data.sets;
    $("#selectedTitle").textContent = selected.name;
    $("#selectedMeta").textContent = `${selected.questions} preguntas. ${countSets("test")} tests de 20 y ${countSets("exam")} simulacros de 100.`;
    showLibrary();
    renderTestSets();
    renderMistakeTopics();
    setMessage("");
  } catch (error) {
    setMessage(error.message);
  } finally {
    setBusy(false);
  }
}

function currentOpposition() {
  return state.oppositions.find(o => o.id === state.selectedOppositionId) || state.oppositions[0] || {};
}

function countSets(mode) {
  return state.testSets.filter(set => set.mode === mode).length;
}

function showOppositionPicker() {
  $("#oppositionMenu").classList.remove("hidden");
  $("#libraryPanel").classList.add("hidden");
  $("#testPanel").classList.add("hidden");
  $("#resultPanel").classList.add("hidden");
}

function showLibrary() {
  $("#oppositionMenu").classList.add("hidden");
  $("#libraryPanel").classList.remove("hidden");
  $("#testPanel").classList.add("hidden");
  $("#resultPanel").classList.add("hidden");
  if (state.selectedOppositionId) renderTestSets();
}

function setLibraryMode(mode) {
  state.libraryMode = mode;
  document.querySelectorAll("[data-library-mode]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.libraryMode === mode);
  });
  renderTestSets();
}

function renderTestSets() {
  const sets = state.testSets.filter(set => set.mode === state.libraryMode);
  if (!sets.length) {
    $("#testSetList").innerHTML = `<div class="emptyState">No hay tests preparados para esta opcion.</div>`;
    return;
  }
  $("#testSetList").innerHTML = sets.map(set => `
    <button class="testSetBtn" data-set-id="${escapeHtml(set.id)}">
      <span>${set.mode === "exam" ? "Simulacro" : "Test"}</span>
      <strong>${String(set.number).padStart(2, "0")}</strong>
      <small>${set.count} preguntas</small>
    </button>
  `).join("");
  document.querySelectorAll(".testSetBtn").forEach(btn => {
    btn.addEventListener("click", () => startPreset(btn.dataset.setId));
  });
}

async function refreshDashboard() {
  const data = await api("/api/dashboard");
  state.mistakeTopics = data.stats.mistakeTopics || [];
  renderStats(data.stats.topics);
  renderAttempts(data.attempts);
  renderMistakeTopics();
}

function renderStats(topics) {
  if (!topics.length) {
    $("#statsList").innerHTML = `<div class="emptyState">Haz un test y corrigelo para ver tus porcentajes por tema.</div>`;
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
    $("#attemptList").innerHTML = `<div class="emptyState">Tus ultimos resultados apareceran aqui.</div>`;
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

async function startPreset(setId) {
  setBusy(true, "Abriendo test...");
  try {
    const data = await api("/api/tests", {
      method: "POST",
      body: JSON.stringify({ oppositionId: state.selectedOppositionId, setId })
    });
    const set = state.testSets.find(item => item.id === setId);
    renderTest(data, set?.mode || "test", set?.title || "");
    setMessage("");
  } catch (error) {
    setMessage(error.message);
  } finally {
    setBusy(false);
  }
}

function renderMistakeTopics() {
  const container = $("#mistakeTopicList");
  if (!container) return;
  if (!state.selectedOppositionId) {
    container.innerHTML = `<div class="emptyState compact">Elige una oposicion para ver sus fallos.</div>`;
    return;
  }
  const topics = state.mistakeTopics.filter(t => t.oppositionId === state.selectedOppositionId && t.questions > 0);
  if (!topics.length) {
    container.innerHTML = `<div class="emptyState compact">Todavia no hay fallos en esta oposicion.</div>`;
    return;
  }
  container.innerHTML = topics.map(t => `
    <button class="mistakeTopicBtn" data-topic="${escapeHtml(t.topic)}">
      <strong>${escapeHtml(t.topic)}</strong>
      <span>${t.questions} preguntas falladas - ${t.wrong} fallos</span>
    </button>
  `).join("");
  document.querySelectorAll(".mistakeTopicBtn").forEach(btn => {
    btn.addEventListener("click", () => startMistakes(btn.dataset.topic));
  });
}

async function startMistakes(topic) {
  if (!state.selectedOppositionId) return;
  setBusy(true, "Buscando tus fallos...");
  try {
    const data = await api("/api/tests/mistakes", {
      method: "POST",
      body: JSON.stringify({ oppositionId: state.selectedOppositionId, topic })
    });
    renderTest(data, "mistakes", `Fallos - ${topic}`);
    setMessage("");
  } catch (error) {
    setMessage(error.message);
  } finally {
    setBusy(false);
  }
}

function renderTest(data, mode, title = "") {
  state.currentAttemptId = data.attemptId;
  state.currentQuestions = data.questions;
  $("#libraryPanel").classList.add("hidden");
  $("#resultPanel").classList.add("hidden");
  $("#testPanel").classList.remove("hidden");
  $("#testMode").textContent = modeLabel(mode);
  $("#testTitle").textContent = `${title || modeLabel(mode)} - ${labelForOpposition(state.selectedOppositionId)} - ${data.questions.length} preguntas`;
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
    </div>
  `).join("");
  window.scrollTo({ top: $("#resultPanel").offsetTop - 12, behavior: "smooth" });
}

async function resetProgress() {
  if (!confirm("Esto borrara tus resultados, fallos y actividad. Empezaras de cero. Continuar?")) return;
  setBusy(true, "Reiniciando...");
  try {
    await api("/api/me/progress", { method: "DELETE" });
    state.currentAttemptId = null;
    state.currentQuestions = [];
    await refreshDashboard();
    showOppositionPicker();
    setMessage("Progreso reiniciado. Ya puedes empezar desde cero.", false);
  } catch (error) {
    setMessage(error.message);
  } finally {
    setBusy(false);
  }
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
