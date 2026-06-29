const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const FILES = {
  questions: path.join(DATA_DIR, "questions.json"),
  testSets: path.join(DATA_DIR, "test_sets.json"),
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

let sqlClient;
let schemaReady = false;

function databaseUrl() {
  return process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.NEON_DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    "";
}

function hasDatabase() {
  return Boolean(databaseUrl());
}

function canUseLocalFiles() {
  return !hasDatabase() && !process.env.VERCEL;
}

function requireStorage() {
  if (!hasDatabase() && process.env.VERCEL) {
    throw new Error("Falta configurar la base de datos. Conecta Neon/Postgres y añade POSTGRES_URL o DATABASE_URL al proyecto.");
  }
}

async function sql() {
  if (!sqlClient) {
    if (!process.env.POSTGRES_URL && databaseUrl()) {
      process.env.POSTGRES_URL = databaseUrl();
    }
    const mod = await import("@vercel/postgres");
    sqlClient = mod.sql;
  }
  return sqlClient;
}

async function ensureSchema() {
  if (!hasDatabase() || schemaReady) return;
  const db = await sql();
  await db`
    create table if not exists opoweb_users (
      id text primary key,
      username text unique not null,
      password_hash text not null,
      secret text not null,
      created_at timestamptz not null default now()
    )
  `;
  await db`
    create table if not exists opoweb_attempts (
      id text primary key,
      user_id text not null references opoweb_users(id) on delete cascade,
      opposition_id text not null,
      mode text not null,
      created_at timestamptz not null default now(),
      completed_at timestamptz,
      question_ids jsonb not null,
      results jsonb,
      score integer,
      total integer
    )
  `;
  schemaReady = true;
}

function ensureLocalFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILES.questions)) writeJson(FILES.questions, { importedAt: null, banks: [], questions: [] });
  if (!fs.existsSync(FILES.testSets)) writeJson(FILES.testSets, { generatedAt: null, oppositions: [] });
  if (canUseLocalFiles()) {
    if (!fs.existsSync(FILES.users)) writeJson(FILES.users, []);
    if (!fs.existsSync(FILES.attempts)) writeJson(FILES.attempts, []);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function questionsData() {
  return readJson(FILES.questions);
}

function testSetsData() {
  return readJson(FILES.testSets);
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

function normalizePath(req) {
  const parsed = new URL(req.url, "http://localhost");
  return parsed.pathname.replace(/\/$/, "") || "/";
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored).split(":");
  if (!salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function tokenFor(user) {
  return Buffer.from(JSON.stringify({ userId: user.id, secret: user.secret })).toString("base64url");
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

function rowToUser(row) {
  return row && {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    secret: row.secret,
    createdAt: row.created_at
  };
}

function rowToAttempt(row) {
  return row && {
    id: row.id,
    userId: row.user_id,
    oppositionId: row.opposition_id,
    mode: row.mode,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    questionIds: row.question_ids || [],
    results: row.results || null,
    score: row.score,
    total: row.total
  };
}

async function findUserById(id) {
  requireStorage();
  await ensureSchema();
  if (hasDatabase()) {
    const db = await sql();
    const result = await db`select * from opoweb_users where id = ${id} limit 1`;
    return rowToUser(result.rows[0]);
  }
  return readJson(FILES.users).find(user => user.id === id) || null;
}

async function findUserByUsername(username) {
  requireStorage();
  await ensureSchema();
  if (hasDatabase()) {
    const db = await sql();
    const result = await db`select * from opoweb_users where lower(username) = lower(${username}) limit 1`;
    return rowToUser(result.rows[0]);
  }
  return readJson(FILES.users).find(user => user.username.toLowerCase() === username.toLowerCase()) || null;
}

async function createUser(username, password) {
  requireStorage();
  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash: hashPassword(password),
    secret: crypto.randomBytes(24).toString("hex"),
    createdAt: new Date().toISOString()
  };
  await ensureSchema();
  if (hasDatabase()) {
    const db = await sql();
    await db`
      insert into opoweb_users (id, username, password_hash, secret, created_at)
      values (${user.id}, ${user.username}, ${user.passwordHash}, ${user.secret}, ${user.createdAt})
    `;
    return user;
  }
  const users = readJson(FILES.users);
  users.push(user);
  writeJson(FILES.users, users);
  return user;
}

async function getAttempts(userId) {
  requireStorage();
  await ensureSchema();
  if (hasDatabase()) {
    const db = await sql();
    const result = await db`select * from opoweb_attempts where user_id = ${userId} order by created_at asc`;
    return result.rows.map(rowToAttempt);
  }
  return readJson(FILES.attempts).filter(attempt => attempt.userId === userId);
}

async function findAttempt(userId, attemptId) {
  requireStorage();
  await ensureSchema();
  if (hasDatabase()) {
    const db = await sql();
    const result = await db`select * from opoweb_attempts where id = ${attemptId} and user_id = ${userId} limit 1`;
    return rowToAttempt(result.rows[0]);
  }
  return readJson(FILES.attempts).find(a => a.id === attemptId && a.userId === userId) || null;
}

async function saveAttempt(attempt) {
  requireStorage();
  await ensureSchema();
  if (hasDatabase()) {
    const db = await sql();
    await db`
      insert into opoweb_attempts (id, user_id, opposition_id, mode, created_at, question_ids)
      values (${attempt.id}, ${attempt.userId}, ${attempt.oppositionId}, ${attempt.mode}, ${attempt.createdAt}, ${JSON.stringify(attempt.questionIds)}::jsonb)
    `;
    return;
  }
  const attempts = readJson(FILES.attempts);
  attempts.push(attempt);
  writeJson(FILES.attempts, attempts);
}

async function completeAttempt(attempt) {
  requireStorage();
  await ensureSchema();
  if (hasDatabase()) {
    const db = await sql();
    await db`
      update opoweb_attempts
      set completed_at = ${attempt.completedAt},
          results = ${JSON.stringify(attempt.results)}::jsonb,
          score = ${attempt.score},
          total = ${attempt.total}
      where id = ${attempt.id} and user_id = ${attempt.userId}
    `;
    return;
  }
  const attempts = readJson(FILES.attempts);
  const index = attempts.findIndex(a => a.id === attempt.id && a.userId === attempt.userId);
  if (index >= 0) attempts[index] = attempt;
  writeJson(FILES.attempts, attempts);
}

async function resetAttempts(userId) {
  requireStorage();
  await ensureSchema();
  if (hasDatabase()) {
    const db = await sql();
    await db`delete from opoweb_attempts where user_id = ${userId}`;
    return;
  }
  const attempts = readJson(FILES.attempts).filter(a => a.userId !== userId);
  writeJson(FILES.attempts, attempts);
}

async function currentUser(req) {
  const auth = req.headers.authorization || "";
  const raw = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!raw) return null;
  try {
    const payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const user = await findUserById(payload.userId);
    return user && user.secret === payload.secret ? user : null;
  } catch {
    return null;
  }
}

async function requireUser(req, res) {
  const user = await currentUser(req);
  if (!user) send(res, 401, { error: "Necesitas iniciar sesion." });
  return user;
}

function banksFor(oppositionId) {
  const found = OPPOSITIONS.find(o => o.id === oppositionId);
  return found ? found.banks : [];
}

function availableQuestions(oppositionId) {
  const bankIds = banksFor(oppositionId);
  return questionsData().questions.filter(q => bankIds.includes(q.bankId));
}

async function userStats(userId) {
  const attempts = (await getAttempts(userId)).filter(a => a.completedAt);
  const byTopic = new Map();
  const wrong = new Map();
  const wrongByTopic = new Map();
  for (const attempt of attempts) {
    for (const result of attempt.results || []) {
      const topic = result.topic || "Sin tema";
      const key = `${result.oppositionId}||${topic}`;
      const entry = byTopic.get(key) || {
        oppositionId: result.oppositionId,
        topic,
        total: 0,
        correct: 0,
        wrong: 0
      };
      entry.total += 1;
      if (result.correct) entry.correct += 1;
      else {
        entry.wrong += 1;
        wrong.set(result.questionId, (wrong.get(result.questionId) || 0) + 1);
        const wrongTopic = wrongByTopic.get(key) || {
          oppositionId: result.oppositionId,
          topic,
          wrong: 0,
          questionIds: new Map()
        };
        wrongTopic.wrong += 1;
        wrongTopic.questionIds.set(result.questionId, (wrongTopic.questionIds.get(result.questionId) || 0) + 1);
        wrongByTopic.set(key, wrongTopic);
      }
      byTopic.set(key, entry);
    }
  }
  const mistakeTopics = [...wrongByTopic.values()].map(t => ({
    oppositionId: t.oppositionId,
    topic: t.topic,
    wrong: t.wrong,
    questions: t.questionIds.size
  })).sort((a, b) => a.oppositionId.localeCompare(b.oppositionId) || b.wrong - a.wrong || a.topic.localeCompare(b.topic));
  return {
    topics: [...byTopic.values()].map(t => ({
      ...t,
      successRate: t.total ? Math.round((t.correct / t.total) * 100) : 0,
      failRate: t.total ? Math.round((t.wrong / t.total) * 100) : 0
    })).sort((a, b) => a.oppositionId.localeCompare(b.oppositionId) || a.topic.localeCompare(b.topic)),
    mistakeTopics,
    wrongQuestionIds: [...wrong.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  };
}

async function recentQuestionIds(userId) {
  const attempts = (await getAttempts(userId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 6);
  return new Set(attempts.flatMap(a => a.questionIds || []));
}

async function generateQuestions(userId, oppositionId, count, onlyWrong = false, topicFilter = "") {
  const all = availableQuestions(oppositionId);
  const stats = await userStats(userId);
  const recent = await recentQuestionIds(userId);
  let pool = onlyWrong ? all.filter(q => stats.wrongQuestionIds.includes(q.id)) : all;
  if (topicFilter) pool = pool.filter(q => (q.topic || "Sin tema") === topicFilter);
  if (!pool.length) pool = onlyWrong ? [] : all;

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

function publicQuestionsByIds(questionIds) {
  const questionMap = new Map(questionsData().questions.map(q => [q.id, q]));
  return questionIds
    .map(id => questionMap.get(id))
    .filter(Boolean)
    .map(q => ({
      id: q.id,
      sourceNumber: q.sourceNumber,
      bankId: q.bankId,
      bankName: q.bankName,
      topic: q.topic,
      prompt: q.prompt,
      options: q.options
    }));
}

function setsForOpposition(oppositionId) {
  const data = testSetsData();
  return (data.oppositions || []).find(o => o.id === oppositionId)?.sets || [];
}

async function handler(req, res) {
  ensureLocalFiles();
  const urlPath = normalizePath(req);
  try {
    if (req.method === "GET" && urlPath === "/api/health") {
      return send(res, 200, { ok: true, storage: hasDatabase() ? "postgres" : "local-json" });
    }

    if (req.method === "POST" && urlPath === "/api/register") {
      const body = await parseBody(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (username.length < 3 || password.length < 4) return send(res, 400, { error: "Usuario minimo 3 caracteres y contrasena minimo 4." });
      if (await findUserByUsername(username)) return send(res, 409, { error: "Ese usuario ya existe." });
      const user = await createUser(username, password);
      return send(res, 201, { token: tokenFor(user), user: publicUser(user) });
    }

    if (req.method === "POST" && urlPath === "/api/login") {
      const body = await parseBody(req);
      const user = await findUserByUsername(String(body.username || "").trim());
      if (!user || !verifyPassword(String(body.password || ""), user.passwordHash)) return send(res, 401, { error: "Usuario o contrasena incorrectos." });
      return send(res, 200, { token: tokenFor(user), user: publicUser(user) });
    }

    if (req.method === "GET" && urlPath === "/api/me") {
      const user = await requireUser(req, res);
      if (!user) return;
      return send(res, 200, publicUser(user));
    }

    if (req.method === "GET" && urlPath === "/api/oppositions") {
      const data = questionsData();
      return send(res, 200, {
        oppositions: OPPOSITIONS.map(o => ({ ...o, questions: data.questions.filter(q => o.banks.includes(q.bankId)).length })),
        banks: data.banks,
        importedAt: data.importedAt
      });
    }

    if (req.method === "GET" && urlPath === "/api/dashboard") {
      const user = await requireUser(req, res);
      if (!user) return;
      const stats = await userStats(user.id);
      const attempts = (await getAttempts(user.id)).filter(a => a.completedAt);
      return send(res, 200, { stats, attempts: attempts.slice(-12).reverse() });
    }

    if (req.method === "DELETE" && urlPath === "/api/me/progress") {
      const user = await requireUser(req, res);
      if (!user) return;
      await resetAttempts(user.id);
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && urlPath === "/api/test-sets") {
      const parsed = new URL(req.url, "http://localhost");
      const oppositionId = String(parsed.searchParams.get("oppositionId") || OPPOSITIONS[0].id);
      const sets = setsForOpposition(oppositionId).map(set => ({
        id: set.id,
        number: set.number,
        mode: set.mode,
        title: set.title,
        count: set.questionIds.length
      }));
      return send(res, 200, { oppositionId, sets });
    }

    if (req.method === "POST" && urlPath === "/api/tests") {
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await parseBody(req);
      const oppositionId = String(body.oppositionId || OPPOSITIONS[0].id);
      const requestedSet = String(body.setId || "");
      const preset = setsForOpposition(oppositionId).find(set => set.id === requestedSet);
      const mode = preset ? preset.mode : (body.mode === "exam" ? "exam" : "test");
      const count = mode === "exam" ? 100 : 20;
      const questions = preset ? publicQuestionsByIds(preset.questionIds) : await generateQuestions(user.id, oppositionId, count, false);
      if (!questions.length) return send(res, 404, { error: "No hay preguntas importadas para esta oposicion." });
      const attempt = {
        id: crypto.randomUUID(),
        userId: user.id,
        oppositionId,
        mode,
        setId: preset?.id || null,
        setTitle: preset?.title || null,
        createdAt: new Date().toISOString(),
        questionIds: questions.map(q => q.id)
      };
      await saveAttempt(attempt);
      return send(res, 201, { attemptId: attempt.id, setTitle: attempt.setTitle, questions });
    }

    if (req.method === "POST" && urlPath === "/api/tests/mistakes") {
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await parseBody(req);
      const oppositionId = String(body.oppositionId || OPPOSITIONS[0].id);
      const topic = String(body.topic || "");
      const questions = await generateQuestions(user.id, oppositionId, 20, true, topic);
      if (!questions.length) return send(res, 404, { error: "Todavia no hay fallos para crear un test especifico." });
      const attempt = {
        id: crypto.randomUUID(),
        userId: user.id,
        oppositionId,
        mode: "mistakes",
        topic,
        createdAt: new Date().toISOString(),
        questionIds: questions.map(q => q.id)
      };
      await saveAttempt(attempt);
      return send(res, 201, { attemptId: attempt.id, topic, questions });
    }

    const submitMatch = urlPath.match(/^\/api\/tests\/([^/]+)\/submit$/);
    if (req.method === "POST" && submitMatch) {
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await parseBody(req);
      const attempt = await findAttempt(user.id, submitMatch[1]);
      if (!attempt) return send(res, 404, { error: "Test no encontrado." });
      const questionMap = new Map(questionsData().questions.map(q => [q.id, q]));
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
          prompt: q.prompt,
          options: q.options
        };
      });
      const completed = {
        ...attempt,
        completedAt: new Date().toISOString(),
        results,
        score: results.filter(r => r.correct).length,
        total: results.length
      };
      await completeAttempt(completed);
      return send(res, 200, { score: completed.score, total: completed.total, percent: Math.round((completed.score / completed.total) * 100), results });
    }

    return send(res, 404, { error: "Ruta API no encontrada." });
  } catch (error) {
    const needsDb = /@vercel\/postgres|POSTGRES|connect|fetch failed/i.test(error.message || "");
    return send(res, 500, {
      error: needsDb
        ? "No se pudo conectar con Vercel Postgres. Revisa que POSTGRES_URL exista en Variables de entorno."
        : (error.message || "Error interno")
    });
  }
}

module.exports = handler;
module.exports.handler = handler;
