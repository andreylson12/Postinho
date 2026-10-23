import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regras incorporadas neste arquivo para facilitar upload pelo celular.
const dateNow = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const validDate = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(`${x}T12:00:00Z`)) && new Date(`${x}T12:00:00Z`).toISOString().slice(0, 10) === x;
const validInteger = (x, lo, hi) => typeof x === 'number' && Number.isSafeInteger(x) && x >= lo && x <= hi;
const validId = (x) => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const moneyForLiters = (milliLiters, priceCents) => Math.round(milliLiters * priceCents / 1000);
const safeName = (x, max=80) => typeof x === 'string' ? x.trim().slice(0, max + 1) : '';
const paymentTypes = ['dinheiro', 'pix', 'cartao', 'fiado'];

const { Pool } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
// Ícone, instalação e modo tablet sem pastas extras.
const embeddedManifest = "{\n  \"id\": \"/\",\n  \"name\": \"Postinho Fácil\",\n  \"short_name\": \"Postinho\",\n  \"description\": \"Vendas e fechamento do seu postinho de gasolina\",\n  \"start_url\": \"/\",\n  \"scope\": \"/\",\n  \"display\": \"standalone\",\n  \"background_color\": \"#f5f8f5\",\n  \"theme_color\": \"#124e3c\",\n  \"icons\": [\n    { \"src\": \"/icon.svg\", \"sizes\": \"any\", \"type\": \"image/svg+xml\", \"purpose\": \"any maskable\" }\n  ]\n}\n";
const embeddedIcon = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\">\n  <rect width=\"512\" height=\"512\" rx=\"112\" fill=\"#124e3c\"/>\n  <rect x=\"77\" y=\"66\" width=\"272\" height=\"374\" rx=\"36\" fill=\"#f3bc5e\"/>\n  <rect x=\"111\" y=\"104\" width=\"204\" height=\"137\" rx=\"16\" fill=\"#d2f5e4\"/>\n  <path d=\"M156 177h113\" stroke=\"#124e3c\" stroke-width=\"22\" stroke-linecap=\"round\"/>\n  <path d=\"M126 292h177\" stroke=\"#124e3c\" stroke-width=\"21\" stroke-linecap=\"round\"/>\n  <path d=\"M126 337h120\" stroke=\"#124e3c\" stroke-width=\"21\" stroke-linecap=\"round\"/>\n  <path d=\"M349 167l50 49v146c0 68-24 77-58 77-28 0-45-21-45-48v-50\" fill=\"none\" stroke=\"#f3bc5e\" stroke-width=\"30\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\n  <path d=\"M385 186v54h-39\" fill=\"none\" stroke=\"#f3bc5e\" stroke-width=\"23\" stroke-linecap=\"round\"/>\n</svg>\n";
const embeddedServiceWorker = "// Cache apenas a interface. Nunca armazenar respostas /api nem dados de pagamento.\nconst cacheName='postinho-facil-interface-v1';\nself.addEventListener('install', event => {\n  event.waitUntil(caches.open(cacheName).then(cache=>cache.addAll(['/icon.svg','/manifest.webmanifest'])));\n  self.skipWaiting();\n});\nself.addEventListener('activate', event => {\n  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==cacheName).map(k=>caches.delete(k)))));\n  self.clients.claim();\n});\nself.addEventListener('fetch', event => {\n  const url=new URL(event.request.url);\n  if (url.origin!==self.location.origin || url.pathname.startsWith('/api') || event.request.mode==='navigate') return;\n  if (event.request.method!=='GET') return;\n  event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request)));\n});\n";
const production = process.env.NODE_ENV === 'production';

if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL. Conecte o PostgreSQL do Railway.');
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12 || process.env.ADMIN_PASSWORD.includes('COLOQUE_AQUI')) {
  throw new Error('Configure ADMIN_PASSWORD forte (12+ caracteres) no Railway.');
}

const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000 });
db.on('error', err => console.error('Erro de conexão PostgreSQL', err.message));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '12kb', type: 'application/json' }));
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Os cookies httpOnly NÃO ficam acessíveis pelo JavaScript do tablet.
const adminCookie = 'pf_admin';
const deviceCookie = 'pf_device';
const cookieOptions = (age) => ({ httpOnly: true, secure: production, sameSite: 'lax', path: '/', maxAge: age });
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

function cookieValue(req, name) {
  const match = (req.headers.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : '';
}

function comparePassword(pass) {
  const supplied = crypto.createHash('sha256').update(pass).digest();
  const expected = crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(supplied, expected);
}

async function sessionFor(req, kind) {
  const value = cookieValue(req, kind === 'admin' ? adminCookie : deviceCookie);
  if (!/^[\w-]{40,128}$/.test(value)) return false;
  const result = await db.query(`SELECT 1 FROM auth_sessions
    WHERE token_sha256=$1 AND kind=$2 AND revoked_at IS NULL AND expires_at > NOW()`, [sha(value), kind]);
  return result.rowCount > 0;
}

async function roleFor(req) {
  if (await sessionFor(req, 'admin')) return 'admin';
  if (await sessionFor(req, 'device')) return 'device';
  return 'public';
}

async function requireRole(req, res, next, role) {
  const actual = await roleFor(req);
  if (actual === 'admin' || (role === 'device' && actual === 'device')) return next();
  res.status(403).json({ error: 'Acesso bloqueado. Faça login ou autorize este tablet.' });
}

const requireAdmin = (req, res, next) => { Promise.resolve(requireRole(req,res,next,'admin')).catch(next); };
const requireDevice = (req, res, next) => { Promise.resolve(requireRole(req,res,next,'device')).catch(next); };

function error(res, message, code=400) { return res.status(code).json({ error: message }); }
function properBody(req, res, next) {
  const origin = req.get('Origin');
  const header = req.get('X-Postinho-Request');
  const expected = `${req.protocol}://${req.get('host')}`;
  if (origin && origin !== expected) return error(res, 'Origem não autorizada.', 403);
  if (header !== '1' || !req.is('application/json')) return error(res, 'Requisição inválida.', 403);
  next();
}

const writeLimiter = rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos.' } });
app.use('/api', (req,res,next) => req.method === 'POST' || req.method === 'PUT' ? properBody(req,res,next) : next());
app.use('/api', (req,res,next) => req.method === 'POST' || req.method === 'PUT' ? writeLimiter(req,res,next) : next());

const schema = `
CREATE TABLE IF NOT EXISTS settings (
  id INT PRIMARY KEY CHECK (id=1), business_name VARCHAR(70) NOT NULL DEFAULT 'Meu Postinho',
  sell_price_cents INT NOT NULL DEFAULT 0, cost_price_cents INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_sha256 VARCHAR(64) PRIMARY KEY, kind VARCHAR(12) NOT NULL CHECK (kind IN ('admin','device')),
  label VARCHAR(80) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS sales (
  id UUID PRIMARY KEY, date CHAR(10) NOT NULL, liters_milli INT NOT NULL CHECK(liters_milli BETWEEN 1 AND 500000),
  price_cents INT NOT NULL, cost_cents INT NOT NULL, total_cents INT NOT NULL,
  payment VARCHAR(10) NOT NULL CHECK (payment IN ('dinheiro','pix','cartao','fiado')),
  customer VARCHAR(80) NOT NULL DEFAULT '', payment_status VARCHAR(30) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), dispensed_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ, void_reason VARCHAR(160) NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sales_by_date ON sales(date, created_at DESC);
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY, date CHAR(10) NOT NULL, description VARCHAR(100) NOT NULL,
  amount_cents INT NOT NULL CHECK(amount_cents>0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS expenses_by_date ON expenses(date);
CREATE TABLE IF NOT EXISTS receipts (
  id UUID PRIMARY KEY, sale_id UUID NOT NULL REFERENCES sales(id), date CHAR(10) NOT NULL,
  amount_cents INT NOT NULL CHECK(amount_cents>0),
  payment VARCHAR(10) NOT NULL CHECK (payment IN ('dinheiro','pix','cartao')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS receipts_by_sale ON receipts(sale_id);
CREATE INDEX IF NOT EXISTS receipts_by_date ON receipts(date);
`;

app.get('/api/health', async (_req, res) => {
  await db.query('SELECT 1');
  res.json({ ok: true });
});

app.get('/api/bootstrap', async (req, res) => {
  const role = await roleFor(req);
  const settings = (await db.query('SELECT business_name AS "businessName", sell_price_cents AS "sellPriceCents" FROM settings WHERE id=1')).rows[0];
  const today = dateNow();
  let sales = [];
  if (role !== 'public') {
    sales = (await db.query(`SELECT id, date, liters_milli AS "litersMilli", total_cents AS "totalCents", payment,
      customer, payment_status AS "paymentStatus", created_at AS "createdAt", dispensed_at AS "dispensedAt",
      voided_at AS "voidedAt" FROM sales WHERE date=$1 ORDER BY created_at DESC LIMIT 100`, [today])).rows;
  }
  res.json({ role, today, settings, sales });
});

app.post('/api/auth/login', loginLimiter, async (req,res) => {
  if (typeof req.body?.password !== 'string' || req.body.password.length > 200 || !comparePassword(req.body.password)) {
    return error(res, 'Senha incorreta.', 401);
  }
  const value = token();
  const maxAge = 8 * 60 * 60 * 1000;
  await db.query(`INSERT INTO auth_sessions (token_sha256,kind,label,expires_at)
    VALUES($1,'admin','Administrador',NOW() + INTERVAL '8 hours')`, [sha(value)]);
  res.cookie(adminCookie, value, cookieOptions(maxAge));
  res.json({ ok:true, role:'admin' });
});

app.post('/api/auth/logout', async (req,res) => {
  const value = cookieValue(req, adminCookie);
  if (value) await db.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE token_sha256=$1', [sha(value)]);
  res.clearCookie(adminCookie, { path:'/' });
  res.json({ ok:true });
});

app.post('/api/auth/activate-device', requireAdmin, async (req,res) => {
  const label = safeName(req.body?.label || 'Tablet do postinho', 80);
  const value = token();
  const maxAge = 180 * 24 * 60 * 60 * 1000;
  const old = cookieValue(req, deviceCookie);
  if (old) await db.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE token_sha256=$1', [sha(old)]);
  await db.query(`INSERT INTO auth_sessions (token_sha256,kind,label,expires_at)
    VALUES($1,'device',$2,NOW() + INTERVAL '180 days')`, [sha(value),label]);
  res.cookie(deviceCookie, value, cookieOptions(maxAge));
  res.json({ ok:true });
});

app.post('/api/auth/revoke-devices', requireAdmin, async (_req,res) => {
  await db.query("UPDATE auth_sessions SET revoked_at=NOW() WHERE kind='device' AND revoked_at IS NULL");
  res.clearCookie(deviceCookie, { path:'/' });
  res.json({ ok:true });
});

app.post('/api/sales', requireDevice, async (req,res) => {
  const { id, litersMilli, payment, paidConfirmed } = req.body || {};
  const customer = safeName(req.body?.customer);
  if (!validId(id) || !validInteger(litersMilli,1,500000) || !paymentTypes.includes(payment) || customer.length > 80) {
    return error(res,'Confira os litros e a forma de pagamento.');
  }
  if (payment === 'fiado' && !customer) return error(res,'Informe o nome do cliente fiado.');
  if (payment !== 'fiado' && paidConfirmed !== true) return error(res,'Confirme que recebeu o pagamento antes de registrar.');

  const settings = (await db.query('SELECT sell_price_cents, cost_price_cents FROM settings WHERE id=1')).rows[0];
  if (!settings || settings.sell_price_cents <= 0) return error(res,'O administrador precisa configurar o preço da gasolina.',409);
  const total = moneyForLiters(litersMilli, settings.sell_price_cents);
  const status = payment === 'fiado' ? 'fiado' : 'confirmado_manual';
  await db.query(`INSERT INTO sales (id,date,liters_milli,price_cents,cost_cents,total_cents,payment,customer,payment_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
    [id,dateNow(),litersMilli,settings.sell_price_cents,settings.cost_price_cents,total,payment,
      payment==='fiado'?customer:'',status]);
  const sale = (await db.query(`SELECT id,date,liters_milli AS "litersMilli",total_cents AS "totalCents",payment,
    payment_status AS "paymentStatus",dispensed_at AS "dispensedAt",voided_at AS "voidedAt"
    FROM sales WHERE id=$1`, [id])).rows[0];
  res.json({ ok:true, sale });
});

app.post('/api/sales/:id/dispense', requireDevice, async (req,res) => {
  if (!validId(req.params.id)) return error(res,'Venda inválida.');
  const result = await db.query(`UPDATE sales SET dispensed_at=NOW() WHERE id=$1 AND dispensed_at IS NULL AND voided_at IS NULL
    RETURNING id, dispensed_at AS "dispensedAt"`, [req.params.id]);
  if (!result.rowCount) {
    const existing = (await db.query('SELECT dispensed_at,voided_at FROM sales WHERE id=$1',[req.params.id])).rows[0];
    if (existing?.dispensed_at && !existing?.voided_at) return res.json({ ok:true, alreadyDone:true });
    return error(res,'Venda não encontrada ou anulada.',409);
  }
  res.json({ ok:true, sale:result.rows[0] });
});

app.get('/api/admin/report', requireAdmin, async (req,res) => {
  const date = req.query.date || dateNow();
  if (!validDate(date)) return error(res,'Data inválida.');
  const [sales,expenses,receipts] = await Promise.all([
    db.query(`SELECT id,date,liters_milli AS "litersMilli",price_cents AS "priceCents",cost_cents AS "costCents",
      total_cents AS "totalCents",payment,customer,payment_status AS "paymentStatus",created_at AS "createdAt",
      dispensed_at AS "dispensedAt",voided_at AS "voidedAt",void_reason AS "voidReason"
      FROM sales WHERE date=$1 ORDER BY created_at DESC LIMIT 2000`,[date]),
    db.query(`SELECT id,date,description,amount_cents AS "amountCents",created_at AS "createdAt"
      FROM expenses WHERE date=$1 ORDER BY created_at DESC LIMIT 1000`,[date]),
    db.query(`SELECT id,sale_id AS "saleId",date,amount_cents AS "amountCents",payment,created_at AS "createdAt"
      FROM receipts WHERE date=$1 ORDER BY created_at DESC LIMIT 1000`,[date])
  ]);
  res.json({ date, sales:sales.rows, expenses:expenses.rows, receipts:receipts.rows });
});

app.get('/api/admin/credits', requireAdmin, async (_req,res) => {
  const result = await db.query(`SELECT s.id,s.date,s.customer,s.liters_milli AS "litersMilli",
    s.total_cents AS "totalCents",(s.total_cents-COALESCE(SUM(r.amount_cents),0))::int AS "balanceCents"
    FROM sales s LEFT JOIN receipts r ON r.sale_id=s.id
    WHERE s.payment='fiado' AND s.voided_at IS NULL
    GROUP BY s.id HAVING s.total_cents>COALESCE(SUM(r.amount_cents),0)
    ORDER BY s.date DESC LIMIT 1000`);
  res.json({ credits: result.rows });
});

app.get('/api/admin/settings', requireAdmin, async (_req,res) => {
  const settings = (await db.query(`SELECT business_name AS "businessName",sell_price_cents AS "sellPriceCents",
    cost_price_cents AS "costPriceCents" FROM settings WHERE id=1`)).rows[0];
  res.json(settings);
});

app.post('/api/admin/credits/:id/receipt', requireAdmin, async (req,res) => {
  const { id, amountCents, payment } = req.body || {};
  if (!validId(req.params.id) || !validId(id) || !validInteger(amountCents,1,50_000_000) || !['dinheiro','pix','cartao'].includes(payment)) return error(res,'Dados de recebimento inválidos.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const sale = (await client.query(`SELECT total_cents FROM sales WHERE id=$1 AND payment='fiado' AND voided_at IS NULL FOR UPDATE`,[req.params.id])).rows[0];
    if (!sale) { await client.query('ROLLBACK'); return error(res,'Fiado não encontrado.',404); }
    const previous = await client.query('SELECT id FROM receipts WHERE id=$1',[id]);
    if (previous.rowCount) { await client.query('COMMIT'); return res.json({ ok:true, alreadyDone:true }); }
    const paid = (await client.query('SELECT COALESCE(SUM(amount_cents),0)::int AS value FROM receipts WHERE sale_id=$1',[req.params.id])).rows[0].value;
    if (amountCents > sale.total_cents - paid) { await client.query('ROLLBACK'); return error(res,'Valor acima do saldo restante.'); }
    await client.query(`INSERT INTO receipts (id,sale_id,date,amount_cents,payment) VALUES ($1,$2,$3,$4,$5)`,
      [id,req.params.id,dateNow(),amountCents,payment]);
    await client.query('COMMIT');
    res.json({ ok:true });
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
});

app.post('/api/admin/expenses', requireAdmin, async (req,res) => {
  const {id,amountCents} = req.body || {};
  const description = safeName(req.body?.description,100);
  if (!validId(id) || !validInteger(amountCents,1,50_000_000) || !description || description.length>100) return error(res,'Preencha descrição e valor da despesa.');
  await db.query(`INSERT INTO expenses (id,date,description,amount_cents) VALUES ($1,$2,$3,$4)
    ON CONFLICT (id) DO NOTHING`,[id,dateNow(),description,amountCents]);
  res.json({ ok:true });
});

app.put('/api/admin/settings', requireAdmin, async (req,res) => {
  const name = safeName(req.body?.businessName,70);
  const {sellPriceCents,costPriceCents} = req.body || {};
  if (!name || name.length>70 || !validInteger(sellPriceCents,1,10000) || !validInteger(costPriceCents,0,10000)) return error(res,'Informe o nome e os preços corretos.');
  await db.query(`UPDATE settings SET business_name=$1,sell_price_cents=$2,cost_price_cents=$3,updated_at=NOW() WHERE id=1`,
    [name,sellPriceCents,costPriceCents]);
  res.json({ ok:true });
});

app.post('/api/admin/sales/:id/void', requireAdmin, async (req,res) => {
  const reason = safeName(req.body?.reason,160);
  if (!validId(req.params.id) || !reason || reason.length>160) return error(res,'Informe o motivo da anulação.');
  const result = await db.query(`UPDATE sales SET voided_at=NOW(),void_reason=$2 WHERE id=$1 AND voided_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM receipts WHERE sale_id=$1) RETURNING id`,[req.params.id,reason]);
  if (!result.rowCount) return error(res,'Venda não encontrada, já anulada ou com recebimento de fiado.',409);
  res.json({ ok:true });
});

const page = fs.readFileSync(path.join(here,'index.html'),'utf8');
app.get('/manifest.webmanifest', (_req,res) => res.type('application/manifest+json').send(embeddedManifest));
app.get('/icon.svg', (_req,res) => res.type('image/svg+xml').send(embeddedIcon));
app.get('/sw.js', (_req,res) => {
  res.set('Cache-Control','no-cache');
  res.type('application/javascript').send(embeddedServiceWorker);
});
app.get('/',(_req,res) => {
  const nonce = crypto.randomBytes(18).toString('base64');
  res.set('Content-Security-Policy',`default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'`);
  res.set('Cache-Control','no-cache');
  res.type('html').send(page.replaceAll('__CSP_NONCE__',nonce));
});
app.use((err,_req,res,_next) => {
  console.error('Erro de aplicativo',err);
  if (!res.headersSent) res.status(503).json({ error:'Falha temporária no servidor. Tente novamente sem duplicar a venda.' });
});

try {
  await db.query(schema);
  const port = Number(process.env.PORT || 3000);
  app.listen(port,'0.0.0.0',() => console.log(`Postinho Fácil iniciado na porta ${port}`));
} catch(e) {
  console.error('Não foi possível iniciar o Postinho Fácil:',e);
  process.exitCode=1;
  await db.end();
}
