const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");

const FILES = {
  questions: path.join(DATA_DIR, "questions.json"),
  users: path.join(DATA_DIR, "users.json"),
  attempts: path.join(DATA_DIR, "attempts.json")
};

const OPPOSITIONS = [
  { id: "tec-sup-economico", name: "Tecnico/a Superior Economico/a", banks: ["tec-sup-economico"] },
  { id: "tec-sup-organizacion", name: "Tecnico/a Superior Organizacion", banks: ["tec-sup-organizacion"] },
  { id: "tec-medio-admin-gestion", name: "Tecnico/a Medio Administracion y Gestion", banks: ["tec-admin-gestion"] },
  { id: "tec-sup-informatica", name: "Tecnico/a Superior Informatica", banks: ["tec-sup-informatica"] },
  { id: "tec-esp-informatica", name: "Tecnico/a Especialista Informatica", banks: ["tec-esp-informatica"] },
  { id: "comun-a-bc1", name: "Comun A-BC1", banks: ["comun-a-bc1"] },
  { id: "comun-c2-c3-d-e", name: "Comun C2-C3-D-E", banks: ["comun-c2-c3-d-e"] }
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

ensureDataFiles();

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILES.questions)) writeJson(FILES.questions, { importedAt: null, banks: [], questions: [] });
  if (!fs.existsSync(FILES.users)) writeJson(FILES.users, []);
  if (!fs.existsSync(FILES.attempts)) writeJson(FILES.attempts, []);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": headers["content-type"] || "application/json; charset=utf-8", ...headers });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 2_000_000) reject(new Error("Payload demasiado grande"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("JSON invalido"));
      }
    });
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored).split(":");
  const actual = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function tokenFor(user) {
  return Buffer.from(JSON.stringify({ userId: user.id, secret: user.secret })).toString("base64url");
}

function currentUser(req) {
  const auth = req.headers.authorization || "";
  const raw = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!raw) return null;
  try {
    const payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const user = readJson(FILES.users).find(u => u.id === payload.userId && u.secret === payload.secret);
    return user || null;
  } catch {
    return null;
  }
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) send(res, 401, { error: "Necesitas iniciar sesion." });
  return user;
}

function banksFor(oppositionId) {
  const found = OPPOSITIONS.find(o => o.id === oppositionId);
  return found ? found.banks : [];
}

function availableQuestions(oppositionId) {
  const data = readJson(FILES.questions);
  const bankIds = banksFor(oppositionId);
  return data.questions.filter(q => bankIds.includes(q.bankId));
}

function userStats(userId) {
  const attempts = readJson(FILES.attempts).filter(a => a.userId === userId && a.completedAt);
  const byTopic = new Map();
  const wrong = new Map();
  for (const attempt of attempts) {
    for (const result of attempt.results || []) {
      const key = `${result.oppositionId}||${result.topic || "Sin tema"}`;
      const entry = byTopic.get(key) || {
        oppositionId: result.oppositionId,
        topic: result.topic || "Sin tema",
        total: 0,
        correct: 0,
        wrong: 0
      };
      entry.total += 1;
      if (result.correct) entry.correct += 1;
      else {
        entry.wrong += 1;
        wrong.set(result.questionId, (wrong.get(result.questionId) || 0) + 1);
      }
      byTopic.set(key, entry);
    }
  }
  return {
    topics: [...byTopic.values()].map(t => ({
      ...t,
      successRate: t.total ? Math.round((t.correct / t.total) * 100) : 0,
      failRate: t.total ? Math.round((t.wrong / t.total) * 100) : 0
    })).sort((a, b) => a.oppositionId.localeCompare(b.oppositionId) || a.topic.localeCompare(b.topic)),
    wrongQuestionIds: [...wrong.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  };
}

function generateQuestions(userId, oppositionId, count, mode, onlyWrong = false) {
  const all = availableQuestions(oppositionId);
  const stats = userStats(userId);
  const recent = recentQuestionIds(userId);
  let pool = onlyWrong ? all.filter(q => stats.wrongQuestionIds.includes(q.id)) : all;
  if (!pool.length) pool = all;

  const byTopic = new Map();
  for (const q of pool) {
    const topic = q.topic || "Sin tema";
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(q);
  }

  const chosen = [];
  const topics = [...byTopic.keys()].sort();
  let cursor = Math.floor(Math.random() * Math.max(1, topics.length));
  while (chosen.length < count && pool.length) {
    const topic = topics[cursor % topics.length];
    const options = byTopic.get(topic) || [];
    const fresh = options.filter(q => !chosen.some(c => c.id === q.id) && !recent.has(q.id));
    const candidates = fresh.length ? fresh : options.filter(q => !chosen.some(c => c.id === q.id));
    const finalPool = candidates.length ? candidates : options;
    chosen.push(finalPool[Math.floor(Math.random() * finalPool.length)]);
    cursor += 1;
  }

  return chosen.slice(0, count).map(q => ({
    id: q.id,
    sourceNumber: q.sourceNumber,
    bankId: q.bankId,
    bankName: q.bankName,
    topic: q.topic,
    prompt: q.prompt,
    options: q.options
  }));
}

function recentQuestionIds(userId) {
  const attempts = readJson(FILES.attempts)
    .filter(a => a.userId === userId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 6);
  return new Set(attempts.flatMap(a => a.questionIds || []));
}

async function handleApi(req, res) {
  try {
    if (req.method === "POST" && req.url === "/api/register") {
      const body = await parseBody(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (username.length < 3 || password.length < 4) return send(res, 400, { error: "Usuario minimo 3 caracteres y contrasena minimo 4." });
      const users = readJson(FILES.users);
      if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) return send(res, 409, { error: "Ese usuario ya existe." });
      const user = { id: crypto.randomUUID(), username, passwordHash: hashPassword(password), secret: crypto.randomBytes(24).toString("hex"), createdAt: new Date().toISOString() };
      users.push(user);
      writeJson(FILES.users, users);
      return send(res, 201, { token: tokenFor(user), user: { id: user.id, username: user.username } });
    }

    if (req.method === "POST" && req.url === "/api/login") {
      const body = await parseBody(req);
      const users = readJson(FILES.users);
      const user = users.find(u => u.username.toLowerCase() === String(body.username || "").trim().toLowerCase());
      if (!user || !verifyPassword(String(body.password || ""), user.passwordHash)) return send(res, 401, { error: "Usuario o contrasena incorrectos." });
      return send(res, 200, { token: tokenFor(user), user: { id: user.id, username: user.username } });
    }

    if (req.method === "GET" && req.url === "/api/me") {
      const user = requireUser(req, res);
      if (!user) return;
      return send(res, 200, { id: user.id, username: user.username });
    }

    if (req.method === "GET" && req.url === "/api/oppositions") {
      const data = readJson(FILES.questions);
      return send(res, 200, {
        oppositions: OPPOSITIONS.map(o => ({ ...o, questions: data.questions.filter(q => o.banks.includes(q.bankId)).length })),
        banks: data.banks,
        importedAt: data.importedAt
      });
    }

    if (req.method === "GET" && req.url === "/api/dashboard") {
      const user = requireUser(req, res);
      if (!user) return;
      const stats = userStats(user.id);
      const attempts = readJson(FILES.attempts).filter(a => a.userId === user.id && a.completedAt);
      return send(res, 200, { stats, attempts: attempts.slice(-12).reverse() });
    }

    if (req.method === "POST" && req.url === "/api/tests") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await parseBody(req);
      const oppositionId = String(body.oppositionId || OPPOSITIONS[0].id);
      const mode = body.mode === "exam" ? "exam" : "test";
      const count = mode === "exam" ? 100 : 20;
      const questions = generateQuestions(user.id, oppositionId, count, mode, false);
      if (!questions.length) return send(res, 404, { error: "No hay preguntas importadas para esta oposicion." });
      const attempt = {
        id: crypto.randomUUID(),
        userId: user.id,
        oppositionId,
        mode,
        createdAt: new Date().toISOString(),
        questionIds: questions.map(q => q.id)
      };
      const attempts = readJson(FILES.attempts);
      attempts.push(attempt);
      writeJson(FILES.attempts, attempts);
      return send(res, 201, { attemptId: attempt.id, questions });
    }

    if (req.method === "POST" && req.url === "/api/tests/mistakes") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await parseBody(req);
      const oppositionId = String(body.oppositionId || OPPOSITIONS[0].id);
      const questions = generateQuestions(user.id, oppositionId, 20, "mistakes", true);
      if (!questions.length) return send(res, 404, { error: "Todavia no hay fallos para crear un test especifico." });
      const attempt = {
        id: crypto.randomUUID(),
        userId: user.id,
        oppositionId,
        mode: "mistakes",
        createdAt: new Date().toISOString(),
        questionIds: questions.map(q => q.id)
      };
      const attempts = readJson(FILES.attempts);
      attempts.push(attempt);
      writeJson(FILES.attempts, attempts);
      return send(res, 201, { attemptId: attempt.id, questions });
    }

    const submitMatch = req.url.match(/^\/api\/tests\/([^/]+)\/submit$/);
    if (req.method === "POST" && submitMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await parseBody(req);
      const attempts = readJson(FILES.attempts);
      const attempt = attempts.find(a => a.id === submitMatch[1] && a.userId === user.id);
      if (!attempt) return send(res, 404, { error: "Test no encontrado." });
      const questionMap = new Map(readJson(FILES.questions).questions.map(q => [q.id, q]));
      const answers = body.answers || {};
      const results = attempt.questionIds.map(id => {
        const q = questionMap.get(id);
        const selected = answers[id] || null;
        return {
          questionId: id,
          oppositionId: attempt.oppositionId,
          topic: q.topic,
          selected,
          correctAnswer: q.correctAnswer,
          correct: selected === q.correctAnswer,
          explanation: q.explanation,
          prompt: q.prompt,
          options: q.options
        };
      });
      attempt.completedAt = new Date().toISOString();
      attempt.results = results;
      attempt.score = results.filter(r => r.correct).length;
      attempt.total = results.length;
      writeJson(FILES.attempts, attempts);
      return send(res, 200, { score: attempt.score, total: attempt.total, percent: Math.round((attempt.score / attempt.total) * 100), results });
    }

    send(res, 404, { error: "Ruta API no encontrada." });
  } catch (error) {
    send(res, 500, { error: error.message || "Error interno" });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = urlPath === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8" });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
  const ext = path.extname(filePath);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return handleApi(req, res);
  serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`OPOWEB listo en http://localhost:${PORT}`);
});
