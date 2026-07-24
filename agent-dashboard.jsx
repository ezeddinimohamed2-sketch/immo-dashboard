/**
 * agent-dashboard.jsx
 * Dashboard agent ImmoGeo — branché API réelle
 * AuthContext + useLeads (Realtime) + useStats
 */
import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";

// ══════════════════════════════════════════════════════
//  CONFIG — remplacer par vos vraies valeurs
// ══════════════════════════════════════════════════════
const API_BASE      = "https://immo-backend-00a7.onrender.com";
const SUPABASE_URL  = "https://xsrawontytjkzgimmpkp.supabase.co";
// ATTENTION: n'utilisez ici QUE la clé publique "anon" de Supabase
// (Project Settings > API > anon public). Ne jamais mettre la clé
// "service_role" / "secret" dans du code exécuté côté navigateur :
// elle contourne les règles RLS et donne un accès total à la base.
// Une ancienne clé secrète a été trouvée en dur ici et a été retirée :
// elle doit être régénérée immédiatement dans le dashboard Supabase.
const SUPABASE_ANON = "";
// ══════════════════════════════════════════════════════
//  TOKEN STORE
// ══════════════════════════════════════════════════════
const TOKEN_KEY   = "immo_access";
const REFRESH_KEY = "immo_refresh";
const AGENT_KEY   = "immo_agent";

const tokenStore = {
  getAccess:  () => localStorage.getItem(TOKEN_KEY),
  getRefresh: () => localStorage.getItem(REFRESH_KEY),
  getAgent:   () => { try { return JSON.parse(localStorage.getItem(AGENT_KEY)); } catch { return null; } },
  set: (a, r, ag) => {
    localStorage.setItem(TOKEN_KEY, a);
    if (r)  localStorage.setItem(REFRESH_KEY, r);
    if (ag) localStorage.setItem(AGENT_KEY, JSON.stringify(ag));
  },
  clear: () => {
    [TOKEN_KEY, REFRESH_KEY, AGENT_KEY].forEach(k => localStorage.removeItem(k));
  },
};

// ══════════════════════════════════════════════════════
//  API CLIENT
// ══════════════════════════════════════════════════════
let isRefreshing = false;
let waitQueue    = [];

async function apiFetch(path, { method = "GET", body, params, auth = true } = {}) {
  let url = API_BASE + path;
  if (params) {
    const qs = new URLSearchParams(Object.entries(params).filter(([,v]) => v != null)).toString();
    if (qs) url += "?" + qs;
  }
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const t = tokenStore.getAccess();
    if (t) headers["Authorization"] = "Bearer " + t;
  }
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  if (res.status === 401 && auth) {
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        waitQueue.push({ resolve: () => resolve(apiFetch(path, { method, body, params, auth })), reject });
      });
    }
    isRefreshing = true;
    try {
      const rr = await fetch(API_BASE + "/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: tokenStore.getRefresh() }),
      });
      if (!rr.ok) throw new Error();
      const rd = await rr.json();
      tokenStore.set(rd.access_token, rd.refresh_token, null);
      waitQueue.forEach(p => p.resolve());
      waitQueue = [];
      return apiFetch(path, { method, body, params, auth });
    } catch {
      waitQueue.forEach(p => p.reject());
      waitQueue = [];
      tokenStore.clear();
      window.dispatchEvent(new CustomEvent("auth:logout"));
      throw { message: "Session expirée", status: 401 };
    } finally { isRefreshing = false; }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw { message: data?.message || "Erreur " + res.status, status: res.status };
  return data;
}

const api = {
  get:   (p, o = {}) => apiFetch(p, { ...o, method: "GET" }),
  post:  (p, b, o={})=> apiFetch(p, { ...o, method: "POST", body: b }),
  patch: (p, b, o={})=> apiFetch(p, { ...o, method: "PATCH", body: b }),
};

// ══════════════════════════════════════════════════════
//  AUTH CONTEXT
// ══════════════════════════════════════════════════════
const AuthCtx = createContext(null);

function AuthProvider({ children }) {
  const [agent, setAgent]   = useState(null);
  const [ready, setReady]   = useState(false);

  useEffect(() => {
    const stored = tokenStore.getAgent();
    const token  = tokenStore.getAccess();
    if (stored && token) {
      api.get("/api/auth/me")
        .then(me => setAgent(me))
        .catch(() => { tokenStore.clear(); })
        .finally(() => setReady(true));
    } else {
      setReady(true);
    }
    const onLogout = () => setAgent(null);
    window.addEventListener("auth:logout", onLogout);
    return () => window.removeEventListener("auth:logout", onLogout);
  }, []);

  const login = async (email, password) => {
    const data = await api.post("/api/auth/login", { email, password }, { auth: false });
    tokenStore.set(data.access_token, data.refresh_token, data.agent);
    setAgent(data.agent);
    return data.agent;
  };
  const logout = async () => {
    try { await api.post("/api/auth/logout", { refresh_token: tokenStore.getRefresh() }); } catch {}
    tokenStore.clear();
    setAgent(null);
  };

  return <AuthCtx.Provider value={{ agent, ready, login, logout }}>{children}</AuthCtx.Provider>;
}

const useAuth = () => useContext(AuthCtx);

// ══════════════════════════════════════════════════════
//  useLeads  (REST + Supabase Realtime WebSocket)
// ══════════════════════════════════════════════════════
function useLeads(agentId) {
  const [leads, setLeads]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [newIds, setNewIds]       = useState(new Set());
  const [realtimeOk, setRealtimeOk] = useState(null); // true/false/null
  const mounted = useRef(true);
  const wsRef   = useRef(null);
  const pollRef = useRef(null);

  const fetchLeads = useCallback(async (silent = false) => {
    if (!agentId) return;
    if (!silent) setLoading(true);
    try {
      const data = await api.get(`/api/agents/${agentId}/annonces`);
      if (!mounted.current) return;
      setLeads(data);
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(e.message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [agentId]);

  // Supabase Realtime (WebSocket léger, sans SDK)
  useEffect(() => {
    if (!agentId) return;
    mounted.current = true;
    fetchLeads();

    if (Notification.permission === "default") Notification.requestPermission();

    // Tenter connexion Realtime
    try {
      const wsUrl = SUPABASE_URL
        .replace("https://", "wss://")
        + `/realtime/v1/websocket?apikey=${SUPABASE_ANON}&vsn=1.0.0`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setRealtimeOk(true);
        ws.send(JSON.stringify({
          topic: "realtime:public:requetes",
          event: "phx_join",
          payload: {
            config: {
              postgres_changes: [{
                event: "INSERT", schema: "public", table: "requetes",
                filter: `agent_id=eq.${agentId}`,
              }],
            },
          },
          ref: "1",
        }));
        // Heartbeat
        const hb = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: "hb" }));
        }, 20000);
        ws._hb = hb;
      };

      ws.onmessage = async (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.event !== "postgres_changes") return;
          const rec = msg.payload?.data?.record;
          if (!rec) return;
          // Récupérer l'annonce complète
          try {
            const annonce = await api.get(`/api/annonces/${rec.annonce_id}`);
            const newLead = {
              id: rec.id,
              statut: "nouveau",
              distance_km: rec.distance_km,
              created_at: rec.created_at || new Date().toISOString(),
              sms_envoye: rec.sms_envoye,
              email_envoye: rec.email_envoye,
              whatsapp_envoye: rec.whatsapp_envoye,
              annonce,
              client: annonce.clients || { nom: "Client", phone: "" },
            };
            if (!mounted.current) return;
            setLeads(prev => [newLead, ...prev]);
            setNewIds(prev => new Set([...prev, rec.id]));
            setTimeout(() => setNewIds(prev => { const s = new Set(prev); s.delete(rec.id); return s; }), 8000);
            if (Notification.permission === "granted") {
              new Notification("🏠 Nouveau lead ImmoGeo", { body: annonce.titre });
            }
          } catch { fetchLeads(true); }
        } catch {}
      };

      ws.onerror = () => {
        setRealtimeOk(false);
        // Fallback polling 30s
        pollRef.current = setInterval(() => fetchLeads(true), 30000);
      };
      ws.onclose = () => clearInterval(ws._hb);

    } catch {
      setRealtimeOk(false);
      pollRef.current = setInterval(() => fetchLeads(true), 30000);
    }

    return () => {
      mounted.current = false;
      if (wsRef.current) wsRef.current.close();
      clearInterval(pollRef.current);
    };
  }, [agentId]);

  const updateStatut = useCallback(async (requeteId, statut) => {
    // Optimiste
    setLeads(prev => prev.map(l => l.id === requeteId ? { ...l, statut } : l));
    try {
      await api.patch(`/api/agents/requetes/${requeteId}`, { statut });
    } catch (e) {
      await fetchLeads(true); // rollback via refetch
      throw e;
    }
  }, []);

  return { leads, loading, error, newIds, realtimeOk, updateStatut, refetch: () => fetchLeads() };
}

// ══════════════════════════════════════════════════════
//  useStats
// ══════════════════════════════════════════════════════
function useStats(agentId) {
  const [stats, setStats]   = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!agentId) return;
    api.get(`/api/agents/${agentId}/stats`)
      .then(d => { setStats(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [agentId]);

  return { stats, loading };
}

// ══════════════════════════════════════════════════════
//  HELPERS UI
// ══════════════════════════════════════════════════════
function timeAgo(iso) {
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "À l'instant";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}j`;
}
function formatPrix(p, type) {
  if (!p) return "—";
  return `${Number(p).toLocaleString("fr-TN")} DT${type === "Location" ? "/mois" : ""}`;
}

const SC = {
  nouveau:        { label: "Nouveau",        color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  vu:             { label: "Vu",             color: "#60a5fa", bg: "rgba(96,165,250,0.12)" },
  interesse:      { label: "Intéressé",      color: "#a78bfa", bg: "rgba(167,139,250,0.12)" },
  contact_etabli: { label: "Contact établi", color: "#10b981", bg: "rgba(16,185,129,0.12)" },
  decline:        { label: "Décliné",        color: "#6b7280", bg: "rgba(107,114,128,0.1)" },
};

const BIEN_ICON = { Appartement:"🏢", Villa:"🏡", Terrain:"🌿", "Local commercial":"🏪", Bureau:"💼", Ferme:"🌾" };

// ══════════════════════════════════════════════════════
//  COMPOSANTS
// ══════════════════════════════════════════════════════

function Spinner() {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", color:"#334155" }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:32, marginBottom:12 }}>⏳</div>
        <div style={{ fontSize:13 }}>Chargement…</div>
      </div>
    </div>
  );
}

function Toast({ msg, type, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, []);
  const colors = { success:"#14532d", error:"#7f1d1d", info:"#1e3a5f" };
  return (
    <div style={{
      position:"fixed", top:16, right:16, zIndex:9999,
      background: colors[type] || colors.info,
      border: `1px solid ${type === "error" ? "#ef4444" : "#334155"}`,
      color:"#fff", padding:"12px 18px", borderRadius:10,
      fontSize:13, boxShadow:"0 8px 32px rgba(0,0,0,0.5)",
      maxWidth:320, animation:"slidein 0.2s ease",
    }}>
      {msg}
      <button onClick={onClose} style={{ background:"none", border:"none", color:"#ffffff88", cursor:"pointer", marginLeft:12, fontSize:16 }}>×</button>
    </div>
  );
}

function CanalBadge({ label, ok, color }) {
  return (
    <span style={{
      fontSize:9, fontWeight:700, padding:"2px 5px", borderRadius:3,
      background: ok ? color + "22" : "#1e293b",
      color: ok ? color : "#374151",
      border: `1px solid ${ok ? color + "44" : "#374151"}`,
      fontFamily:"monospace", opacity: ok ? 1 : 0.35,
    }}>{label}</span>
  );
}

function LeadRow({ lead, selected, isNew, onClick }) {
  const cfg  = SC[lead.statut] || SC.nouveau;
  const icon = BIEN_ICON[lead.annonce?.type_bien] || "🏠";
  return (
    <div onClick={onClick} style={{
      background: isNew ? "linear-gradient(135deg,#1a2f1a,#0f2010)" : selected ? "#0f1e2b" : "#0a0f1e",
      border: `1px solid ${isNew ? "#10b981" : selected ? "#334155" : "#1a2535"}`,
      borderLeft: `3px solid ${isNew ? "#10b981" : cfg.color}`,
      borderRadius:10, padding:"13px 15px", cursor:"pointer",
      transition:"all 0.18s", marginBottom:8,
    }}>
      <div style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
        <div style={{ width:36, height:36, borderRadius:8, background:"#1e293b", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>
          {icon}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
            <span style={{ color:"#f1f5f9", fontWeight:600, fontSize:13, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {lead.annonce?.titre || "—"}
            </span>
            {(lead.statut === "nouveau" || isNew) && (
              <span style={{ background:"#f59e0b", color:"#0f172a", fontSize:8, fontWeight:800, padding:"1px 5px", borderRadius:3, fontFamily:"monospace", flexShrink:0 }}>
                NEW
              </span>
            )}
          </div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:6 }}>
            <span style={{ color:"#10b981", fontWeight:700, fontSize:12 }}>
              {formatPrix(lead.annonce?.prix, lead.annonce?.type_demande)}
            </span>
            {lead.annonce?.surface_m2 && <span style={{ color:"#64748b", fontSize:11 }}>{lead.annonce.surface_m2}m²</span>}
            <span style={{ color:"#475569", fontSize:11 }}>📍{lead.distance_km?.toFixed(1)}km</span>
            <span style={{ color:"#475569", fontSize:11 }}>🕐{timeAgo(lead.created_at)}</span>
          </div>
          <div style={{ display:"flex", gap:6, alignItems:"center" }}>
            <span style={{ background:cfg.bg, color:cfg.color, fontSize:10, padding:"2px 7px", borderRadius:4, fontWeight:600 }}>{cfg.label}</span>
            <div style={{ display:"flex", gap:3 }}>
              <CanalBadge label="SMS" ok={lead.sms_envoye}      color="#06b6d4" />
              <CanalBadge label="✉"  ok={lead.email_envoye}    color="#818cf8" />
              <CanalBadge label="W"  ok={lead.whatsapp_envoye} color="#22c55e" />
            </div>
            <span style={{ color:"#374151", fontSize:11, marginLeft:"auto", flexShrink:0 }}>{lead.client?.nom}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function LeadDetail({ lead, onAction, onClose, actionLoading }) {
  if (!lead) return (
    <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ textAlign:"center", color:"#1e293b" }}>
        <div style={{ fontSize:36, marginBottom:10, opacity:0.4 }}>📋</div>
        <div style={{ color:"#334155", fontSize:13 }}>Sélectionnez un lead</div>
      </div>
    </div>
  );

  const cfg   = SC[lead.statut] || SC.nouveau;
  const icon  = BIEN_ICON[lead.annonce?.type_bien] || "🏠";
  const phone = lead.client?.phone || "";

  const ACTIONS = [
    { key:"vu",             label:"Marquer vu",       color:"#60a5fa", show: lead.statut === "nouveau" },
    { key:"interesse",      label:"✓ Intéressé",      color:"#a78bfa", show: ["nouveau","vu"].includes(lead.statut) },
    { key:"contact_etabli", label:"📞 Contact établi",color:"#10b981", show: ["vu","interesse"].includes(lead.statut) },
    { key:"decline",        label:"✗ Décliner",       color:"#ef4444", show: !["decline","contact_etabli"].includes(lead.statut) },
  ].filter(a => a.show);

  return (
    <div style={{ flex:1, background:"#060d18", borderLeft:"1px solid #1e293b", overflowY:"auto" }}>
      {/* Header */}
      <div style={{ padding:"18px 22px", borderBottom:"1px solid #1e293b", display:"flex", alignItems:"center", gap:12 }}>
        <span style={{ fontSize:26 }}>{icon}</span>
        <div style={{ flex:1 }}>
          <div style={{ color:"#f59e0b", fontSize:9, letterSpacing:3, fontFamily:"monospace" }}>
            {lead.annonce?.type_demande} · {lead.annonce?.type_bien}
          </div>
          <div style={{ color:"#f1f5f9", fontWeight:700, fontSize:14, lineHeight:1.3 }}>
            {lead.annonce?.titre}
          </div>
        </div>
        <button onClick={onClose} style={{ background:"none", border:"none", color:"#475569", cursor:"pointer", fontSize:22 }}>×</button>
      </div>

      <div style={{ padding:"18px 22px", display:"flex", flexDirection:"column", gap:16 }}>

        {/* Statut + actions */}
        <div>
          <div style={{ color:"#64748b", fontSize:10, letterSpacing:2, fontFamily:"monospace", marginBottom:8 }}>STATUT</div>
          <span style={{ background:cfg.bg, color:cfg.color, fontWeight:700, fontSize:12, padding:"4px 12px", borderRadius:6 }}>{cfg.label}</span>
          <span style={{ color:"#475569", fontSize:11, marginLeft:8 }}>· {timeAgo(lead.created_at)}</span>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginTop:12 }}>
            {ACTIONS.map(a => (
              <button key={a.key} onClick={() => onAction(lead.id, a.key)} disabled={actionLoading}
                style={{
                  background:`${a.color}18`, border:`1px solid ${a.color}44`, color:a.color,
                  borderRadius:7, padding:"8px 14px", cursor:"pointer", fontSize:12, fontWeight:600,
                  opacity: actionLoading ? 0.5 : 1,
                }}>
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {/* Fiche bien */}
        <div style={{ background:"#0f172a", borderRadius:10, padding:16, border:"1px solid #1e293b" }}>
          <div style={{ color:"#64748b", fontSize:10, letterSpacing:2, fontFamily:"monospace", marginBottom:12 }}>FICHE BIEN</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            {[
              ["💰 Prix",    formatPrix(lead.annonce?.prix, lead.annonce?.type_demande), "#10b981"],
              ["📐 Surface", lead.annonce?.surface_m2 ? lead.annonce.surface_m2 + " m²" : "—", "#f1f5f9"],
              ["📍 Distance",lead.distance_km?.toFixed(2) + " km", "#f59e0b"],
              ["🏙️ Ville",  lead.annonce?.ville || "—", "#f1f5f9"],
            ].map(([lbl,val,col]) => (
              <div key={lbl} style={{ background:"#1e293b", borderRadius:8, padding:"10px 12px" }}>
                <div style={{ color:"#64748b", fontSize:10, marginBottom:3 }}>{lbl}</div>
                <div style={{ color:col, fontWeight:700, fontSize:14 }}>{val}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Client */}
        <div style={{ background:"#0f172a", borderRadius:10, padding:16, border:"1px solid #1e293b" }}>
          <div style={{ color:"#64748b", fontSize:10, letterSpacing:2, fontFamily:"monospace", marginBottom:12 }}>CLIENT</div>
          <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14 }}>
            <div style={{ width:40, height:40, borderRadius:"50%", background:"#1e3a2f", border:"2px solid #10b98144", display:"flex", alignItems:"center", justifyContent:"center", color:"#10b981", fontWeight:700, fontSize:16 }}>
              {(lead.client?.nom || "?").charAt(0)}
            </div>
            <div>
              <div style={{ color:"#f1f5f9", fontWeight:600, fontSize:14 }}>{lead.client?.nom || "—"}</div>
              <div style={{ color:"#6ee7b7", fontSize:12 }}>{phone}</div>
            </div>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <a href={`tel:${phone}`} style={{ flex:1, background:"linear-gradient(135deg,#10b981,#059669)", color:"#fff", fontWeight:700, fontSize:13, borderRadius:8, padding:"11px", textAlign:"center", textDecoration:"none", display:"block" }}>📞 Appeler</a>
            <a href={`https://wa.me/${phone.replace(/\s|\+/g,"")}`} target="_blank" rel="noreferrer" style={{ flex:1, background:"linear-gradient(135deg,#16a34a,#15803d)", color:"#fff", fontWeight:700, fontSize:13, borderRadius:8, padding:"11px", textAlign:"center", textDecoration:"none", display:"block" }}>💬 WhatsApp</a>
          </div>
        </div>

        {/* Notifications */}
        <div style={{ background:"#0f172a", borderRadius:10, padding:16, border:"1px solid #1e293b" }}>
          <div style={{ color:"#64748b", fontSize:10, letterSpacing:2, fontFamily:"monospace", marginBottom:10 }}>NOTIFICATIONS ENVOYÉES</div>
          {[["SMS",lead.sms_envoye,"#06b6d4","📱"],["Email",lead.email_envoye,"#818cf8","✉️"],["WhatsApp",lead.whatsapp_envoye,"#22c55e","💬"]].map(([c,ok,col,ic]) => (
            <div key={c} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
              <span style={{ width:22, textAlign:"center" }}>{ic}</span>
              <span style={{ color:"#94a3b8", fontSize:13, flex:1 }}>{c}</span>
              <span style={{ color:ok?col:"#374151", fontWeight:700, fontSize:11, background:ok?col+"18":"#1e293b", padding:"2px 8px", borderRadius:4 }}>
                {ok ? "✓ Envoyé" : "✗ Non envoyé"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DonutChart({ data }) {
  if (!data) return null;
  const colors = { nouveau:"#f59e0b", vu:"#60a5fa", interesse:"#a78bfa", contact_etabli:"#10b981", decline:"#475569" };
  const total  = Object.values(data).reduce((a,b) => a+b, 0);
  if (total === 0) return <div style={{ color:"#334155", fontSize:12, textAlign:"center", padding:20 }}>Aucune donnée</div>;
  const R = 38, cx = 58, cy = 58, sw = 13, circ = 2 * Math.PI * R;
  let cumul = 0;
  const segs = Object.entries(data).map(([k,v]) => {
    const pct = v / total * 100;
    const seg = { k, v, pct, start: cumul, color: colors[k] || "#334155" };
    cumul += pct;
    return seg;
  });
  return (
    <div style={{ display:"flex", alignItems:"center", gap:18 }}>
      <svg width={116} height={116} viewBox="0 0 116 116">
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="#1e293b" strokeWidth={sw} />
        {segs.map(s => (
          <circle key={s.k} cx={cx} cy={cy} r={R} fill="none" stroke={s.color} strokeWidth={sw}
            strokeDasharray={`${(s.pct/100)*circ} ${circ}`}
            strokeDashoffset={-((s.start/100)*circ)}
            transform={`rotate(-90 ${cx} ${cy})`} />
        ))}
        <text x={cx} y={cy-3} textAnchor="middle" fill="#f1f5f9" fontSize={20} fontWeight={800}>{total}</text>
        <text x={cx} y={cx+12} textAnchor="middle" fill="#64748b" fontSize={9} fontFamily="monospace">LEADS</text>
      </svg>
      <div style={{ flex:1 }}>
        {segs.map(s => (
          <div key={s.k} style={{ display:"flex", alignItems:"center", gap:7, marginBottom:5 }}>
            <div style={{ width:7, height:7, borderRadius:"50%", background:s.color, flexShrink:0 }} />
            <span style={{ color:"#94a3b8", fontSize:11, flex:1 }}>{SC[s.k]?.label || s.k}</span>
            <span style={{ color:s.color, fontWeight:700, fontSize:12 }}>{s.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
//  LOGIN SCREEN
// ══════════════════════════════════════════════════════
function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");

  const handleLogin = async (e) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message || "Identifiants incorrects");
    } finally {
      setLoading(false);
    }
  };

  // Pré-remplissage démo
  const fillDemo = () => { setEmail("sarra@immobilia.tn"); setPassword("demo1234"); };

  return (
    <div style={{ minHeight:"100vh", background:"#030b14", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"Georgia,serif", padding:20 }}>
      <div style={{ width:"100%", maxWidth:400 }}>
        {/* Logo */}
        <div style={{ textAlign:"center", marginBottom:36 }}>
          <div style={{ width:56, height:56, borderRadius:14, background:"linear-gradient(135deg,#f59e0b,#d97706)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:28, margin:"0 auto 14px" }}>🏠</div>
          <div style={{ color:"#f59e0b", fontWeight:800, fontSize:20, letterSpacing:2 }}>IMMO GEO</div>
          <div style={{ color:"#475569", fontSize:12, fontFamily:"monospace", letterSpacing:3, marginTop:2 }}>ESPACE AGENT</div>
        </div>

        <div style={{ background:"#0f172a", border:"1px solid #1e293b", borderRadius:14, padding:28 }}>
          <h2 style={{ color:"#f1f5f9", fontSize:18, fontWeight:700, margin:"0 0 22px" }}>Connexion</h2>

          {error && (
            <div style={{ background:"#7f1d1d", border:"1px solid #ef444444", color:"#fca5a5", borderRadius:8, padding:"10px 14px", fontSize:13, marginBottom:16 }}>
              ⚠ {error}
            </div>
          )}

          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <div>
              <label style={{ color:"#64748b", fontSize:11, fontFamily:"monospace", letterSpacing:1, display:"block", marginBottom:6 }}>EMAIL</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="agent@agence.tn"
                style={{ width:"100%", background:"#1e293b", border:"1px solid #334155", borderRadius:8, padding:"12px", color:"#f1f5f9", fontSize:14, outline:"none", boxSizing:"border-box" }} />
            </div>
            <div>
              <label style={{ color:"#64748b", fontSize:11, fontFamily:"monospace", letterSpacing:1, display:"block", marginBottom:6 }}>MOT DE PASSE</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                onKeyDown={e => e.key === "Enter" && handleLogin(e)}
                style={{ width:"100%", background:"#1e293b", border:"1px solid #334155", borderRadius:8, padding:"12px", color:"#f1f5f9", fontSize:14, outline:"none", boxSizing:"border-box" }} />
            </div>
            <button onClick={handleLogin} disabled={loading}
              style={{ background: loading ? "#334155" : "linear-gradient(135deg,#f59e0b,#d97706)", color: loading ? "#64748b" : "#0f172a", fontWeight:700, fontSize:15, border:"none", borderRadius:10, padding:"14px", cursor: loading ? "not-allowed" : "pointer", marginTop:4 }}>
              {loading ? "Connexion…" : "Se connecter →"}
            </button>
          </div>

          <button onClick={fillDemo} style={{ width:"100%", marginTop:14, background:"none", border:"1px dashed #334155", color:"#475569", borderRadius:8, padding:"8px", cursor:"pointer", fontSize:12, fontFamily:"monospace" }}>
            ▶ Utiliser le compte démo
          </button>
        </div>
        <p style={{ color:"#1e293b", fontSize:11, textAlign:"center", marginTop:16 }}>
          API : {API_BASE}
        </p>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
//  DASHBOARD PRINCIPAL
// ══════════════════════════════════════════════════════
function Dashboard() {
  const { agent, logout } = useAuth();
  const { leads, loading: leadsLoading, error: leadsError, newIds, realtimeOk, updateStatut, refetch } = useLeads(agent?.id);
  const { stats, loading: statsLoading } = useStats(agent?.id);

  const [tab, setTab]         = useState("leads");
  const [filter, setFilter]   = useState("tous");
  const [search, setSearch]   = useState("");
  const [selected, setSelected] = useState(null);
  const [notifOpen, setNotifOpen] = useState(false);
  const [toast, setToast]     = useState(null);
  const [actionLoading, setActionLoading] = useState(false);

  const showToast = (msg, type = "success") => setToast({ msg, type });

  // Nouvelles notifs dynamiques depuis newIds
  const [localNotifs, setLocalNotifs] = useState([]);
  useEffect(() => {
    newIds.forEach(id => {
      const lead = leads.find(l => l.id === id);
      if (!lead) return;
      setLocalNotifs(prev => {
        if (prev.some(n => n.id === id)) return prev;
        return [{ id, msg: `Nouveau lead : ${lead.annonce?.titre}`, time: "À l'instant", lu: false }, ...prev];
      });
    });
  }, [newIds, leads]);

  const unread = localNotifs.filter(n => !n.lu).length + (newIds.size > 0 ? 1 : 0);

  const handleAction = async (requeteId, statut) => {
    setActionLoading(true);
    try {
      await updateStatut(requeteId, statut);
      setSelected(prev => prev?.id === requeteId ? { ...prev, statut } : prev);
      showToast(`Statut mis à jour : ${SC[statut]?.label}`);
    } catch (e) {
      showToast(e.message || "Erreur mise à jour", "error");
    } finally {
      setActionLoading(false);
    }
  };

  const filteredLeads = leads.filter(l => {
    const matchF = filter === "tous" || l.statut === filter;
    const q = search.toLowerCase();
    const matchS = !q ||
      l.annonce?.titre?.toLowerCase().includes(q) ||
      l.client?.nom?.toLowerCase().includes(q) ||
      l.annonce?.ville?.toLowerCase().includes(q);
    return matchF && matchS;
  });

  const FILTERS = ["tous","nouveau","vu","interesse","contact_etabli","decline"];
  const TABS    = [
    { key:"leads",  label:"Leads", badge: leads.filter(l => l.statut === "nouveau").length },
    { key:"stats",  label:"Statistiques" },
    { key:"profil", label:"Profil" },
  ];

  const initials = ((agent?.prenom?.[0] || "") + (agent?.nom?.[0] || "")).toUpperCase();

  return (
    <div style={{ minHeight:"100vh", background:"#030b14", fontFamily:"Georgia,serif", color:"#f1f5f9", display:"flex", flexDirection:"column" }}>
      <style>{`
        *{scrollbar-width:thin;scrollbar-color:#1e293b #060d18}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#060d18}::-webkit-scrollbar-thumb{background:#1e293b;border-radius:3px}
        @keyframes slidein{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
        @keyframes pulse2{0%,100%{opacity:1}50%{opacity:0.4}}
      `}</style>

      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

      {/* ── TOPBAR ── */}
      <header style={{ background:"linear-gradient(90deg,#0a1628,#0f172a)", borderBottom:"1px solid #1e293b", padding:"0 20px", display:"flex", alignItems:"center", height:54, gap:14, position:"sticky", top:0, zIndex:100 }}>
        {/* Logo */}
        <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
          <div style={{ width:30, height:30, borderRadius:7, background:"linear-gradient(135deg,#f59e0b,#d97706)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:15 }}>🏠</div>
          <div style={{ lineHeight:1 }}>
            <div style={{ color:"#f59e0b", fontWeight:800, fontSize:12, letterSpacing:1 }}>IMMO GEO</div>
            <div style={{ color:"#334155", fontSize:8, fontFamily:"monospace", letterSpacing:2 }}>AGENT</div>
          </div>
        </div>

        {/* Realtime indicator */}
        <div style={{ display:"flex", alignItems:"center", gap:5, marginRight:4 }}>
          <div style={{ width:6, height:6, borderRadius:"50%", background: realtimeOk === true ? "#10b981" : realtimeOk === false ? "#f59e0b" : "#334155", animation: realtimeOk === true ? "pulse2 2s infinite" : "none" }} />
          <span style={{ color:"#475569", fontSize:9, fontFamily:"monospace" }}>
            {realtimeOk === true ? "LIVE" : realtimeOk === false ? "POLL" : "SYNC"}
          </span>
        </div>

        {/* Tabs */}
        <nav style={{ display:"flex", gap:3, flex:1 }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ background: tab===t.key?"#1e293b":"none", border:"none", color: tab===t.key?"#f1f5f9":"#64748b", borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:13, fontFamily:"inherit", display:"flex", alignItems:"center", gap:5 }}>
              {t.label}
              {t.badge > 0 && <span style={{ background:"#f59e0b", color:"#0f172a", fontSize:9, fontWeight:800, padding:"1px 5px", borderRadius:10, fontFamily:"monospace" }}>{t.badge}</span>}
            </button>
          ))}
        </nav>

        {/* Refresh */}
        <button onClick={refetch} title="Rafraîchir"
          style={{ background:"#1e293b", border:"1px solid #334155", color:"#64748b", borderRadius:8, width:32, height:32, cursor:"pointer", fontSize:14, display:"flex", alignItems:"center", justifyContent:"center" }}>
          ↻
        </button>

        {/* Notifs */}
        <div style={{ position:"relative" }}>
          <button onClick={() => setNotifOpen(v => !v)}
            style={{ background:"#1e293b", border:"1px solid #334155", color:"#94a3b8", borderRadius:8, width:32, height:32, cursor:"pointer", fontSize:14, display:"flex", alignItems:"center", justifyContent:"center" }}>
            🔔
          </button>
          {unread > 0 && <span style={{ position:"absolute", top:-4, right:-4, background:"#ef4444", color:"#fff", fontSize:8, fontWeight:800, width:15, height:15, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"monospace" }}>{unread}</span>}
          {notifOpen && (
            <div style={{ position:"absolute", top:40, right:0, background:"#0f172a", border:"1px solid #1e293b", borderRadius:12, width:280, boxShadow:"0 20px 60px rgba(0,0,0,0.6)", zIndex:200, overflow:"hidden" }}>
              <div style={{ padding:"10px 14px", borderBottom:"1px solid #1e293b", display:"flex", justifyContent:"space-between" }}>
                <span style={{ color:"#f1f5f9", fontWeight:600, fontSize:12 }}>Notifications</span>
                <button onClick={() => setLocalNotifs(p => p.map(n => ({...n,lu:true})))} style={{ background:"none", border:"none", color:"#f59e0b", fontSize:10, cursor:"pointer" }}>Tout lu</button>
              </div>
              {localNotifs.length === 0 && <div style={{ padding:"20px", color:"#334155", fontSize:12, textAlign:"center" }}>Aucune notification</div>}
              {localNotifs.slice(0,6).map(n => (
                <div key={n.id} onClick={() => setLocalNotifs(p => p.map(x => x.id===n.id?{...x,lu:true}:x))}
                  style={{ padding:"10px 14px", borderBottom:"1px solid #0f172a", background: n.lu?"transparent":"rgba(245,158,11,0.04)", cursor:"pointer", display:"flex", gap:8 }}>
                  <div style={{ width:5, height:5, borderRadius:"50%", marginTop:5, flexShrink:0, background: n.lu?"#1e293b":"#f59e0b" }} />
                  <div>
                    <div style={{ color: n.lu?"#64748b":"#f1f5f9", fontSize:11, lineHeight:1.4 }}>{n.msg}</div>
                    <div style={{ color:"#475569", fontSize:9, marginTop:2, fontFamily:"monospace" }}>{n.time}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Avatar + logout */}
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{ width:30, height:30, borderRadius:"50%", background:"linear-gradient(135deg,#1e3a5f,#0d2a4a)", border:"2px solid #334155", display:"flex", alignItems:"center", justifyContent:"center", color:"#60a5fa", fontWeight:700, fontSize:11 }}>{initials}</div>
          <button onClick={logout} style={{ background:"none", border:"1px solid #1e293b", color:"#64748b", borderRadius:6, padding:"4px 8px", cursor:"pointer", fontSize:10, fontFamily:"monospace" }}>EXIT</button>
        </div>
      </header>

      {/* ── MAIN ── */}
      <main style={{ flex:1, display:"flex", overflow:"hidden" }}>

        {/* ═══ LEADS ═══ */}
        {tab === "leads" && (
          <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
            {/* Liste */}
            <div style={{ width: selected ? 400 : "100%", maxWidth: selected ? 440 : "none", display:"flex", flexDirection:"column", borderRight:"1px solid #1e293b", background:"#060d18", overflow:"hidden", transition:"all 0.2s" }}>
              {/* Recherche + filtres */}
              <div style={{ padding:"14px", borderBottom:"1px solid #1e293b" }}>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher…"
                  style={{ width:"100%", background:"#0f172a", border:"1px solid #1e293b", borderRadius:8, padding:"9px 12px", color:"#f1f5f9", fontSize:13, outline:"none", boxSizing:"border-box", fontFamily:"inherit", marginBottom:10 }} />
                <div style={{ display:"flex", gap:5, overflowX:"auto", paddingBottom:2 }}>
                  {FILTERS.map(f => {
                    const cnt = f === "tous" ? leads.length : leads.filter(l => l.statut === f).length;
                    const cfg = f === "tous" ? { color:"#94a3b8" } : SC[f];
                    return (
                      <button key={f} onClick={() => setFilter(f)}
                        style={{ background: filter===f?(f==="tous"?"#1e293b":`${cfg.color}22`):"none", border:`1px solid ${filter===f?(f==="tous"?"#334155":cfg.color+"55"):"#1e293b"}`, color: filter===f?(f==="tous"?"#f1f5f9":cfg.color):"#475569", borderRadius:6, padding:"3px 9px", cursor:"pointer", fontSize:10, fontFamily:"monospace", whiteSpace:"nowrap", display:"flex", alignItems:"center", gap:4 }}>
                        {f === "tous" ? "Tous" : SC[f]?.label} <span style={{ opacity:0.7 }}>{cnt}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Corps */}
              <div style={{ flex:1, overflowY:"auto", padding:"12px 14px" }}>
                {leadsLoading && <Spinner />}
                {leadsError && (
                  <div style={{ background:"#7f1d1d", border:"1px solid #ef444433", borderRadius:8, padding:"12px 16px", color:"#fca5a5", fontSize:13, marginBottom:12 }}>
                    ⚠ {leadsError}
                    <button onClick={refetch} style={{ background:"none", border:"none", color:"#f87171", cursor:"pointer", marginLeft:8, fontSize:12 }}>Réessayer</button>
                  </div>
                )}
                {!leadsLoading && !leadsError && (
                  <>
                    <div style={{ color:"#475569", fontSize:10, fontFamily:"monospace", letterSpacing:1, marginBottom:10 }}>
                      {filteredLeads.length} LEAD(S)
                    </div>
                    {filteredLeads.length === 0 ? (
                      <div style={{ textAlign:"center", color:"#1e293b", padding:"40px 0" }}>
                        <div style={{ fontSize:28, marginBottom:8, opacity:0.3 }}>🔍</div>
                        <div style={{ fontSize:12, color:"#334155" }}>Aucun lead</div>
                      </div>
                    ) : filteredLeads.map(lead => (
                      <LeadRow key={lead.id} lead={lead}
                        selected={selected?.id === lead.id}
                        isNew={newIds.has(lead.id)}
                        onClick={() => setSelected(lead.id === selected?.id ? null : lead)}
                      />
                    ))}
                  </>
                )}
              </div>
            </div>

            {/* Détail */}
            {selected && (
              <LeadDetail
                lead={leads.find(l => l.id === selected.id) || selected}
                onAction={handleAction}
                onClose={() => setSelected(null)}
                actionLoading={actionLoading}
              />
            )}
          </div>
        )}

        {/* ═══ STATS ═══ */}
        {tab === "stats" && (
          <div style={{ flex:1, overflowY:"auto", padding:24 }}>
            {statsLoading ? <Spinner /> : !stats ? (
              <div style={{ color:"#334155", textAlign:"center", padding:40 }}>
                <div style={{ fontSize:32, marginBottom:10 }}>📊</div>
                <div>Données statistiques non disponibles</div>
                <div style={{ fontSize:11, marginTop:6, color:"#1e293b" }}>Vérifiez que la route /api/agents/:id/stats est déployée</div>
              </div>
            ) : (
              <div style={{ maxWidth:880, margin:"0 auto" }}>
                <div style={{ marginBottom:22 }}>
                  <div style={{ color:"#f59e0b", fontSize:10, letterSpacing:3, fontFamily:"monospace", marginBottom:4 }}>TABLEAU DE BORD</div>
                  <h2 style={{ color:"#f1f5f9", fontSize:20, margin:0 }}>Vos statistiques</h2>
                </div>

                {/* KPIs */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:12, marginBottom:24 }}>
                  {[
                    { label:"LEADS CE MOIS",       value:stats.leads_mois,               sub:`${stats.leads_semaine} cette semaine`,        color:"#f59e0b", icon:"📨" },
                    { label:"TAUX CONVERSION",      value:`${stats.taux_conversion}%`,    sub:"Intéressé → Contact établi",                  color:"#10b981", icon:"📈" },
                    { label:"TEMPS RÉPONSE",        value: stats.temps_reponse_moy ? `${stats.temps_reponse_moy}h` : "—", sub:"Délai moyen de prise en charge", color:"#60a5fa", icon:"⚡" },
                    { label:"TOTAL LEADS",          value:stats.leads_total,              sub:"Depuis l'inscription",                        color:"#a78bfa", icon:"🗂" },
                  ].map(s => (
                    <div key={s.label} style={{ background:"linear-gradient(135deg,#0f172a,#1e293b)", border:`1px solid ${s.color}33`, borderRadius:12, padding:"16px 18px", position:"relative", overflow:"hidden" }}>
                      <div style={{ position:"absolute", top:-8, right:-8, fontSize:40, opacity:0.06 }}>{s.icon}</div>
                      <div style={{ color:"#64748b", fontSize:10, letterSpacing:2, fontFamily:"monospace", marginBottom:8 }}>{s.label}</div>
                      <div style={{ color:s.color, fontSize:26, fontWeight:800, lineHeight:1, marginBottom:4 }}>{s.value}</div>
                      <div style={{ color:"#475569", fontSize:11 }}>{s.sub}</div>
                    </div>
                  ))}
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:16 }}>
                  {/* Donut */}
                  <div style={{ background:"#0f172a", borderRadius:12, padding:18, border:"1px solid #1e293b" }}>
                    <div style={{ color:"#64748b", fontSize:10, letterSpacing:2, fontFamily:"monospace", marginBottom:14 }}>RÉPARTITION</div>
                    <DonutChart data={stats.leads_par_statut} />
                  </div>

                  {/* Activité */}
                  <div style={{ background:"#0f172a", borderRadius:12, padding:18, border:"1px solid #1e293b" }}>
                    <div style={{ color:"#64748b", fontSize:10, letterSpacing:2, fontFamily:"monospace", marginBottom:14 }}>ACTIVITÉ 7J</div>
                    {(stats.activite_7j || []).map(d => {
                      const max = Math.max(...(stats.activite_7j || []).map(x => x.count), 1);
                      return (
                        <div key={d.jour} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                          <span style={{ color:"#64748b", fontSize:10, fontFamily:"monospace", width:26 }}>{d.jour}</span>
                          <div style={{ flex:1, background:"#1e293b", borderRadius:4, height:8, overflow:"hidden" }}>
                            <div style={{ width:`${(d.count/max)*100}%`, height:"100%", background:"linear-gradient(90deg,#10b981,#059669)", borderRadius:4, transition:"width 0.5s" }} />
                          </div>
                          <span style={{ color:"#94a3b8", fontSize:11, fontFamily:"monospace", width:12 }}>{d.count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Tableau performance */}
                {stats.performance_type?.length > 0 && (
                  <div style={{ background:"#0f172a", borderRadius:12, padding:18, border:"1px solid #1e293b" }}>
                    <div style={{ color:"#64748b", fontSize:10, letterSpacing:2, fontFamily:"monospace", marginBottom:14 }}>PERFORMANCE PAR TYPE DE BIEN</div>
                    <table style={{ width:"100%", borderCollapse:"collapse" }}>
                      <thead>
                        <tr>{["Type","Leads","Conversions","CA moyen"].map(h => (
                          <th key={h} style={{ color:"#475569", fontSize:10, fontFamily:"monospace", textAlign:"left", padding:"6px 8px", borderBottom:"1px solid #1e293b" }}>{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {stats.performance_type.map(r => (
                          <tr key={r.type} style={{ borderBottom:"1px solid #1e293b" }}>
                            <td style={{ color:"#f1f5f9", fontSize:13, padding:"10px 8px" }}>{BIEN_ICON[r.type] || "🏠"} {r.type}</td>
                            <td style={{ color:"#94a3b8", fontSize:13, padding:"10px 8px" }}>{r.leads}</td>
                            <td style={{ padding:"10px 8px" }}>
                              <span style={{ color:"#10b981", fontWeight:700, fontSize:13 }}>{r.convertis}</span>
                              <span style={{ color:"#475569", fontSize:11 }}> ({r.taux}%)</span>
                            </td>
                            <td style={{ color:"#f59e0b", fontWeight:700, fontSize:13, padding:"10px 8px" }}>
                              {r.ca_moyen ? r.ca_moyen.toLocaleString("fr-TN") + " DT" : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ PROFIL ═══ */}
        {tab === "profil" && (
          <div style={{ flex:1, overflowY:"auto", padding:24 }}>
            <div style={{ maxWidth:560, margin:"0 auto" }}>
              <div style={{ marginBottom:22 }}>
                <div style={{ color:"#f59e0b", fontSize:10, letterSpacing:3, fontFamily:"monospace", marginBottom:4 }}>PROFIL</div>
                <h2 style={{ color:"#f1f5f9", fontSize:20, margin:0 }}>Mon compte</h2>
              </div>

              <div style={{ background:"#0f172a", borderRadius:14, padding:22, border:"1px solid #1e293b", marginBottom:14 }}>
                <div style={{ display:"flex", alignItems:"center", gap:18, marginBottom:20 }}>
                  <div style={{ width:58, height:58, borderRadius:"50%", background:"linear-gradient(135deg,#1e3a5f,#0d2a4a)", border:"3px solid #334155", display:"flex", alignItems:"center", justifyContent:"center", color:"#60a5fa", fontWeight:800, fontSize:22 }}>{initials}</div>
                  <div>
                    <div style={{ color:"#f1f5f9", fontWeight:700, fontSize:18 }}>{agent?.prenom} {agent?.nom}</div>
                    <div style={{ color:"#64748b", fontSize:13 }}>{agent?.agence}</div>
                    <div style={{ display:"flex", gap:6, marginTop:6 }}>
                      {agent?.verifie && <span style={{ background:"rgba(16,185,129,0.12)", color:"#10b981", fontSize:10, padding:"2px 8px", borderRadius:4, fontWeight:700 }}>✓ Vérifié</span>}
                      {agent?.rating  && <span style={{ background:"rgba(245,158,11,0.12)", color:"#f59e0b", fontSize:10, padding:"2px 8px", borderRadius:4 }}>★ {agent.rating}</span>}
                    </div>
                  </div>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  {[
                    ["📞 Téléphone",    agent?.phone],
                    ["✉️ Email",        agent?.email],
                    ["📍 Zone",         agent?.zone_activite || "—"],
                    ["📡 Rayon",        agent?.rayon_km ? `${agent.rayon_km} km` : "—"],
                    ["🤝 Transactions", agent?.nb_transactions ? `${agent.nb_transactions} réalisées` : "—"],
                    ["🏷️ Spécialités", (agent?.specialites || []).join(", ") || "—"],
                  ].map(([lbl,val]) => (
                    <div key={lbl} style={{ background:"#1e293b", borderRadius:8, padding:"10px 12px" }}>
                      <div style={{ color:"#475569", fontSize:10, marginBottom:3 }}>{lbl}</div>
                      <div style={{ color:"#f1f5f9", fontSize:13 }}>{val}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Connexion Realtime */}
              <div style={{ background:"#0f172a", borderRadius:14, padding:18, border:`1px solid ${realtimeOk===true?"#10b98133":"#1e293b"}`, marginBottom:14 }}>
                <div style={{ color:"#64748b", fontSize:10, letterSpacing:2, fontFamily:"monospace", marginBottom:12 }}>CONNEXION TEMPS RÉEL</div>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ width:10, height:10, borderRadius:"50%", background: realtimeOk===true?"#10b981":realtimeOk===false?"#f59e0b":"#334155" }} />
                  <span style={{ color:"#94a3b8", fontSize:13 }}>
                    {realtimeOk === true  ? "Supabase Realtime connecté — nouveaux leads instantanés" :
                     realtimeOk === false ? "Mode polling actif — mise à jour toutes les 30 secondes" :
                                           "Connexion en cours…"}
                  </span>
                </div>
              </div>

              <button onClick={logout}
                style={{ width:"100%", background:"linear-gradient(135deg,#7f1d1d,#991b1b)", color:"#fca5a5", fontWeight:700, fontSize:14, border:"none", borderRadius:10, padding:"13px", cursor:"pointer" }}>
                Se déconnecter
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ══════════════════════════════════════════════════════
//  ROOT
// ══════════════════════════════════════════════════════
export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}

function AppInner() {
  const { agent, ready } = useAuth();
  if (!ready) return (
    <div style={{ minHeight:"100vh", background:"#030b14", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ textAlign:"center", color:"#334155" }}>
        <div style={{ fontSize:36, marginBottom:12 }}>🏠</div>
        <div style={{ fontSize:13, fontFamily:"monospace", letterSpacing:2 }}>IMMO GEO…</div>
      </div>
    </div>
  );
  return agent ? <Dashboard /> : <LoginScreen />;
}
