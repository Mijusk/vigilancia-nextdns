// Vigilante NextDNS -> Telegram
// Cada ejecución revisa los perfiles configurados y avisa por Telegram de:
//   1. Intentos de entrar en webs bloqueadas por el control parental (porno, apuestas, citas...).
//   2. Un móvil que deja de usar NextDNS (posible DNS quitado, móvil apagado o sin batería).
//   3. Cambios en el filtro del perfil (categorías quitadas, SafeSearch desactivado, registros apagados...).
//   4. Un resumen diario: si un día no llega, alguien ha parado el vigilante.
//
// Sin dependencias: Node 18+ (usa fetch nativo).
// IMPORTANTE: el repositorio puede ser público, así que este script NUNCA imprime
// dominios ni nombres en la consola. Todo lo sensible va solo a Telegram.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.nextdns.io';
const STATE_FILE = process.env.STATE_FILE || fileURLToPath(new URL('./state/state.json', import.meta.url));

const envOr = (k, d) => (process.env[k] && process.env[k].trim() !== '' ? process.env[k].trim() : d);

const CONFIG = {
  profiles: JSON.parse(envOr('PROFILES_JSON', '[]')),
  tgToken: envOr('TELEGRAM_BOT_TOKEN', ''),
  tgChat: envOr('TELEGRAM_CHAT_ID', ''),
  inactivityMin: Number(envOr('INACTIVITY_MINUTES', '45')),
  quietHours: envOr('QUIET_HOURS', '01-07'), // horas sin avisos de inactividad (hora local)
  summaryHour: Number(envOr('DAILY_SUMMARY_HOUR', '22')), // -1 para desactivar
  tz: envOr('TIMEZONE', 'Europe/Madrid'),
  sendTest: envOr('SEND_TEST', 'false') === 'true',
  dryRun: envOr('DRY_RUN', '0') === '1',
};

// Motivos de bloqueo que cuentan como "sospechosos".
// Los bloqueos de anuncios/rastreadores/malware NO avisan (serían ruido).
const SUSPICIOUS_REASON =
  /porn|gambl|dating|piracy|mixed|safe.?search|bypass|vpn|proxy|\btor\b|deny|parental|apuesta|citas|pirater|evasi|lista negra/i;

const now = () => Date.now();
const log = (...a) => console.log(...a); // solo mensajes genéricos, nunca datos sensibles

// ---------- utilidades ----------

const escapeHtml = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function localParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('es-ES', {
    timeZone: CONFIG.tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), hhmm: `${p.hour}:${p.minute}` };
}

function inQuietHours(date = new Date()) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(CONFIG.quietHours);
  if (!m) return false;
  const [s, e] = [Number(m[1]), Number(m[2])];
  const h = localParts(date).hour;
  return s <= e ? h >= s && h < e : h >= s || h < e; // admite rangos que cruzan medianoche
}

function ago(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

async function api(path, apiKey, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
  if (!res.ok) throw new Error(`NextDNS ${res.status}`);
  return res.json();
}

async function telegram(text) {
  if (CONFIG.dryRun || !CONFIG.tgToken || !CONFIG.tgChat) {
    log('[dry-run] mensaje de Telegram preparado (' + text.length + ' caracteres)');
    if (CONFIG.dryRun) console.log('---\n' + text + '\n---');
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CONFIG.tgChat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
}

const deviceMatches = (entry, p) =>
  !p.device || (entry.device?.name || '').toLowerCase() === String(p.device).toLowerCase();

// ---------- 1. bloqueos sospechosos ----------

async function checkBlocked(p, st) {
  // Primera vez: solo miramos los últimos 15 min para no inundar de avisos antiguos.
  const since = st.lastBlockedTs || new Date(now() - 15 * 60000).toISOString();
  const hits = [];
  let newest = since;
  let cursor;
  for (let page = 0; page < 5; page++) {
    const r = await api(`/profiles/${p.id}/logs`, p.apiKey, {
      status: 'blocked', from: since, sort: 'asc', limit: 1000, cursor,
    });
    for (const e of r.data || []) {
      if (e.timestamp <= since) continue; // "from" es inclusivo
      if (e.timestamp > newest) newest = e.timestamp;
      if (!deviceMatches(e, p)) continue;
      const reasons = (e.reasons || []).map((x) => x.name || x.id);
      if (reasons.some((x) => SUSPICIOUS_REASON.test(x)) ||
          (e.reasons || []).some((x) => SUSPICIOUS_REASON.test(x.id || ''))) {
        hits.push({ ts: e.timestamp, domain: e.domain, reason: reasons.join(', ') });
      }
    }
    cursor = r.meta?.pagination?.cursor;
    if (!cursor) break;
  }
  st.lastBlockedTs = newest;
  if (!hits.length) return [];

  // Agrupa por dominio raíz para que el mensaje sea corto.
  const byDomain = new Map();
  for (const h of hits) {
    const k = h.domain;
    const prev = byDomain.get(k);
    byDomain.set(k, { ...h, count: (prev?.count || 0) + 1, first: prev?.first || h.ts });
  }
  const lines = [...byDomain.values()].slice(0, 15).map(
    (h) => `• ${localParts(new Date(h.first)).hhmm} · ${escapeHtml(h.domain)}${h.count > 1 ? ` (x${h.count})` : ''} — ${escapeHtml(h.reason)}`,
  );
  const extra = byDomain.size > 15 ? `\n…y ${byDomain.size - 15} más` : '';
  return [`🚩 <b>${escapeHtml(p.name)}</b> ha intentado entrar en webs bloqueadas (${hits.length}):\n${lines.join('\n')}${extra}`];
}

// ---------- 2. móvil que deja de usar NextDNS ----------

async function lastSeen(p) {
  let cursor;
  for (let page = 0; page < 3; page++) {
    const r = await api(`/profiles/${p.id}/logs`, p.apiKey, {
      from: '-1d', sort: 'desc', limit: 1000, raw: 1, cursor,
    });
    const hit = (r.data || []).find((e) => deviceMatches(e, p));
    if (hit) return Date.parse(hit.timestamp);
    cursor = r.meta?.pagination?.cursor;
    if (!cursor) break;
  }
  return null; // nada en las últimas 24 h
}

async function checkActivity(p, st) {
  const seen = await lastSeen(p);
  const idle = seen ? now() - seen : 24 * 3600e3;
  const isDown = idle > CONFIG.inactivityMin * 60000;
  st.lastSeen = seen ? new Date(seen).toISOString() : null;

  if (isDown && !st.down) {
    if (inQuietHours()) return []; // de noche no molestamos; si sigue así por la mañana, avisará
    st.down = true;
    return [
      `🔌 El móvil de <b>${escapeHtml(p.name)}</b> lleva <b>${seen ? ago(idle) : 'más de 24 h'}</b> sin pasar por NextDNS.\n` +
      `Puede que haya quitado el DNS privado, o que el móvil esté apagado o sin batería. Preguntad 🙂`,
    ];
  }
  if (!isDown && st.down) {
    st.down = false;
    return [`✅ El móvil de <b>${escapeHtml(p.name)}</b> vuelve a usar NextDNS.`];
  }
  return [];
}

// ---------- 3. cambios en el filtro ----------

function fingerprint(profile) {
  const pc = profile.parentalControl || {};
  const active = (arr) => (arr || []).filter((x) => x.active !== false).map((x) => x.id).sort();
  return {
    categories: active(pc.categories),
    services: active(pc.services),
    safeSearch: !!pc.safeSearch,
    youtubeRestrictedMode: !!pc.youtubeRestrictedMode,
    blockBypass: !!pc.blockBypass,
    logs: profile.settings?.logs?.enabled !== false,
    allowlist: (profile.allowlist || []).filter((x) => x.active !== false).map((x) => x.id).sort(),
  };
}

function describeChanges(before, after) {
  const out = [];
  const flags = {
    safeSearch: 'SafeSearch', youtubeRestrictedMode: 'Modo restringido de YouTube',
    blockBypass: 'Bloqueo de VPN/proxies', logs: 'Registros',
  };
  for (const [k, label] of Object.entries(flags)) {
    if (before[k] !== after[k]) out.push(`${after[k] ? '🟢 activado' : '🔴 DESACTIVADO'}: ${label}`);
  }
  const ES = {
    porn: 'Pornografía', gambling: 'Apuestas', dating: 'Citas', piracy: 'Piratería',
    'social-networks': 'Redes sociales', 'video-streaming': 'Streaming de vídeo', gaming: 'Juegos en línea',
    'mixed-content-platforms': 'Plataformas de contenido mixto',
  };
  for (const k of ['categories', 'services']) {
    const removed = before[k].filter((x) => !after[k].includes(x)).map((x) => ES[x] || x);
    const added = after[k].filter((x) => !before[k].includes(x)).map((x) => ES[x] || x);
    if (removed.length) out.push(`🔴 Quitado del bloqueo: ${removed.join(', ')}`);
    if (added.length) out.push(`🟢 Añadido al bloqueo: ${added.join(', ')}`);
  }
  const newAllowed = after.allowlist.filter((x) => !before.allowlist.includes(x));
  if (newAllowed.length) out.push(`🟠 Nuevo en la lista blanca (se salta el filtro): ${newAllowed.join(', ')}`);
  return out;
}

async function checkSettings(p, st) {
  const r = await api(`/profiles/${p.id}`, p.apiKey);
  const fp = fingerprint(r.data || {});
  const prev = st.settings;
  st.settings = fp;
  if (!prev) return [];
  const changes = describeChanges(prev, fp);
  if (!changes.length) return [];
  return [`🛠️ Han cambiado el filtro de <b>${escapeHtml(p.name)}</b>:\n${changes.map(escapeHtml).join('\n')}`];
}

// ---------- 4. resumen diario ----------

function dailySummary(state) {
  if (CONFIG.summaryHour < 0) return [];
  const { date, hour } = localParts();
  if (hour < CONFIG.summaryHour || state.lastSummaryDate === date) return [];
  state.lastSummaryDate = date;
  const lines = CONFIG.profiles.map((p) => {
    const st = state.profiles[p.id] || {};
    const seen = st.lastSeen ? `último uso hace ${ago(now() - Date.parse(st.lastSeen))}` : 'sin actividad hoy';
    return `• <b>${escapeHtml(p.name)}</b>: ${st.down ? '🔌 sin NextDNS' : '✅ protegido'} (${seen})`;
  });
  return [`🛡️ Resumen del día — el vigilante sigue funcionando.\n${lines.join('\n')}\n\nSi algún día no llega este mensaje, alguien ha parado el vigilante.`];
}

// ---------- principal ----------

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return { profiles: {} }; }
}

async function main() {
  if (!CONFIG.profiles.length) {
    log('Sin configurar todavía (falta el secreto PROFILES_JSON). No hago nada.');
    return;
  }
  const state = await loadState();
  state.profiles ||= {};
  const messages = [];

  if (CONFIG.sendTest) {
    messages.push(`👋 Prueba del vigilante NextDNS: si lees esto, los avisos llegan bien.\nPerfiles vigilados: ${CONFIG.profiles.map((p) => escapeHtml(p.name)).join(', ')}`);
  }

  for (const [i, p] of CONFIG.profiles.entries()) {
    const st = (state.profiles[p.id] ||= {});
    try {
      messages.push(...(await checkSettings(p, st)));
      messages.push(...(await checkBlocked(p, st)));
      messages.push(...(await checkActivity(p, st)));
      if (st.apiError) messages.push(`✅ Vuelvo a poder leer el perfil de <b>${escapeHtml(p.name)}</b>.`);
      st.apiError = false;
      log(`perfil #${i + 1}: ok`);
    } catch (err) {
      log(`perfil #${i + 1}: error ${err.message}`);
      if (!st.apiError) {
        st.apiError = true;
        messages.push(`⚠️ No puedo leer el perfil de <b>${escapeHtml(p.name)}</b> en NextDNS (${escapeHtml(err.message)}). ¿Han cambiado la API key o borrado el perfil?`);
      }
    }
  }

  messages.push(...dailySummary(state));

  for (const m of messages) await telegram(m);
  log(`avisos enviados: ${messages.length}`);

  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

main().catch((err) => {
  console.error('Fallo general:', err.message);
  process.exit(1);
});
