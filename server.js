const fastify = require("fastify");
const fastifyStatic = require("fastify-static");
const crypto = require("crypto");
const path = require("path");

const PORT = +(process.env.PORT || "4587");

const app = fastify();

// In-memory bundle store (use Redis for production)
const bundleStore = new Map();

// Generate unique bundle ID
function generateBundleId() {
  return "bnd_" + crypto.randomBytes(6).toString("hex");
}

// CORS middleware
app.addHook("onRequest", (request, reply, done) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") {
    reply.status(204).send();
    return;
  }
  done();
});

// Store bundle and get shareable ID
app.post("/api/bundle", async (request, reply) => {
  const { files, entry, template } = request.body;

  if (!files || !entry) {
    return reply.status(400).send({ error: "files and entry required" });
  }

  const bundleId = generateBundleId();

  bundleStore.set(bundleId, {
    files,
    entry,
    template: template || null,
    createdAt: Date.now(),
  });

  // Auto-cleanup after 24 hours
  setTimeout(() => bundleStore.delete(bundleId), 24 * 60 * 60 * 1000);

  return { bundleId, previewUrl: `/preview/${bundleId}` };
});

// Get bundle data
app.get("/api/bundle/:bundleId", async (request, reply) => {
  const { bundleId } = request.params;
  const bundle = bundleStore.get(bundleId);

  if (!bundle) {
    return reply.status(404).send({ error: "Bundle not found" });
  }

  return bundle;
});

// Serve static files
app.register(fastifyStatic, {
  root: path.join(__dirname, "dist"),
  prefix: "/",
  cacheControl: true,
  dotfiles: "deny",
  etag: true,
  immutable: true,
  maxAge: 31 * 24 * 60 * 60 * 1000,
});

// Preview route - serves the bundler which will load the bundle
app.get("/preview/:bundleId", async (request, reply) => {
  return reply.sendFile("index.html", { cacheControl: false });
});

// Fallback to index.html
app.setNotFoundHandler((req, reply) => {
  return reply.sendFile("index.html", { cacheControl: false });
});

// Run the server!
app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }

  console.log(`Server is listening on ${address}`);
});
