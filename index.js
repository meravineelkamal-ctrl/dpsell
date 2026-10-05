const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const ROOT = path.join(__dirname, "..");

for (const file of [".env.example", ".env"]) {
  const envPath = path.join(ROOT, file);
  if (!fs.existsSync(envPath)) continue;
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (value) process.env[key] = value;
  }
}

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const STORE_NAME = process.env.STORE_NAME || "DPSELL";
const TRANZUPI_KEY = process.env.TRANZUPI_API_KEY || "";
const TRANZUPI_API = (process.env.TRANZUPI_API_BASE || "https://www.tranzupi.com/api").replace(/\/$/, "");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("Supabase env missing. Copy .env.example to .env and fill keys.");
}

const supabaseAdmin =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      })
    : null;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, "public")));

function publicId() {
  return `DP${Date.now()}${Math.random().toString(36).slice(2, 8)}`.slice(0, 40);
}

function isPaidStatus(value) {
  const v = String(value || "").toLowerCase();
  return ["success", "successful", "paid", "completed", "complete", "true"].includes(v);
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== "") return obj[key];
  }
  return "";
}

function flattenPayload(body = {}, query = {}) {
  const merged = { ...query, ...body };
  if (merged.data && typeof merged.data === "object") Object.assign(merged, merged.data);
  if (merged.result && typeof merged.result === "object") Object.assign(merged, merged.result);
  return merged;
}

async function userFromAuth(req) {
  if (!supabaseAdmin) return null;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

async function isAdmin(userId) {
  const { data } = await supabaseAdmin.from("profiles").select("is_admin").eq("id", userId).maybeSingle();
  return Boolean(data?.is_admin);
}

async function tranzupiForm(endpoint, fields) {
  const res = await fetch(`${TRANZUPI_API}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString()
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`TranzUPI invalid response: ${text.slice(0, 240)}`);
  }
}

function extractPaymentUrl(json) {
  return (
    json.payment_url ||
    json.payment_link ||
    json.result?.payment_url ||
    json.data?.payment_url ||
    json.result?.paymentUrl ||
    null
  );
}

async function markOrderPaid(order, extra = {}) {
  if (order.status === "paid") return { already: true, order };
  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      gateway_ref: extra.gateway_ref || order.gateway_ref || null
    })
    .eq("id", order.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return { already: !data, order: data || order };
}

app.get("/api/config", (_req, res) => {
  res.json({
    storeName: STORE_NAME,
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    publicBase: PUBLIC_BASE
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    store: STORE_NAME,
    tranzupi: Boolean(TRANZUPI_KEY),
    supabase: Boolean(process.env.SUPABASE_URL)
  });
});

app.post("/api/create-order", async (req, res) => {
  try {
    if (!TRANZUPI_KEY) return res.status(500).json({ error: "TRANZUPI_API_KEY missing on server" });
    const user = await userFromAuth(req);
    if (!user) return res.status(401).json({ error: "Google se login karo" });

    const productId = String(req.body.product_id || "").trim();
    const mobile = String(req.body.mobile || "").replace(/\D/g, "").slice(-10);
    if (!productId) return res.status(400).json({ error: "product_id required" });
    if (mobile.length !== 10) return res.status(400).json({ error: "10 digit mobile number daalo" });

    const { data: product, error: pErr } = await supabaseAdmin
      .from("products")
      .select("*")
      .eq("id", productId)
      .eq("is_active", true)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!product) return res.status(404).json({ error: "Product nahi mila" });

    const { data: existingPaid } = await supabaseAdmin
      .from("orders")
      .select("id")
      .eq("user_id", user.id)
      .eq("product_id", productId)
      .eq("status", "paid")
      .maybeSingle();
    if (existingPaid) {
      return res.json({ already_owned: true, library: "/library.html" });
    }

    const orderPublicId = publicId();
    const amount = Number(product.price).toFixed(2);
    const { data: order, error: oErr } = await supabaseAdmin
      .from("orders")
      .insert({
        public_id: orderPublicId,
        user_id: user.id,
        product_id: productId,
        amount: product.price,
        status: "pending",
        customer_mobile: mobile
      })
      .select("*")
      .single();
    if (oErr) throw oErr;

    const redirectUrl = `${PUBLIC_BASE}/success.html?order=${encodeURIComponent(orderPublicId)}`;
    const gateway = await tranzupiForm("create-order", {
      user_token: TRANZUPI_KEY,
      api_key: TRANZUPI_KEY,
      customer_mobile: mobile,
      amount,
      order_id: orderPublicId,
      redirect_url: redirectUrl,
      remark1: product.title.slice(0, 80),
      remark2: user.email || user.id
    });

    const failed =
      String(gateway.status).toLowerCase() === "error" ||
      gateway.error ||
      gateway.status === false;
    if (failed) {
      await supabaseAdmin.from("orders").update({ status: "failed" }).eq("id", order.id);
      return res.status(400).json({ error: gateway.message || gateway.error || "TranzUPI order fail" });
    }

    const paymentUrl = extractPaymentUrl(gateway);
    if (!paymentUrl) {
      return res.status(502).json({ error: "TranzUPI ne payment URL nahi diya. API docs / endpoint check karo." });
    }

    await supabaseAdmin
      .from("orders")
      .update({
        payment_url: paymentUrl,
        gateway_ref: String(gateway.txn_id || gateway.result?.txn_id || gateway.data?.txn_id || "")
      })
      .eq("id", order.id);

    res.json({ order_id: orderPublicId, payment_url: paymentUrl });
  } catch (err) {
    console.error("create-order", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

async function handleWebhook(req, res) {
  try {
    const payload = flattenPayload(req.body, req.query);
    console.log("TranzUPI webhook:", JSON.stringify(payload).slice(0, 1500));
    const orderId = String(
      pick(payload, ["order_id", "orderId", "merchant_order_id", "remark1", "txnid"])
    ).trim();
    const status = pick(payload, ["status", "txnStatus", "txn_status", "payment_status"]);
    if (!orderId) return res.status(200).json({ ok: true, message: "no order_id" });

    const { data: order } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("public_id", orderId)
      .maybeSingle();
    if (!order) return res.status(200).json({ ok: true, message: "unknown order" });

    if (isPaidStatus(status) || String(payload.msg || "").toLowerCase().includes("success")) {
      const gatewayAmount = Number(payload.amount || payload.pay_amount || order.amount);
      if (Number.isFinite(gatewayAmount) && Math.abs(gatewayAmount - Number(order.amount)) > 0.5) {
        console.warn("Amount mismatch", gatewayAmount, order.amount);
        return res.status(200).json({ ok: true, message: "amount mismatch" });
      }
      await markOrderPaid(order, {
        gateway_ref: String(pick(payload, ["utr", "UTR", "txn_id", "txid"]) || "")
      });
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook", err);
    res.status(200).json({ ok: true, error: err.message });
  }
}

app.post("/webhook", handleWebhook);
app.get("/webhook", handleWebhook);
app.post("/api/webhook", handleWebhook);

app.get("/api/order-status", async (req, res) => {
  try {
    const user = await userFromAuth(req);
    if (!user) return res.status(401).json({ error: "login required" });
    const orderId = String(req.query.order_id || "").trim();
    if (!orderId) return res.status(400).json({ error: "order_id required" });
    const { data: order } = await supabaseAdmin
      .from("orders")
      .select("public_id, status, amount, product_id")
      .eq("public_id", orderId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!order) return res.status(404).json({ error: "Order nahi mili" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    const user = await userFromAuth(req);
    if (!user) return res.status(401).json({ error: "login required" });
    const productId = String(req.query.product_id || "").trim();
    if (!productId) return res.status(400).json({ error: "product_id required" });

    const adminUser = await isAdmin(user.id);
    const { data: paid } = await supabaseAdmin
      .from("orders")
      .select("id")
      .eq("user_id", user.id)
      .eq("product_id", productId)
      .eq("status", "paid")
      .maybeSingle();
    if (!paid && !adminUser) return res.status(403).json({ error: "Pehle purchase karo" });

    const { data: product } = await supabaseAdmin
      .from("products")
      .select("file_path, file_name, title")
      .eq("id", productId)
      .maybeSingle();
    if (!product?.file_path) return res.status(404).json({ error: "File missing" });

    const { data, error } = await supabaseAdmin.storage
      .from("downloads")
      .createSignedUrl(product.file_path, 60 * 10);
    if (error) throw error;
    res.json({ url: data.signedUrl, file_name: product.file_name || product.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/mark-paid", async (req, res) => {
  try {
    const user = await userFromAuth(req);
    if (!user || !(await isAdmin(user.id))) return res.status(403).json({ error: "Admin only" });
    const orderId = String(req.body.order_id || "").trim();
    const { data: order } = await supabaseAdmin.from("orders").select("*").eq("public_id", orderId).maybeSingle();
    if (!order) return res.status(404).json({ error: "Order nahi mili" });
    const result = await markOrderPaid(order, { gateway_ref: "manual-admin" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path === "/webhook") return next();
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`${STORE_NAME} running on ${PORT}`);
  console.log(`Webhook: ${PUBLIC_BASE}/webhook`);
});
