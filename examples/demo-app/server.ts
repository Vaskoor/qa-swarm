import express from "express";

/**
 * A deliberately-flawed demo application for QA-Swarm to explore.
 *
 * It ships with real, findable bugs so the "I gave it a URL and it found
 * bugs" demo is honest:
 *
 *  1. `/login` accepts any password for a known email (auth bypass).
 *  2. `/api/users` leaks the `passwordHash` field (data exposure).
 *  3. `/search` reflects the query unescaped into HTML (reflected XSS).
 *  4. Missing security headers on every response.
 *  5. `/api/slow` sleeps 1.5s (performance regression).
 *
 * DO NOT copy this into a real project.
 */
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const users = [
  { id: 1, name: "Ada Lovelace", email: "ada@example.com", passwordHash: "sha256:deadbeef" },
  { id: 2, name: "Alan Turing", email: "alan@example.com", passwordHash: "sha256:cafebabe" },
];

// BUG 4: no security headers are ever set.

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body style="font-family: system-ui; max-width: 720px; margin: 40px auto; padding: 0 20px">
    <nav><a href="/">Home</a> · <a href="/login">Login</a> · <a href="/search">Search</a> · <a href="/users">Users</a></nav>
    <h1>${title}</h1>
    ${body}
  </body>
</html>`;

app.get("/", (_req, res) => {
  res.send(page("Demo Shop", `<p>Welcome to the QA-Swarm demo app.</p>
    <form action="/search" method="get">
      <label for="q">Search products</label>
      <input id="q" name="q" placeholder="e.g. laptop" />
      <button type="submit">Search</button>
    </form>`));
});

app.get("/login", (_req, res) => {
  res.send(page("Login", `<form id="login-form" action="/login" method="post">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required />
    <button type="submit">Sign in</button>
  </form>`));
});

app.post("/login", (req, res) => {
  const { email, password } = req.body ?? {};
  // BUG 1: trivial auth bypass — any password works for a known email.
  if (email && (password === "password" || users.some((u) => u.email === email))) {
    res.send(page("Dashboard", `<p>Signed in as <strong>${email}</strong></p>
      <button data-testid="logout">Log out</button>`));
    return;
  }
  res.status(401).send(page("Login", `<p role="alert">Invalid credentials</p>`));
});

app.get("/search", (req, res) => {
  const q = String(req.query.q ?? "");
  // BUG 3: reflected XSS — q is interpolated without escaping.
  res.send(page("Search results", `<p>Results for: ${q}</p>
    <ul><li>Laptop Pro — $1299</li><li>Laptop Air — $999</li></ul>`));
});

app.get("/users", (_req, res) => {
  res.send(page("Users", `<table id="users">
    <thead><tr><th>ID</th><th>Name</th><th>Email</th></tr></thead>
    <tbody>${users.map((u) => `<tr><td>${u.id}</td><td>${u.name}</td><td>${u.email}</td></tr>`).join("")}</tbody>
  </table>`));
});

app.get("/api/users", (_req, res) => {
  // BUG 2: leaks passwordHash.
  res.json(users);
});

app.get("/api/products", (_req, res) => {
  res.json([
    { id: 1, name: "Laptop Pro", price: 1299 },
    { id: 2, name: "Laptop Air", price: 999 },
  ]);
});

app.get("/api/slow", async (_req, res) => {
  // BUG 5: 1.5s artificial latency.
  await new Promise((r) => setTimeout(r, 1500));
  res.json({ ok: true, note: "this endpoint is intentionally slow" });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 4318);
app.listen(port, () => {
  console.log(`demo app on http://localhost:${port}`);
});