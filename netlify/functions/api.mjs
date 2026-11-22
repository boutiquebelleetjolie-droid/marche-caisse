import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// ---------- Utilitaires ----------
const store = () => getStore({ name: "marche", consistency: "strong" });
const json = (data, status = 200) => Response.json(data, { status });
const err = (msg, status = 400) => json({ erreur: msg }, status);
const secret = () => Netlify.env.get("APP_SECRET") || "dev-secret-a-changer";

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  if (p.exp && p.exp < Date.now()) return null;
  return p;
}
function hashPw(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString("hex") };
}
function checkPw(pw, rec) {
  if (!rec?.salt) return false;
  const h = crypto.scryptSync(String(pw), rec.salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(rec.hash));
}
const uid = () => crypto.randomUUID();
const moisDe = (iso) => iso.slice(0, 7);
const toCents = (v) => Math.round(Number(String(v).replace(",", ".")) * 100);

async function getJSON(key) { return await store().get(key, { type: "json" }); }
async function setJSON(key, v) { await store().setJSON(key, v); }
async function listJSON(prefix) {
  const { blobs } = await store().list({ prefix });
  const items = await Promise.all(blobs.map((b) => getJSON(b.key)));
  return items.filter(Boolean);
}

async function getSettings() {
  return {
    nomBoutique: "Le Marché des Artisans et Producteurs",
    commission: 20,
    adresse: "",
    ...((await getJSON("settings")) || {}),
  };
}

function publicArtisan(a) {
  const { pw, ...rest } = a;
  return rest;
}

// ---------- Authentification ----------
function auth(req) {
  const h = req.headers.get("authorization") || "";
  return verify(h.replace(/^Bearer\s+/i, ""));
}
async function caisseAuth(req) {
  const p = verify(req.headers.get("x-caisse") || "");
  if (!p || p.role !== "caisse") return null;
  const dev = await getJSON(`devices/${p.deviceId}`);
  if (!dev || dev.revoque) return null;
  return dev;
}

// ---------- Ventes / statistiques ----------
async function ventesDuMois(mois) {
  return (await listJSON(`sales/${mois}/`)).sort((a, b) => b.date.localeCompare(a.date));
}

// Dates à l'heure de Paris (AAAA-MM-JJ)
const parisDate = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date(iso));
const parisHeure = (iso) => Number(new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }).format(new Date(iso)));
function addDays(ymd, n) { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function periodes() {
  const auj = parisDate(new Date().toISOString());
  const d = new Date(auj + "T12:00:00Z");
  const lundi = addDays(auj, -((d.getUTCDay() + 6) % 7));
  const [y, mo] = auj.split("-").map(Number);
  const debutMois = `${y}-${String(mo).padStart(2, "0")}-01`;
  const finMois = addDays(`${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, "0")}-01`, -1);
  const qm = Math.floor((mo - 1) / 3) * 3 + 1;
  const debutTri = `${y}-${String(qm).padStart(2, "0")}-01`;
  const finTri = addDays(`${qm + 3 > 12 ? y + 1 : y}-${String(qm + 3 > 12 ? 1 : qm + 3).padStart(2, "0")}-01`, -1);
  return {
    jour: { du: auj, au: auj, libelle: "Aujourd'hui" },
    semaine: { du: lundi, au: addDays(lundi, 6), libelle: "Cette semaine" },
    mois: { du: debutMois, au: finMois, libelle: "Ce mois-ci" },
    trimestre: { du: debutTri, au: finTri, libelle: "Ce trimestre" },
  };
}
// Ventes entre deux dates (heure de Paris), en lisant les mois concernés (+ marge d'un mois pour les ventes de fin de mois)
async function ventesEntre(du, au) {
  const mois = new Set();
  let cur = addDays(du.slice(0, 7) + "-01", -1).slice(0, 7);
  const fin = au.slice(0, 7);
  while (cur <= fin) { mois.add(cur); const [y, m] = cur.split("-").map(Number); cur = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`; }
  const all = (await Promise.all([...mois].map(ventesDuMois))).flat();
  return all.filter((v) => { const d = parisDate(v.date); return d >= du && d <= au; }).sort((a, b) => b.date.localeCompare(a.date));
}
// Analyse complète pour la gérance
function analyse(ventes) {
  const tickets = ventes.length;
  const total = ventes.reduce((s, v) => s + v.total, 0);
  const articles = ventes.reduce((s, v) => s + v.lignes.reduce((a, l) => a + l.qte, 0), 0);
  const parJour = {}, parMode = {}, parHeure = {}, parArticle = {};
  for (const v of ventes) {
    const d = parisDate(v.date);
    (parJour[d] ||= { date: d, ca: 0, tickets: 0 }); parJour[d].ca += v.total; parJour[d].tickets++;
    parMode[v.paiement.mode] = (parMode[v.paiement.mode] || 0) + v.total;
    const h = parisHeure(v.date); (parHeure[h] ||= { heure: h, ca: 0, tickets: 0 }); parHeure[h].ca += v.total; parHeure[h].tickets++;
    for (const l of v.lignes) { const a = (parArticle[l.ref] ||= { ref: l.ref, nom: l.nom, artisanNom: l.artisanNom, qte: 0, ca: 0 }); a.qte += l.qte; a.ca += l.total; }
  }
  const arts = Object.values(parArticle);
  return {
    totalMagasin: total, nbVentes: tickets, articles,
    panierMoyen: tickets ? Math.round(total / tickets) : 0,
    articlesParPanier: tickets ? Math.round((articles / tickets) * 10) / 10 : 0,
    parJour: Object.values(parJour).sort((a, b) => a.date.localeCompare(b.date)),
    parMode, parHeure: Object.values(parHeure).sort((a, b) => a.heure - b.heure),
    topArticlesValeur: [...arts].sort((a, b) => b.ca - a.ca).slice(0, 10),
    topArticlesQte: [...arts].sort((a, b) => b.qte - a.qte).slice(0, 10),
  };
}

function resumeParArtisan(ventes, taux) {
  const par = {};
  let total = 0;
  for (const v of ventes) {
    if (v.annulee) continue;
    for (const l of v.lignes) {
      total += l.total;
      const r = (par[l.artisanId] ||= { artisanId: l.artisanId, artisanNom: l.artisanNom, ca: 0, articles: 0 });
      r.ca += l.total;
      r.articles += l.qte;
    }
  }
  for (const r of Object.values(par)) {
    r.commission = Math.round((r.ca * taux) / 100);
    r.net = r.ca - r.commission;
  }
  return { total, par: Object.values(par).sort((a, b) => b.ca - a.ca) };
}

// ---------- Routes ----------
export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";
  const m = req.method;
  let body = {};
  if (m !== "GET" && m !== "DELETE") {
    try { body = await req.json(); } catch { body = {}; }
  }

  try {
    // --- Connexion ---
    if (path === "/login" && m === "POST") {
      const ident = String(body.identifiant || "").trim().toLowerCase();
      const pw = String(body.motdepasse || "");
      if (ident === "admin") {
        const adm = await getJSON("admin");
        const ok = adm ? checkPw(pw, adm) : pw === Netlify.env.get("ADMIN_PASSWORD");
        if (!ok) return err("Identifiant ou mot de passe incorrect", 401);
        return json({ token: sign({ role: "admin", id: "admin", exp: Date.now() + 30 * 864e5 }), role: "admin", nom: "Gérance" });
      }
      const arts = await listJSON("artisans/");
      const a = arts.find((x) => x.identifiant === ident);
      if (!a || !a.actif || !checkPw(pw, a.pw)) return err("Identifiant ou mot de passe incorrect", 401);
      return json({ token: sign({ role: "artisan", id: a.id, exp: Date.now() + 30 * 864e5 }), role: "artisan", nom: a.nom, initiales: a.initiales });
    }

    if (path === "/settings/public" && m === "GET") {
      const s = await getSettings();
      return json({ nomBoutique: s.nomBoutique, adresse: s.adresse, commission: s.commission });
    }

    // --- Espace caisse (uniquement sur un poste activé) ---
    if (path.startsWith("/caisse")) {
      const dev = await caisseAuth(req);
      if (!dev) return err("Ce poste n'est pas activé comme caisse", 403);

      if (path === "/caisse/produits" && m === "GET") {
        const [prods, arts] = await Promise.all([listJSON("products/"), listJSON("artisans/")]);
        const noms = Object.fromEntries(arts.map((a) => [a.id, a.nom]));
        return json(prods.filter((p) => p.actif !== false).map((p) => ({ ...p, artisanNom: noms[p.artisanId] || "" })));
      }

      if (path === "/caisse/ventes" && m === "POST") {
        const lignesIn = Array.isArray(body.lignes) ? body.lignes : [];
        if (!lignesIn.length) return err("Panier vide");
        const arts = Object.fromEntries((await listJSON("artisans/")).map((a) => [a.id, a]));
        const lignes = [];
        for (const l of lignesIn) {
          const p = await getJSON(`products/${l.ref}`);
          if (!p) return err(`Article inconnu : ${l.ref}`);
          const qte = Math.max(1, parseInt(l.qte, 10) || 1);
          lignes.push({ ref: p.ref, nom: p.nom, artisanId: p.artisanId, artisanNom: arts[p.artisanId]?.nom || "", qte, pu: p.prix, total: p.prix * qte });
        }
        const total = lignes.reduce((s, l) => s + l.total, 0);
        const pay = body.paiement || {};
        const paiement = { mode: pay.mode || "CB", recu: pay.recu ? toCents(pay.recu) : null };
        const date = new Date().toISOString();
        const vente = { id: uid(), numero: `${date.slice(0, 10).replace(/-/g, "")}-${Date.now().toString().slice(-5)}`, date, lignes, total, paiement, poste: dev.nom, annulee: false };
        await setJSON(`sales/${moisDe(date)}/${vente.id}`, vente);
        // mise à jour des stocks
        for (const l of lignes) {
          const p = await getJSON(`products/${l.ref}`);
          if (p && typeof p.stock === "number") { p.stock = Math.max(0, p.stock - l.qte); await setJSON(`products/${p.ref}`, p); }
        }
        return json(vente);
      }

      if (path === "/caisse/jour" && m === "GET") {
        const jour = url.searchParams.get("date") || parisDate(new Date().toISOString());
        const ventes = (await ventesEntre(jour, jour)).filter((v) => parisDate(v.date) === jour);
        const ok = ventes.filter((v) => !v.annulee);
        const parMode = {};
        for (const v of ok) parMode[v.paiement.mode] = (parMode[v.paiement.mode] || 0) + v.total;
        return json({ jour, ventes, total: ok.reduce((s, v) => s + v.total, 0), nbVentes: ok.length, parMode });
      }
      return err("Route inconnue", 404);
    }

    // --- Routes connectées ---
    const user = auth(req);
    if (!user) return err("Veuillez vous reconnecter", 401);
    const isAdmin = user.role === "admin";
    const settings = await getSettings();

    if (path === "/me" && m === "GET") {
      if (isAdmin) return json({ role: "admin", nom: "Gérance" });
      const a = await getJSON(`artisans/${user.id}`);
      if (!a || !a.actif) return err("Compte désactivé", 401);
      return json({ role: "artisan", ...publicArtisan(a) });
    }

    if (path === "/motdepasse" && m === "POST") {
      const nouveau = String(body.nouveau || "");
      if (nouveau.length < 6) return err("Le mot de passe doit faire au moins 6 caractères");
      if (isAdmin) { await setJSON("admin", hashPw(nouveau)); return json({ ok: true }); }
      const a = await getJSON(`artisans/${user.id}`);
      if (!checkPw(body.actuel, a.pw)) return err("Mot de passe actuel incorrect");
      a.pw = hashPw(nouveau);
      await setJSON(`artisans/${a.id}`, a);
      return json({ ok: true });
    }

    // --- Produits ---
    if (path === "/produits" && m === "GET") {
      const prods = await listJSON("products/");
      const list = isAdmin ? prods : prods.filter((p) => p.artisanId === user.id);
      return json(list.sort((a, b) => a.ref.localeCompare(b.ref, "fr", { numeric: true })));
    }
    if (path === "/produits" && m === "POST") {
      const artisanId = isAdmin ? body.artisanId : user.id;
      const a = await getJSON(`artisans/${artisanId}`);
      if (!a) return err("Artisan introuvable");
      if (!body.nom || !(toCents(body.prix) > 0)) return err("Nom et prix obligatoires");
      a.nextRef = (a.nextRef || 1);
      const ref = `${a.initiales}${String(a.nextRef).padStart(3, "0")}`;
      a.nextRef += 1;
      await setJSON(`artisans/${a.id}`, a);
      const p = {
        ref, artisanId, nom: String(body.nom).trim(), prix: toCents(body.prix),
        stock: body.stock === "" || body.stock == null ? null : Math.max(0, parseInt(body.stock, 10) || 0),
        categorie: String(body.categorie || "").trim(), description: String(body.description || "").trim(),
        actif: true, creeLe: new Date().toISOString(),
      };
      await setJSON(`products/${ref}`, p);
      return json(p);
    }
    const mProd = path.match(/^\/produits\/([A-Za-z0-9-]+)$/);
    if (mProd) {
      const p = await getJSON(`products/${mProd[1]}`);
      if (!p) return err("Article introuvable", 404);
      if (!isAdmin && p.artisanId !== user.id) return err("Accès refusé", 403);
      if (m === "PUT") {
        if (body.nom != null) p.nom = String(body.nom).trim();
        if (body.prix != null && toCents(body.prix) > 0) p.prix = toCents(body.prix);
        if (body.stock !== undefined) p.stock = body.stock === "" || body.stock == null ? null : Math.max(0, parseInt(body.stock, 10) || 0);
        if (body.categorie != null) p.categorie = String(body.categorie).trim();
        if (body.description != null) p.description = String(body.description).trim();
        if (body.actif != null) p.actif = !!body.actif;
        await setJSON(`products/${p.ref}`, p);
        return json(p);
      }
      if (m === "DELETE") { p.actif = false; await setJSON(`products/${p.ref}`, p); return json({ ok: true }); }
    }

    // --- Statistiques ---
    // Résumé jour / semaine / mois / trimestre (artisan : ses chiffres + chiffre global du magasin)
    if (path === "/stats/resume" && m === "GET") {
      const p = periodes();
      const ventes = (await ventesEntre(p.trimestre.du, p.trimestre.au));
      const out = {};
      for (const [k, r] of Object.entries(p)) {
        const vs = ventes.filter((v) => { const d = parisDate(v.date); return d >= r.du && d <= r.au; });
        const res = resumeParArtisan(vs, settings.commission);
        const mine = res.par.find((x) => x.artisanId === user.id) || { ca: 0, articles: 0, commission: 0, net: 0 };
        out[k] = { ...r, magasin: res.total, tickets: vs.filter((v) => !v.annulee).length, moi: isAdmin ? null : mine };
      }
      return json({ commissionTaux: settings.commission, periodes: out });
    }
    if (path === "/stats" && m === "GET") {
      const p = periodes();
      const du = url.searchParams.get("du") || p.mois.du;
      const au = url.searchParams.get("au") || p.mois.au;
      const ventes = (await ventesEntre(du, au)).filter((v) => !v.annulee);
      const res = resumeParArtisan(ventes, settings.commission);
      if (isAdmin) return json({ du, au, commissionTaux: settings.commission, ...analyse(ventes), parArtisan: res.par });
      const mine = res.par.find((r) => r.artisanId === user.id) || { ca: 0, commission: 0, net: 0, articles: 0 };
      const lignes = [];
      for (const v of ventes) for (const l of v.lignes) if (l.artisanId === user.id) lignes.push({ date: v.date, ref: l.ref, nom: l.nom, qte: l.qte, pu: l.pu, total: l.total });
      const parArticle = {};
      for (const l of lignes) { const a = (parArticle[l.ref] ||= { ref: l.ref, nom: l.nom, qte: 0, ca: 0 }); a.qte += l.qte; a.ca += l.total; }
      return json({ du, au, commissionTaux: settings.commission, totalMagasin: res.total, moi: mine, lignes, topArticles: Object.values(parArticle).sort((a, b) => b.ca - a.ca).slice(0, 10) });
    }

    // ---------- Administration (gérance uniquement) ----------
    if (!isAdmin) return err("Réservé à la gérance", 403);

    if (path === "/artisans" && m === "GET") {
      return json((await listJSON("artisans/")).map(publicArtisan).sort((a, b) => a.nom.localeCompare(b.nom, "fr")));
    }
    if (path === "/artisans" && m === "POST") {
      const nom = String(body.nom || "").trim();
      const initiales = String(body.initiales || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
      const identifiant = String(body.identifiant || "").trim().toLowerCase();
      if (!nom || initiales.length < 2 || !identifiant || String(body.motdepasse || "").length < 6) return err("Nom, initiales (2 lettres min.), identifiant et mot de passe (6 caractères min.) obligatoires");
      const arts = await listJSON("artisans/");
      if (arts.some((a) => a.initiales === initiales)) return err("Ces initiales sont déjà utilisées");
      if (identifiant === "admin" || arts.some((a) => a.identifiant === identifiant)) return err("Cet identifiant est déjà utilisé");
      const a = {
        id: uid(), nom, initiales, identifiant, pw: hashPw(body.motdepasse),
        metier: String(body.metier || "").trim(), telephone: String(body.telephone || "").trim(), email: String(body.email || "").trim(),
        stand: String(body.stand || "1 m"), dateDebut: String(body.dateDebut || "").slice(0, 10), actif: true, nextRef: 1, creeLe: new Date().toISOString(),
      };
      await setJSON(`artisans/${a.id}`, a);
      return json(publicArtisan(a));
    }
    const mArt = path.match(/^\/artisans\/([a-f0-9-]+)$/);
    if (mArt && m === "PUT") {
      const a = await getJSON(`artisans/${mArt[1]}`);
      if (!a) return err("Artisan introuvable", 404);
      for (const k of ["nom", "metier", "telephone", "email", "stand", "dateDebut"]) if (body[k] != null) a[k] = String(body[k]).trim();
      if (body.actif != null) a.actif = !!body.actif;
      if (body.motdepasse) { if (String(body.motdepasse).length < 6) return err("Mot de passe : 6 caractères minimum"); a.pw = hashPw(body.motdepasse); }
      await setJSON(`artisans/${a.id}`, a);
      return json(publicArtisan(a));
    }

    if (path === "/ventes" && m === "GET") {
      const mois = url.searchParams.get("mois") || new Date().toISOString().slice(0, 7);
      return json(await ventesDuMois(mois));
    }
    const mVente = path.match(/^\/ventes\/(\d{4}-\d{2})\/([a-f0-9-]+)\/annuler$/);
    if (mVente && m === "POST") {
      const key = `sales/${mVente[1]}/${mVente[2]}`;
      const v = await getJSON(key);
      if (!v) return err("Vente introuvable", 404);
      if (v.annulee) return json(v);
      v.annulee = true; v.annuleeLe = new Date().toISOString();
      await setJSON(key, v);
      for (const l of v.lignes) {
        const p = await getJSON(`products/${l.ref}`);
        if (p && typeof p.stock === "number") { p.stock += l.qte; await setJSON(`products/${p.ref}`, p); }
      }
      return json(v);
    }

    if (path === "/settings" && m === "GET") return json(settings);
    if (path === "/settings" && m === "PUT") {
      const s = { ...settings };
      if (body.nomBoutique != null) s.nomBoutique = String(body.nomBoutique).trim();
      if (body.adresse != null) s.adresse = String(body.adresse).trim();
      if (body.commission != null) s.commission = Math.min(100, Math.max(0, Number(body.commission) || 0));
      await setJSON("settings", s);
      return json(s);
    }

    if (path === "/postes" && m === "GET") return json(await listJSON("devices/"));
    if (path === "/postes" && m === "POST") {
      const dev = { id: uid(), nom: String(body.nom || "Caisse").trim(), creeLe: new Date().toISOString(), revoque: false };
      await setJSON(`devices/${dev.id}`, dev);
      return json({ ...dev, cle: sign({ role: "caisse", deviceId: dev.id }) });
    }
    const mPoste = path.match(/^\/postes\/([a-f0-9-]+)$/);
    if (mPoste && m === "DELETE") {
      const dev = await getJSON(`devices/${mPoste[1]}`);
      if (dev) { dev.revoque = true; await setJSON(`devices/${dev.id}`, dev); }
      return json({ ok: true });
    }

    return err("Route inconnue", 404);
  } catch (e) {
    console.error(e);
    return err("Erreur serveur : " + e.message, 500);
  }
};

export const config = { path: "/api/*" };
