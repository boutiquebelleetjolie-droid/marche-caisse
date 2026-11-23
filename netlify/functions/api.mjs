import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// ---------- Utilitaires ----------
class UErr extends Error {} // erreur à afficher telle quelle à l'utilisateur
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

// Article propre à la boutique (hors artisans) : le sac
const SAC = { ref: "SAC", nom: "Sac", prix: 20, artisanId: "boutique", actif: true, stock: null };
// Carte cadeau : montant libre, ce n'est pas du chiffre d'affaires (c'est de l'argent dû au client jusqu'à son utilisation)
const CADEAU = { ref: "CADEAU", nom: "Carte cadeau", prix: 0, artisanId: "cartecadeau", actif: true, stock: null };
async function getProduit(ref) {
  const R = String(ref).toUpperCase();
  return R === "SAC" ? SAC : R === "CADEAU" ? CADEAU : await getJSON(`products/${ref}`);
}
const estCadeau = (l) => l.artisanId === "cartecadeau";
// Moyens de paiement qui ne sont pas de l'argent encaissé
const HORS_ENCAISSEMENT = ["Bon d'achat", "Avoir émis"];
function codeBon(prefixe) { return prefixe + "-" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6); }
async function creerBon(type, montant, origine) {
  const prefixe = type === "avoir" ? "AV" : "CC";
  let code; do code = codeBon(prefixe); while (await getJSON(`bons/${code}`));
  const d = new Date(); const exp = new Date(d); exp.setFullYear(d.getFullYear() + 1);
  const b = { code, type, montant, solde: montant, creeLe: d.toISOString(), expire: exp.toISOString().slice(0, 10), origine, mouvements: [{ date: d.toISOString(), montant, detail: "Émission" }], annule: false };
  await setJSON(`bons/${code}`, b);
  return b;
}
async function mouvementBon(code, delta, detail) {
  const b = await getJSON(`bons/${code}`);
  if (!b) return null;
  b.solde = Math.max(0, b.solde + delta);
  b.mouvements.push({ date: new Date().toISOString(), montant: delta, detail });
  await setJSON(`bons/${code}`, b);
  return b;
}
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
    fondReserve: 8000,
    siret: "",
    mentionTVA: "TVA non applicable, art. 293 B du CGI",
    prixStand1: 10000,
    prixStand2: 18000,
    supplementSansAccueil: 5000,
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
// Chiffre d'affaires d'un ticket = articles vendus (hors cartes cadeaux vendues)
const caTicket = (v) => v.lignes.reduce((s, l) => s + (estCadeau(l) ? 0 : l.total), 0);
const estRetour = (v) => v.type === "retour";
function analyse(ventes) {
  const tickets = ventes.filter((v) => !estRetour(v)).length;
  const total = ventes.reduce((s, v) => s + caTicket(v), 0);
  const articles = ventes.reduce((s, v) => s + v.lignes.reduce((a, l) => a + (estCadeau(l) ? 0 : l.qte), 0), 0);
  const parJour = {}, parMode = {}, parHeure = {}, parArticle = {};
  for (const v of ventes) {
    const d = parisDate(v.date), ca = caTicket(v), t = estRetour(v) ? 0 : 1;
    (parJour[d] ||= { date: d, ca: 0, tickets: 0 }); parJour[d].ca += ca; parJour[d].tickets += t;
    for (const [k, x] of Object.entries(montantsParMode(v))) parMode[k] = (parMode[k] || 0) + x;
    const h = parisHeure(v.date); (parHeure[h] ||= { heure: h, ca: 0, tickets: 0 }); parHeure[h].ca += ca; parHeure[h].tickets += t;
    for (const l of v.lignes) { if (estCadeau(l)) continue; const a = (parArticle[l.ref] ||= { ref: l.ref, nom: l.nom, artisanId: l.artisanId, artisanNom: l.artisanNom, qte: 0, ca: 0 }); a.qte += l.qte; a.ca += l.total; }
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
    tousArticles: arts,
    retours: { nb: ventes.filter(estRetour).length, montant: -ventes.filter(estRetour).reduce((s, v) => s + caTicket(v), 0) },
    cartesVendues: ventes.reduce((s, v) => s + v.lignes.reduce((a, l) => a + (estCadeau(l) ? l.total : 0), 0), 0),
  };
}

// Comptage du tiroir : { "50": 2, "0.2": 5 } (valeur en euros -> nombre)
function totalComptage(c) {
  return Object.entries(c || {}).reduce((s, [val, n]) => s + Math.round(Number(val) * 100) * (parseInt(n, 10) || 0), 0);
}
async function calculerZ(jour, comptageFermeture) {
  const s = await getSettings();
  const toutes = await ventesEntre(jour, jour);
  const ventes = toutes.filter((v) => !v.annulee);
  const annulees = toutes.filter((v) => v.annulee);
  const [ouverture, sorties] = await Promise.all([getJSON(`caisse/${jour}/ouverture`), listJSON(`caisse/${jour}/sorties/`)]);
  const parMode = {};
  Object.assign(parMode, cumulModes(ventes));
  const A = analyse(ventes);
  const ca = A.totalMagasin, articles = A.articles;
  const encaisse = Object.entries(parMode).reduce((t, [k, x]) => t + (HORS_ENCAISSEMENT.includes(k) ? 0 : x), 0);
  const parVendeur = {};
  for (const v of ventes) { const n = v.vendeur?.nom || "Non renseigné"; (parVendeur[n] ||= { nom: n, tickets: 0, ca: 0 }); if (!estRetour(v)) parVendeur[n].tickets++; parVendeur[n].ca += caTicket(v); }
  const especes = parMode["Espèces"] || 0;
  const fondOuverture = ouverture ? ouverture.total : s.fondReserve;
  const totalSorties = sorties.reduce((t, x) => t + x.montant, 0);
  const fondFermeture = totalComptage(comptageFermeture);
  const attendu = fondOuverture + especes - totalSorties;
  const res = resumeParArtisan(ventes, s.commission);
  return {
    jour, heure: new Date().toISOString(), nbVentes: A.nbVentes, articles, ca, parMode, encaisse,
    retours: A.retours, cartesVendues: A.cartesVendues, parVendeur: Object.values(parVendeur),
    panierMoyen: A.panierMoyen,
    annulations: { nb: annulees.length, montant: annulees.reduce((t, v) => t + v.total, 0) },
    commission: res.par.reduce((t, r) => t + r.commission, 0), parArtisan: res.par,
    fondOuverture, ouvertureValidee: !!ouverture, especes, sorties, totalSorties,
    comptageFermeture, fondFermeture, attendu, ecart: fondFermeture - attendu,
    fondReserve: s.fondReserve, aDeposer: Math.max(0, fondFermeture - s.fondReserve),
  };
}

// Remise : { type: "%" | "€", valeur }
function calcRemise(r, base) {
  if (!r || !r.valeur) return 0;
  const v = Number(String(r.valeur).replace(",", "."));
  if (!(v > 0)) return 0;
  return Math.min(base, r.type === "%" ? Math.round((base * Math.min(v, 100)) / 100) : Math.round(v * 100));
}
// Répartition d'un ticket par moyen de paiement (le paiement mixte est réparti)
function montantsParMode(v) {
  const p = v.paiement, r = {};
  if (p.mode === "Avoir émis") return { "Avoir émis": v.total };
  const bon = p.bon?.montant || 0;
  if (bon) r["Bon d'achat"] = bon;
  if (p.mode === "Mixte") { r.CB = p.cb || 0; r["Espèces"] = p.especes || 0; }
  else if (p.mode !== "Bon") r[p.mode] = v.total - bon;
  return r;
}
function cumulModes(ventes) {
  const r = {};
  for (const v of ventes) for (const [k, x] of Object.entries(montantsParMode(v))) r[k] = (r[k] || 0) + x;
  return r;
}

// ---- Planning des permanences ----
// Mardi à samedi. Matin 10h-14h, après-midi 14h-18h30 (19h le samedi). 2 personnes le mardi et le samedi, 1 les autres jours.
function creneauxDuJour(ymd) {
  const j = new Date(ymd + "T12:00:00Z").getUTCDay(); // 0 dim, 1 lun
  if (j === 0 || j === 1) return [];
  const places = j === 2 || j === 6 ? 2 : 1;
  return [
    { id: "matin", libelle: "Matin 10h – 14h", places },
    { id: "aprem", libelle: j === 6 ? "Après-midi 14h – 19h" : "Après-midi 14h – 18h30", places },
  ];
}
async function planningMois(mois) {
  const [y, m] = mois.split("-").map(Number);
  const nb = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const inscrits = await listJSON(`planning/${mois}`);
  const jours = [];
  for (let d = 1; d <= nb; d++) {
    const ymd = `${mois}-${String(d).padStart(2, "0")}`;
    const cr = creneauxDuJour(ymd);
    if (!cr.length) continue;
    jours.push({ date: ymd, creneaux: cr.map((c) => ({ ...c, inscrits: inscrits.filter((x) => x.date === ymd && x.creneau === c.id) })) });
  }
  return jours;
}
async function inscrire(date, creneau, a) {
  const c = creneauxDuJour(date).find((x) => x.id === creneau);
  if (!c) throw new UErr("Pas de permanence ce jour-là");
  const deja = await listJSON(`planning/${date.slice(0, 7)}`);
  const ici = deja.filter((x) => x.date === date && x.creneau === creneau);
  if (ici.some((x) => x.artisanId === a.id)) throw new UErr("Vous êtes déjà inscrit sur ce créneau");
  if (ici.length >= c.places) throw new UErr("Ce créneau est complet");
  const e = { date, creneau, artisanId: a.id, initiales: a.initiales, nom: a.nom, inscritLe: new Date().toISOString(), absent: false };
  await setJSON(`planning/${date.slice(0, 7)}/${date}/${creneau}/${a.id}`, e);
  return e;
}
async function artisanParInitiales(ini) {
  const I = String(ini || "").trim().toUpperCase();
  return (await listJSON("artisans/")).find((a) => a.initiales === I && a.actif);
}
// Relevé mensuel + facture de commission d'un artisan
// Calcul d'un mois pour un artisan, avec report de ce qui restait dû le mois précédent
function moisPrecedent(mois) { const [y, m] = mois.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; }
async function calculMois(mois, a, s) {
  const [y, m] = mois.split("-").map(Number);
  const du = `${mois}-01`, au = `${mois}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const ventes = (await ventesEntre(du, au)).filter((v) => !v.annulee);
  const lignes = [];
  for (const v of ventes) for (const l of v.lignes) if (l.artisanId === a.id) lignes.push({ date: v.date, ticket: v.numero, ref: l.ref, nom: l.nom, qte: l.qte, pu: l.pu, total: l.total });
  lignes.sort((p, q) => p.date.localeCompare(q.date));
  const ca = lignes.reduce((t, l) => t + l.total, 0);
  const commission = Math.round((ca * s.commission) / 100);
  const sansAccueil = a.formule === "sans accueil" && (!a.formuleDepuis || du >= a.formuleDepuis);
  const supplement = sansAccueil ? s.supplementSansAccueil : 0;
  // report : uniquement à partir du mois de début du contrat (ou de création du compte)
  const debut = (a.dateDebut || a.creeLe || du).slice(0, 7);
  let report = 0;
  const prev = moisPrecedent(mois);
  if (prev >= debut) { const p = await calculMois(prev, a, s); if (p.solde < 0) report = -p.solde; }
  return { du, au, lignes, ca, commission, supplement, sansAccueil, report, solde: ca - commission - supplement - report };
}
async function releve(mois, artisanId) {
  const s = await getSettings();
  const a = await getJSON(`artisans/${artisanId}`);
  if (!a) throw new UErr("Artisan introuvable");
  const c = await calculMois(mois, a, s);
  const loyer = (a.stand === "2 m" ? s.prixStand2 : s.prixStand1) + c.supplement;
  // numéro de facture attribué une seule fois par artisan et par mois
  let fac = await getJSON(`factures/${mois}/${artisanId}`);
  if (!fac) {
    const cpt = ((await getJSON("compteurFacture"))?.n || 0) + 1;
    await setJSON("compteurFacture", { n: cpt });
    fac = { numero: `F${mois.replace("-", "")}-${String(cpt).padStart(4, "0")}`, emiseLe: new Date().toISOString() };
    await setJSON(`factures/${mois}/${artisanId}`, fac);
  }
  return {
    mois, du: c.du, au: c.au, boutique: { nom: s.nomBoutique, adresse: s.adresse, siret: s.siret, mentionTVA: s.mentionTVA },
    artisan: { nom: a.nom, initiales: a.initiales, email: a.email, telephone: a.telephone, stand: a.stand },
    lignes: c.lignes, ca: c.ca, commissionTaux: s.commission, commission: c.commission, penalites: [], totalPenalites: 0, loyer,
    formule: c.sansAccueil ? "sans participation à l'accueil" : "avec participation à l'accueil",
    supplement: c.supplement, report: c.report, aReverser: c.solde, facture: fac, reversement: await getJSON(`reversements/${mois}/${artisanId}`),
  };
}

// ---- Alertes : rupture, stock bas, date limite proche ou dépassée ----
function alertesProduits(prods, auj) {
  const dans7 = addDays(auj, 7), out = [];
  for (const p of prods) {
    if (typeof p.stock === "number" && p.stock === 0) out.push({ ...p, alerte: "Rupture de stock", niveau: 2 });
    else if (typeof p.stock === "number" && p.seuil != null && p.stock <= p.seuil) out.push({ ...p, alerte: `Stock bas (${p.stock})`, niveau: 1 });
    if (p.dlc && p.dlc < auj) out.push({ ...p, alerte: "Date limite dépassée", niveau: 2 });
    else if (p.dlc && p.dlc <= dans7) out.push({ ...p, alerte: "Date limite dans moins de 7 jours", niveau: 1 });
  }
  return out.sort((a, b) => b.niveau - a.niveau);
}

// ---- Annulations, modifications, journal ----
async function majStock(ref, delta) {
  const p = await getJSON(`products/${ref}`);
  if (p && typeof p.stock === "number") { p.stock = Math.max(0, p.stock + delta); await setJSON(`products/${p.ref}`, p); }
}
async function journaliser(e) {
  const date = new Date().toISOString();
  const entry = { id: uid(), date, ...e };
  await setJSON(`journal/${parisDate(date).slice(0, 7)}/${entry.id}`, entry);
  return entry;
}
// Annule un ticket entier (ligne = null) ou une ligne (index) d'un ticket
async function annulerVente(mois, id, { ligne = null, motif = "", par = "" }) {
  const key = `sales/${mois}/${id}`;
  const v = await getJSON(key);
  if (!v) throw new UErr("Vente introuvable");
  if (v.annulee) return v;
  v.historique ||= [];
  const annulerCarte = async (l) => { if (estCadeau(l) && l.code) { const b = await getJSON(`bons/${l.code}`); if (b) { b.annule = true; b.solde = 0; b.mouvements.push({ date: new Date().toISOString(), montant: 0, detail: "Carte annulée avec le ticket " + v.numero }); await setJSON(`bons/${b.code}`, b); } } };
  if (ligne === null || ligne === undefined) {
    v.annulee = true; v.annuleeLe = new Date().toISOString();
    for (const l of v.lignes) { if (!estCadeau(l)) await majStock(l.ref, l.qte); await annulerCarte(l); }
    if (v.paiement.bon?.montant) await mouvementBon(v.paiement.bon.code, v.paiement.bon.montant, "Ticket " + v.numero + " annulé");
    if (v.paiement.avoir) { const b = await getJSON(`bons/${v.paiement.avoir}`); if (b) { b.annule = true; b.solde = 0; await setJSON(`bons/${b.code}`, b); } }
    if (v.origine) { const o = await getJSON(`sales/${v.origine.mois}/${v.origine.id}`); if (o) { for (const r of v.origine.lignes || []) if (o.lignes[r.index]) o.lignes[r.index].retourne = Math.max(0, (o.lignes[r.index].retourne || 0) - r.qte); await setJSON(`sales/${v.origine.mois}/${o.id}`, o); } }
    v.historique.push({ date: v.annuleeLe, action: "Ticket annulé", motif, par });
    await journaliser({ type: "Annulation de ticket", ticket: v.numero, montant: v.total, motif, par });
  } else {
    const l = v.lignes[ligne];
    if (!l) throw new UErr("Ligne introuvable");
    if (estRetour(v)) throw new UErr("Pour un retour, annulez le ticket de retour en entier");
    v.lignes.splice(ligne, 1);
    v.total -= l.total;
    // si un bon d'achat couvrait plus que le nouveau total, la différence revient sur le bon
    if (v.paiement.bon?.montant > v.total) { const d = v.paiement.bon.montant - v.total; await mouvementBon(v.paiement.bon.code, d, "Ligne annulée sur le ticket " + v.numero); v.paiement.bon.montant = v.total; }
    const reste = v.total - (v.paiement.bon?.montant || 0);
    if (v.paiement.mode === "Mixte") { v.paiement.cb = Math.min(reste, v.paiement.cb || 0); v.paiement.especes = reste - v.paiement.cb; }
    if (!estCadeau(l)) await majStock(l.ref, l.qte);
    await annulerCarte(l);
    v.historique.push({ date: new Date().toISOString(), action: `Ligne annulée : ${l.qte} × ${l.nom} (${l.artisanNom})`, motif, par });
    await journaliser({ type: "Annulation de ligne", ticket: v.numero, detail: `${l.qte} × ${l.nom} (${l.artisanNom})`, montant: l.total, motif, par });
    if (!v.lignes.length) { v.annulee = true; v.annuleeLe = new Date().toISOString(); }
  }
  await setJSON(key, v);
  return v;
}

function resumeParArtisan(ventes, taux) {
  const par = {};
  let total = 0;
  for (const v of ventes) {
    if (v.annulee) continue;
    for (const l of v.lignes) {
      if (estCadeau(l)) continue;
      total += l.total;
      const r = (par[l.artisanId] ||= { artisanId: l.artisanId, artisanNom: l.artisanNom, ca: 0, articles: 0 });
      r.ca += l.total;
      r.articles += l.qte;
    }
  }
  for (const r of Object.values(par)) {
    r.commission = r.artisanId === "boutique" ? r.ca : Math.round((r.ca * taux) / 100);
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
      return json({ nomBoutique: s.nomBoutique, adresse: s.adresse, commission: s.commission, fondReserve: s.fondReserve });
    }

    // --- Espace caisse (uniquement sur un poste activé) ---
    if (path.startsWith("/caisse")) {
      const dev = await caisseAuth(req);
      if (!dev) return err("Ce poste n'est pas activé comme caisse", 403);

      if (path === "/caisse/produits" && m === "GET") {
        const [prods, arts] = await Promise.all([listJSON("products/"), listJSON("artisans/")]);
        const noms = Object.fromEntries(arts.map((a) => [a.id, a.nom]));
        return json([{ ...SAC, artisanNom: "Boutique" }, ...prods.filter((p) => p.actif !== false).map((p) => ({ ...p, artisanNom: noms[p.artisanId] || "" }))]);
      }

      if (path === "/caisse/ventes" && m === "POST") {
        const lignesIn = Array.isArray(body.lignes) ? body.lignes : [];
        if (!lignesIn.length) return err("Panier vide");
        // vente enregistrée hors connexion : même identifiant => pas de doublon
        const idClient = /^[a-f0-9-]{36}$/.test(body.id || "") ? body.id : null;
        const date = idClient && body.date && !isNaN(Date.parse(body.date)) ? new Date(body.date).toISOString() : new Date().toISOString();
        if (idClient) { const ex = await getJSON(`sales/${moisDe(date)}/${idClient}`); if (ex) return json(ex); }
        const listeArts = await listJSON("artisans/");
        const arts = Object.fromEntries(listeArts.map((a) => [a.id, a]));
        // qui encaisse : la gérance connectée, ou l'artisan d'accueil identifié par ses initiales
        let vendeur;
        if (auth(req)?.role === "admin") vendeur = { initiales: "GÉR", nom: "Gérance" };
        else {
          const I = String(body.vendeur || "").trim().toUpperCase();
          const a = listeArts.find((x) => x.initiales === I && x.actif);
          if (!a && !idClient) return err("Indiquez les initiales de la personne en caisse");
          if (!a && !body.sync) return err("Initiales de la personne en caisse inconnues");
          vendeur = a ? { initiales: a.initiales, nom: a.nom } : { initiales: I, nom: I || "Non renseigné" };
        }
        const lignes = [];
        for (const l of lignesIn) {
          const p = await getProduit(l.ref);
          if (!p) return err(`Article inconnu : ${l.ref}`);
          if (estCadeau(p)) {
            const montant = toCents(l.montant || 0);
            if (!(montant > 0)) return err("Montant de la carte cadeau manquant");
            lignes.push({ ref: "CADEAU", nom: "Carte cadeau", artisanId: "cartecadeau", artisanNom: "Carte cadeau", qte: 1, pu: montant, remise: null, total: montant });
            continue;
          }
          const qte = Math.max(1, parseInt(l.qte, 10) || 1);
          const artisanNom = p.artisanId === "boutique" ? "Boutique" : arts[p.artisanId]?.nom || "";
          const brut = p.prix * qte;
          const remise = calcRemise(l.remise, brut);
          lignes.push({ ref: p.ref, nom: p.nom, artisanId: p.artisanId, artisanNom, qte, pu: p.prix, remise: remise ? { ...l.remise, montant: remise } : null, total: brut - remise });
        }
        // remise sur tout le ticket : répartie au prorata sur les lignes
        let remiseTicket = null;
        // remise sur le ticket : uniquement sur les articles (pas sur les cartes cadeaux)
        const remisables = lignes.filter((l) => !estCadeau(l));
        const sousTotal = remisables.reduce((t, l) => t + l.total, 0);
        const rt = calcRemise(body.remiseTicket, sousTotal);
        if (rt > 0) {
          let reste = rt;
          remisables.forEach((l, i) => { const part = i === remisables.length - 1 ? reste : Math.round((rt * l.total) / sousTotal); l.total -= part; l.remiseTicket = part; reste -= part; });
          remiseTicket = { ...body.remiseTicket, montant: rt };
        }
        const total = lignes.reduce((t, l) => t + l.total, 0);
        const pay = body.paiement || {};
        const paiement = { mode: ["CB", "Espèces", "Mixte"].includes(pay.mode) ? pay.mode : "CB", recu: pay.recu ? toCents(pay.recu) : null };
        // bon d'achat / avoir / carte cadeau utilisé en premier
        let bonUtilise = null;
        if (pay.bon) {
          const b = await getJSON(`bons/${String(pay.bon).trim().toUpperCase()}`);
          if (!b || b.annule) return err("Bon d'achat introuvable");
          if (b.expire < parisDate(date)) return err(`Ce bon a expiré le ${b.expire.split("-").reverse().join("/")}`);
          if (!(b.solde > 0)) return err("Ce bon a déjà été entièrement utilisé");
          bonUtilise = b;
          paiement.bon = { code: b.code, type: b.type, montant: Math.min(b.solde, total) };
        }
        const reste = total - (paiement.bon?.montant || 0);
        if (reste === 0 && paiement.bon) { paiement.mode = "Bon"; paiement.recu = null; }
        if (paiement.mode === "Mixte") {
          paiement.cb = toCents(pay.cb || 0);
          paiement.especes = reste - paiement.cb;
          if (paiement.cb < 0 || paiement.especes < 0) return err("Montants du paiement mixte incorrects");
        }
        const vente = { id: idClient || uid(), numero: `${parisDate(date).replace(/-/g, "")}-${Date.parse(date).toString().slice(-5)}`, date, lignes, remiseTicket, total, paiement, vendeur, poste: dev.nom, horsLigne: !!body.sync, annulee: false };
        if (bonUtilise) await mouvementBon(bonUtilise.code, -paiement.bon.montant, "Utilisé sur le ticket " + vente.numero);
        for (const l of lignes) if (estCadeau(l)) l.code = (await creerBon("carte cadeau", l.total, vente.numero)).code;
        await setJSON(`sales/${moisDe(date)}/${vente.id}`, vente);
        for (const l of lignes) if (!estCadeau(l)) await majStock(l.ref, -l.qte);
        return json(vente);
      }

      // ----- Retour / échange -----
      if (path === "/caisse/ticket" && m === "GET") {
        const n = String(url.searchParams.get("numero") || "").trim();
        const md = n.match(/^(\d{4})(\d{2})\d{2}-/);
        if (!md) return err("Numéro de ticket incorrect (ex. 20270115-12345)");
        const mois = `${md[1]}-${md[2]}`;
        const v = (await ventesDuMois(mois)).find((x) => x.numero === n);
        if (!v) return err("Ticket introuvable");
        return json(v);
      }
      if (path === "/caisse/retour" && m === "POST") {
        const gerantR = auth(req)?.role === "admin";
        const motif = String(body.motif || "").trim(), par = String(body.par || "").trim();
        if (!gerantR && (!motif || !par)) return err("Motif et nom obligatoires pour un retour");
        const key = `sales/${body.mois}/${body.id}`;
        const o = await getJSON(key);
        if (!o) return err("Ticket introuvable");
        if (o.annulee) return err("Ce ticket est annulé");
        if (estRetour(o)) return err("Impossible de faire un retour sur un ticket de retour");
        const choix = (body.lignes || []).map((r) => ({ index: parseInt(r.index, 10), qte: parseInt(r.qte, 10) || 0 })).filter((r) => r.qte > 0);
        if (!choix.length) return err("Choisissez au moins un article à reprendre");
        const lignes = [];
        for (const r of choix) {
          const l = o.lignes[r.index];
          if (!l) return err("Ligne introuvable");
          if (estCadeau(l) || l.artisanId === "boutique") return err(`${l.nom} ne peut pas être repris`);
          if (r.qte > l.qte - (l.retourne || 0)) return err(`${l.nom} : ${l.qte - (l.retourne || 0)} au maximum à reprendre`);
          const montant = Math.round((l.total * r.qte) / l.qte);
          lignes.push({ ref: l.ref, nom: l.nom, artisanId: l.artisanId, artisanNom: l.artisanNom, qte: -r.qte, pu: l.pu, remise: null, total: -montant });
        }
        const total = lignes.reduce((t, l) => t + l.total, 0);
        const rembourse = ["avoir", "CB", "Espèces"].includes(body.remboursement) ? body.remboursement : "avoir";
        const date = new Date().toISOString();
        const numero = `${parisDate(date).replace(/-/g, "")}-${Date.parse(date).toString().slice(-5)}`;
        const paiement = { mode: rembourse === "avoir" ? "Avoir émis" : rembourse, recu: null };
        let bon = null;
        if (rembourse === "avoir") { bon = await creerBon("avoir", -total, numero); paiement.avoir = bon.code; }
        const parA = gerantR ? null : await artisanParInitiales(par);
        const gerantNom = gerantR ? "Gérance" : parA ? parA.nom : par;
        const v = { id: uid(), type: "retour", numero, date, lignes, total, paiement, origine: { mois: body.mois, id: o.id, numero: o.numero, lignes: choix }, vendeur: { initiales: "", nom: gerantNom }, motif, poste: dev.nom, annulee: false };
        await setJSON(`sales/${moisDe(date)}/${v.id}`, v);
        for (const r of choix) o.lignes[r.index].retourne = (o.lignes[r.index].retourne || 0) + r.qte;
        o.historique ||= []; o.historique.push({ date, action: `Retour (ticket ${numero}) : ${lignes.map((l) => -l.qte + " × " + l.nom).join(", ")}`, motif, par: gerantNom });
        await setJSON(key, o);
        for (const l of lignes) await majStock(l.ref, -l.qte);
        await journaliser({ type: "Retour client", ticket: o.numero, detail: lignes.map((l) => -l.qte + " × " + l.nom + " (" + l.artisanNom + ")").join(", ") + " – " + (rembourse === "avoir" ? "avoir " + bon.code : "remboursé en " + rembourse), montant: total, motif, par: gerantNom });
        return json({ ...v, bon });
      }
      const mBon = path.match(/^\/caisse\/bon\/([A-Za-z0-9-]+)$/);
      if (mBon && m === "GET") {
        const b = await getJSON(`bons/${mBon[1].toUpperCase()}`);
        if (!b || b.annule) return err("Bon introuvable");
        return json(b);
      }

      // ----- Tiroir-caisse : ouverture, sorties d'espèces, clôture (ticket Z) -----
      if (path === "/caisse/session" && m === "GET") {
        const jour = parisDate(new Date().toISOString());
        const s = await getSettings();
        const [ouverture, z, sorties] = await Promise.all([getJSON(`caisse/${jour}/ouverture`), getJSON(`caisse/${jour}/z`), listJSON(`caisse/${jour}/sorties/`)]);
        return json({ jour, fondReserve: s.fondReserve, ouverture, z, sorties });
      }
      if (path === "/caisse/ouverture" && m === "POST") {
        const jour = parisDate(new Date().toISOString());
        const s = await getSettings();
        const comptage = body.comptage || {};
        const total = totalComptage(comptage);
        const o = { jour, heure: new Date().toISOString(), vendeur: String(body.vendeur || "").trim(), comptage, total, ecart: total - s.fondReserve, poste: dev.nom };
        await setJSON(`caisse/${jour}/ouverture`, o);
        return json(o);
      }
      if (path === "/caisse/sortie" && m === "POST") {
        if (auth(req)?.role !== "admin") return err("Les sorties d'espèces sont réservées à la gérance", 403);
        const jour = parisDate(new Date().toISOString());
        const montant = toCents(body.montant);
        if (!(montant > 0) || !String(body.motif || "").trim()) return err("Montant et motif obligatoires");
        const so = { id: uid(), heure: new Date().toISOString(), montant, motif: String(body.motif).trim(), vendeur: String(body.vendeur || "").trim() };
        await setJSON(`caisse/${jour}/sorties/${so.id}`, so);
        return json(so);
      }
      if (path === "/caisse/fermeture" && m === "POST") {
        const jour = parisDate(new Date().toISOString());
        const z = await calculerZ(jour, body.comptage || {});
        z.vendeur = String(body.vendeur || "").trim();
        z.note = String(body.note || "").trim();
        z.poste = dev.nom;
        await setJSON(`caisse/${jour}/z`, z);
        return json(z);
      }
      if (path === "/caisse/z/apercu" && m === "POST") {
        return json(await calculerZ(parisDate(new Date().toISOString()), body.comptage || {}));
      }

      const gerant = auth(req)?.role === "admin";
      const mCa = path.match(/^\/caisse\/ventes\/(\d{4}-\d{2})\/([a-f0-9-]+)\/annuler$/);
      if (mCa && m === "POST") {
        const motif = String(body.motif || "").trim(), par = String(body.par || "").trim();
        if (!gerant && (!motif || !par)) return err("Justification et nom obligatoires pour annuler");
        return json(await annulerVente(mCa[1], mCa[2], { ligne: body.ligne, motif, par: gerant ? "Gérance" : par }));
      }
      if (path === "/caisse/journal" && m === "POST") {
        // suppression d'une ligne ou vidage du panier avant encaissement
        const motif = String(body.motif || "").trim(), par = String(body.par || "").trim();
        if (!gerant && (!motif || !par)) return err("Justification et nom obligatoires");
        return json(await journaliser({ type: body.type === "panier" ? "Panier vidé avant encaissement" : "Ligne supprimée avant encaissement", detail: String(body.detail || ""), montant: Math.round(Number(body.montant) || 0), motif, par: gerant ? "Gérance" : par, poste: dev.nom }));
      }
      if (path === "/caisse/planning" && m === "GET") return json(await planningMois(url.searchParams.get("mois") || parisDate(new Date().toISOString()).slice(0, 7)));
      if (path === "/caisse/planning" && m === "POST") {
        const a = await artisanParInitiales(body.initiales);
        if (!a) return err("Initiales inconnues");
        return json(await inscrire(String(body.date), String(body.creneau), a));
      }
      if (path === "/caisse/attente" && m === "GET") return json((await listJSON("attente/")).sort((a, b) => a.date.localeCompare(b.date)));
      if (path === "/caisse/attente" && m === "POST") {
        const t = { id: uid(), date: new Date().toISOString(), nom: String(body.nom || "").trim(), lignes: body.lignes || [], poste: dev.nom };
        await setJSON(`attente/${t.id}`, t);
        return json(t);
      }
      const mAt = path.match(/^\/caisse\/attente\/([a-f0-9-]+)$/);
      if (mAt && m === "DELETE") { await store().delete(`attente/${mAt[1]}`); return json({ ok: true }); }

      if (path === "/caisse/jour" && m === "GET") {
        const jour = url.searchParams.get("date") || parisDate(new Date().toISOString());
        const ventes = (await ventesEntre(jour, jour)).filter((v) => parisDate(v.date) === jour);
        const ok = ventes.filter((v) => !v.annulee);
        const parMode = {};
        Object.assign(parMode, cumulModes(ok));
        return json({ jour, ventes, total: ok.reduce((s, v) => s + caTicket(v), 0), nbVentes: ok.filter((v) => !estRetour(v)).length, parMode });
      }
      if (path === "/caisse/vendeur" && m === "GET") {
        const a = await artisanParInitiales(url.searchParams.get("initiales"));
        if (!a) return err("Initiales inconnues");
        return json({ initiales: a.initiales, nom: a.nom });
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
        dlc: /^\d{4}-\d{2}-\d{2}$/.test(body.dlc || "") ? body.dlc : "", seuil: body.seuil === "" || body.seuil == null ? null : Math.max(0, parseInt(body.seuil, 10) || 0),
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
        if (body.dlc !== undefined) p.dlc = /^\d{4}-\d{2}-\d{2}$/.test(body.dlc || "") ? body.dlc : "";
        if (body.seuil !== undefined) p.seuil = body.seuil === "" || body.seuil == null ? null : Math.max(0, parseInt(body.seuil, 10) || 0);
        await setJSON(`products/${p.ref}`, p);
        return json(p);
      }
      if (m === "DELETE") { p.actif = false; await setJSON(`products/${p.ref}`, p); return json({ ok: true }); }
    }

    // --- Planning des permanences ---
    if (path === "/planning" && m === "GET") return json(await planningMois(url.searchParams.get("mois") || parisDate(new Date().toISOString()).slice(0, 7)));
    if (path === "/planning" && m === "POST") {
      const a = isAdmin ? await artisanParInitiales(body.initiales) : await getJSON(`artisans/${user.id}`);
      if (!a) return err("Initiales inconnues");
      if (!isAdmin && String(body.date) < parisDate(new Date().toISOString())) return err("Ce jour est passé");
      return json(await inscrire(String(body.date), String(body.creneau), a));
    }
    if (path === "/planning" && m === "DELETE") {
      const date = url.searchParams.get("date"), creneau = url.searchParams.get("creneau");
      const artisanId = isAdmin ? url.searchParams.get("artisanId") : user.id;
      if (!isAdmin && date <= parisDate(new Date().toISOString())) return err("Vous ne pouvez plus vous désinscrire de ce créneau : prévenez la gérance");
      await store().delete(`planning/${date.slice(0, 7)}/${date}/${creneau}/${artisanId}`);
      return json({ ok: true });
    }
    if (path === "/planning/absence" && m === "POST") {
      if (!isAdmin) return err("Réservé à la gérance", 403);
      const key = `planning/${String(body.date).slice(0, 7)}/${body.date}/${body.creneau}/${body.artisanId}`;
      const e = await getJSON(key);
      if (!e) return err("Inscription introuvable");
      if (e.absent) return json(e);
      e.absent = true;
      await setJSON(key, e);
      const art = await getJSON(`artisans/${e.artisanId}`);
      if (art && art.formule !== "sans accueil") {
        const [y, mo] = e.date.split("-").map(Number);
        art.formule = "sans accueil";
        art.formuleDepuis = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, "0")}-01`;
        await setJSON(`artisans/${art.id}`, art);
        await journaliser({ type: "Passage en formule sans participation à l'accueil", detail: `${art.nom} – créneau du ${e.date} non assuré, à partir du ${art.formuleDepuis}`, montant: settings.supplementSansAccueil, motif: "", par: "Gérance" });
      }
      return json(e);
    }
    if (path === "/penalites" && m === "GET") {
      const mois = url.searchParams.get("mois") || parisDate(new Date().toISOString()).slice(0, 7);
      const all = await listJSON(`penalites/${mois}/`);
      return json(isAdmin ? all : all.filter((x) => x.artisanId === user.id));
    }

    // --- Relevé mensuel et facture de commission ---
    if (path === "/releve" && m === "GET") {
      const mois = url.searchParams.get("mois") || parisDate(new Date().toISOString()).slice(0, 7);
      const artisanId = isAdmin ? url.searchParams.get("artisanId") : user.id;
      return json(await releve(mois, artisanId));
    }

    // --- Export comptable ---
    if (path === "/export" && m === "GET") {
      if (!isAdmin) return err("Réservé à la gérance", 403);
      return json(await ventesEntre(url.searchParams.get("du"), url.searchParams.get("au")));
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
        out[k] = { ...r, magasin: res.total, tickets: vs.filter((v) => !v.annulee && !estRetour(v)).length, moi: isAdmin ? null : mine };
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
      return json({ du, au, commissionTaux: settings.commission, totalMagasin: res.total, moi: mine, lignes, topArticles: Object.values(parArticle).sort((a, b) => b.ca - a.ca).slice(0, 10), topArticlesQte: Object.values(parArticle).sort((a, b) => b.qte - a.qte).slice(0, 10) });
    }

    // --- Alertes stock et DLC ---
    if (path === "/alertes" && m === "GET") {
      const prods = (await listJSON("products/")).filter((p) => p.actif !== false && (isAdmin || p.artisanId === user.id));
      const noms = isAdmin ? Object.fromEntries((await listJSON("artisans/")).map((a) => [a.id, a.nom])) : {};
      return json(alertesProduits(prods, parisDate(new Date().toISOString())).map((x) => ({ ...x, artisanNom: noms[x.artisanId] || "" })));
    }

    // --- Inventaire (comptage du stock, écarts = démarque) ---
    if (path === "/inventaire" && m === "POST") {
      const artisanId = isAdmin ? body.artisanId : user.id;
      const a = await getJSON(`artisans/${artisanId}`);
      if (!a) return err("Artisan introuvable");
      const lignes = [];
      for (const r of body.lignes || []) {
        if (r.compte === "" || r.compte == null) continue;
        const p = await getJSON(`products/${r.ref}`);
        if (!p || p.artisanId !== artisanId) continue;
        const compte = Math.max(0, parseInt(r.compte, 10) || 0);
        const theorique = typeof p.stock === "number" ? p.stock : null;
        const ecart = theorique === null ? 0 : compte - theorique;
        lignes.push({ ref: p.ref, nom: p.nom, prix: p.prix, theorique, compte, ecart, valeurEcart: ecart * p.prix });
        p.stock = compte; await setJSON(`products/${p.ref}`, p);
      }
      if (!lignes.length) return err("Saisissez au moins une quantité comptée");
      const inv = { id: uid(), date: new Date().toISOString(), artisanId, artisanNom: a.nom, par: isAdmin ? "Gérance" : a.nom, lignes,
        manquants: lignes.reduce((t, l) => t + (l.ecart < 0 ? -l.ecart : 0), 0), demarque: lignes.reduce((t, l) => t + (l.ecart < 0 ? -l.valeurEcart : 0), 0) };
      await setJSON(`inventaires/${inv.id}`, inv);
      return json(inv);
    }
    if (path === "/inventaires" && m === "GET") {
      const all = await listJSON("inventaires/");
      return json(all.filter((i) => isAdmin || i.artisanId === user.id).sort((x, y) => y.date.localeCompare(x.date)));
    }

    // ---------- Administration (gérance uniquement) ----------
    if (!isAdmin) return err("Réservé à la gérance", 403);

    // --- Loyers payés d'avance et reversements ---
    if (path === "/loyers" && m === "GET") {
      const [arts, paies] = await Promise.all([listJSON("artisans/"), listJSON("loyers/")]);
      return json(arts.filter((a) => a.actif).map((a) => {
        const p = paies.filter((x) => x.artisanId === a.id).sort((x, y) => x.du.localeCompare(y.du));
        const couvert = p.reduce((mx, x) => (x.au > mx ? x.au : mx), "");
        return { artisanId: a.id, nom: a.nom, initiales: a.initiales, stand: a.stand, formule: a.formule, dateDebut: a.dateDebut, loyer: a.stand === "2 m" ? settings.prixStand2 : settings.prixStand1, paiements: p, couvertJusquau: couvert };
      }).sort((x, y) => x.nom.localeCompare(y.nom, "fr")));
    }
    if (path === "/loyers" && m === "POST") {
      const a = await getJSON(`artisans/${body.artisanId}`);
      if (!a) return err("Artisan introuvable");
      const montant = toCents(body.montant);
      if (!(montant > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(body.du || "") || !/^\d{4}-\d{2}-\d{2}$/.test(body.au || "") || body.au < body.du) return err("Montant et période (du / au) obligatoires");
      const x = { id: uid(), artisanId: a.id, montant, du: body.du, au: body.au, mode: String(body.mode || "Virement"), note: String(body.note || "").trim(), le: new Date().toISOString() };
      await setJSON(`loyers/${a.id}/${x.id}`, x);
      return json(x);
    }
    const mLoy = path.match(/^\/loyers\/([a-f0-9-]+)\/([a-f0-9-]+)$/);
    if (mLoy && m === "DELETE") { await store().delete(`loyers/${mLoy[1]}/${mLoy[2]}`); return json({ ok: true }); }
    if (path === "/reversements" && m === "GET") {
      const mois = url.searchParams.get("mois") || parisDate(new Date().toISOString()).slice(0, 7);
      const arts = (await listJSON("artisans/")).filter((a) => a.actif || (a.dateDebut || "") <= mois);
      const faits = Object.fromEntries((await listJSON(`reversements/${mois}/`)).map((r) => [r.artisanId, r]));
      const out = [];
      for (const a of arts) { const c = await calculMois(mois, a, settings); out.push({ artisanId: a.id, nom: a.nom, initiales: a.initiales, ca: c.ca, commission: c.commission, supplement: c.supplement, report: c.report, aReverser: c.solde, fait: faits[a.id] || null }); }
      return json(out.sort((x, y) => x.nom.localeCompare(y.nom, "fr")));
    }
    if (path === "/reversements" && m === "POST") {
      const mois = String(body.mois || "");
      if (!/^\d{4}-\d{2}$/.test(mois)) return err("Mois incorrect");
      const key = `reversements/${mois}/${body.artisanId}`;
      if (body.annuler) { await store().delete(key); return json({ ok: true }); }
      const r = { mois, artisanId: body.artisanId, montant: toCents(body.montant || 0), date: /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : parisDate(new Date().toISOString()), note: String(body.note || "").trim() };
      await setJSON(key, r);
      return json(r);
    }
    if (path === "/bons" && m === "GET") {
      return json((await listJSON("bons/")).sort((x, y) => y.creeLe.localeCompare(x.creeLe)));
    }

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
      const categorie = String(body.categorie || "").trim();
      const memeCat = categorie ? arts.filter((a) => a.actif && (a.categorie || "").toLowerCase() === categorie.toLowerCase()).length : 0;
      if (memeCat >= 4 && !body.forcer) return err(`Il y a déjà ${memeCat} artisans dans la catégorie « ${categorie} » (4 maximum prévus au contrat)`);
      const a = {
        id: uid(), nom, initiales, identifiant, pw: hashPw(body.motdepasse),
        metier: String(body.metier || "").trim(), categorie, telephone: String(body.telephone || "").trim(), email: String(body.email || "").trim(),
        stand: String(body.stand || "1 m"), formule: body.formule === "sans accueil" ? "sans accueil" : "avec accueil", dateDebut: String(body.dateDebut || "").slice(0, 10), actif: true, nextRef: 1, creeLe: new Date().toISOString(),
      };
      await setJSON(`artisans/${a.id}`, a);
      return json(publicArtisan(a));
    }
    const mArt = path.match(/^\/artisans\/([a-f0-9-]+)$/);
    if (mArt && m === "PUT") {
      const a = await getJSON(`artisans/${mArt[1]}`);
      if (!a) return err("Artisan introuvable", 404);
      for (const k of ["nom", "metier", "categorie", "telephone", "email", "stand", "dateDebut", "formule", "formuleDepuis"]) if (body[k] != null) a[k] = String(body[k]).trim();
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
      return json(await annulerVente(mVente[1], mVente[2], { ligne: body.ligne, motif: String(body.motif || "").trim(), par: "Gérance" }));
    }
    const mMod = path.match(/^\/ventes\/(\d{4}-\d{2})\/([a-f0-9-]+)$/);
    if (mMod && m === "PUT") {
      const key = `sales/${mMod[1]}/${mMod[2]}`;
      const v = await getJSON(key);
      if (!v) return err("Vente introuvable", 404);
      if (v.annulee) return err("Ce ticket est annulé");
      const avant = { lignes: v.lignes, total: v.total, paiement: v.paiement };
      const arts = Object.fromEntries((await listJSON("artisans/")).map((a) => [a.id, a]));
      const nouvelles = [];
      for (const l of body.lignes || []) {
        const qte = Math.max(0, parseInt(l.qte, 10) || 0);
        if (!qte) continue;
        const exist = v.lignes.find((x) => x.ref === l.ref);
        const p = exist ? null : await getProduit(l.ref);
        if (!exist && !p) return err(`Article inconnu : ${l.ref}`);
        const pu = l.pu != null && l.pu !== "" ? toCents(l.pu) : exist ? exist.pu : p.prix;
        const base = exist || { ref: p.ref, nom: p.nom, artisanId: p.artisanId, artisanNom: p.artisanId === "boutique" ? "Boutique" : arts[p.artisanId]?.nom || "" };
        nouvelles.push({ ...base, qte, pu, total: pu * qte });
      }
      if (!nouvelles.length) return err("Le ticket doit garder au moins un article (sinon, annulez-le)");
      // stock : différence entre avant et après
      const q = (arr) => arr.reduce((m2, l) => ((m2[l.ref] = (m2[l.ref] || 0) + l.qte), m2), {});
      const qa = q(v.lignes), qn = q(nouvelles);
      for (const ref of new Set([...Object.keys(qa), ...Object.keys(qn)])) { const d = (qa[ref] || 0) - (qn[ref] || 0); if (d) await majStock(ref, d); }
      v.lignes = nouvelles;
      v.total = nouvelles.reduce((t, l) => t + l.total, 0);
      if (body.mode && body.mode !== "Mixte") v.paiement = { mode: body.mode, recu: null };
      else if (v.paiement.mode === "Mixte") v.paiement.cb = Math.max(0, v.total - (v.paiement.especes || 0)), v.paiement.especes = v.total - v.paiement.cb;
      v.historique ||= [];
      v.historique.push({ date: new Date().toISOString(), action: `Ticket modifié (${(avant.total / 100).toFixed(2)} € → ${(v.total / 100).toFixed(2)} €)`, motif: String(body.motif || "").trim(), par: "Gérance", avant });
      await setJSON(key, v);
      await journaliser({ type: "Modification de ticket", ticket: v.numero, montant: v.total - avant.total, motif: String(body.motif || "").trim(), par: "Gérance" });
      return json(v);
    }
    if (path === "/journal" && m === "GET") {
      const mois = url.searchParams.get("mois") || new Date().toISOString().slice(0, 7);
      return json((await listJSON(`journal/${mois}/`)).sort((a, b) => b.date.localeCompare(a.date)));
    }

    if (path === "/z" && m === "GET") {
      const mois = url.searchParams.get("mois") || new Date().toISOString().slice(0, 7);
      const { blobs } = await store().list({ prefix: "caisse/" + mois });
      const zs = (await Promise.all(blobs.filter((b) => b.key.endsWith("/z")).map((b) => getJSON(b.key)))).filter(Boolean);
      return json(zs.sort((a, b) => b.jour.localeCompare(a.jour)));
    }
    if (path === "/settings" && m === "GET") return json(settings);
    if (path === "/settings" && m === "PUT") {
      const s = { ...settings };
      if (body.nomBoutique != null) s.nomBoutique = String(body.nomBoutique).trim();
      if (body.adresse != null) s.adresse = String(body.adresse).trim();
      if (body.commission != null) s.commission = Math.min(100, Math.max(0, Number(body.commission) || 0));
      if (body.fondReserve != null && body.fondReserve !== "") s.fondReserve = Math.max(0, toCents(body.fondReserve));
      for (const k of ["siret", "mentionTVA"]) if (body[k] != null) s[k] = String(body[k]).trim();
      for (const k of ["prixStand1", "prixStand2", "supplementSansAccueil"]) if (body[k] != null && body[k] !== "") s[k] = Math.max(0, toCents(body[k]));
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
    if (e instanceof UErr) return err(e.message, 400);
    console.error(e);
    return err("Erreur serveur : " + e.message, 500);
  }
};

export const config = { path: "/api/*" };
