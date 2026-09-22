#!/usr/bin/env node
/**
 * Recherche les nouvelles actualités réglementaires via l'API Anthropic
 * (avec recherche web), les valide, et les insère dans index.html.
 *
 * Ne dépend d'aucun paquet npm. Node 20+ (fetch natif).
 *
 * Sorties :
 *   - index.html modifié
 *   - data/veille-state.json (date de dernière mise à jour)
 *   - veille-rapport.md (résumé lisible)
 *   - veille-brut.json (réponse brute du modèle, pour audit)
 *   - .github/pr-body.md (corps de la pull request)
 *   - GITHUB_OUTPUT : added, period
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const HTML_PATH = path.join(ROOT, 'index.html');
const STATE_PATH = path.join(ROOT, 'data', 'veille-state.json');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const MAX_ITEMS = Math.min(parseInt(process.env.MAX_ITEMS || '10', 10) || 10, 25);

/* ------------------------------------------------------------------ Rubriques */

const SUBSECTIONS = {
  'ia-calendrier':      { section: 'ia',        label: "Calendrier et champ d'application de l'AI Act" },
  'ia-doctrine':        { section: 'ia',        label: "Doctrine des régulateurs de données sur l'IA" },
  'cyber-cra':          { section: 'cyber',     label: 'Cyber Resilience Act' },
  'cyber-nis2':         { section: 'cyber',     label: 'NIS2 et transposition française' },
  'cyber-souverainete': { section: 'cyber',     label: 'Souveraineté, certification et capacités européennes' },
  'sanctions-rgpd':     { section: 'sanctions', label: 'Sanctions des autorités de protection des données' },
  'sanctions-incidents':{ section: 'sanctions', label: 'Incidents et violations de données' },
  'sanctions-juris':    { section: 'sanctions', label: 'Jurisprudence' },
  'doc-cepd':           { section: 'doctrine',  label: 'Lignes directrices du CEPD' },
  'doc-cnil':           { section: 'doctrine',  label: 'Publications opérationnelles de la CNIL' },
};

const CONF_LABEL = { confirme: 'Confirmé', nuance: 'Nuancé', rapporte: 'Rapporté' };

const SOURCES_PRIORITAIRES = `
Europe : ENISA (enisa.europa.eu), EUR-Lex (eur-lex.europa.eu), Commission européenne Cybersecurity
(digital-strategy.ec.europa.eu/fr/policies/cybersecurity), CEPD/EDPB (edpb.europa.eu),
European Data (data.europa.eu), Medical Device Coordination Group (health.ec.europa.eu).
France : ANSSI (cyber.gouv.fr), CNIL (cnil.fr/fr/actualites), Légifrance (legifrance.gouv.fr),
data.gouv.fr, Agence du numérique en santé (esante.gouv.fr), Les Echos, AFP, Pharmaceutiques,
Intrinsec Threat Landscape.
Autres pays européens : BSI (Allemagne), BMI (Autriche), CCB (Belgique), Samsik (Danemark),
CCN-CERT (Espagne), Traficom (Finlande), cyber.gov.gr (Grèce), SZTFH (Hongrie), ACN (Italie),
NSM (Norvège), NCSC (Pays-Bas), cyber.gov.pl (Pologne), CNCS (Portugal), NÚKIB (Tchéquie),
NCSC (Royaume-Uni), MSB (Suède), OFCS (Suisse).
US : Health-ISAC, FDA (cybersécurité des dispositifs médicaux).
International : IAPP, Data Guidance.
`.trim();

/* ------------------------------------------------------------------- Utilitaires */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

function setOutput(key, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) fs.appendFileSync(f, `${key}=${value}\n`);
  console.log(`[output] ${key}=${value}`);
}

function frDate(d) {
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* ------------------------------------------------ Lecture de l'existant */

if (!fs.existsSync(HTML_PATH)) fail(`index.html introuvable à la racine du dépôt (${HTML_PATH}).`);
let html = fs.readFileSync(HTML_PATH, 'utf8');

const existingIds = new Set(
  [...html.matchAll(/<article class="card" id="([^"]+)"/g)].map((m) => m[1])
);
const existingTags = new Set();
for (const m of html.matchAll(/data-tags="([^"]*)"/g)) {
  for (const t of m[1].split('|')) {
    const clean = t.trim()
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (clean) existingTags.add(clean);
  }
}
const existingTitles = [...html.matchAll(/<span class="card-title">([^<]*)<\/span>/g)].map((m) => m[1]);

if (existingIds.size === 0) fail("Aucune carte trouvée dans index.html — le fichier n'a pas la structure attendue.");

/* -------------------------------------------------------------------- État */

let state = { lastUpdate: null, history: [] };
if (fs.existsSync(STATE_PATH)) {
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { console.log('État illisible, réinitialisation.'); }
}

const today = new Date();
let since = process.env.SINCE?.trim() || state.lastUpdate;
if (!since) {
  const d = new Date(today);
  d.setDate(d.getDate() - 30);
  since = d.toISOString().slice(0, 10);
  console.log(`Aucune date de référence : recherche sur les 30 derniers jours (depuis ${since}).`);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) fail(`Date de départ invalide : "${since}". Format attendu : AAAA-MM-JJ.`);

const todayISO = today.toISOString().slice(0, 10);
const period = `${since} → ${todayISO}`;
console.log(`Période analysée : ${period}`);

/* ------------------------------------------------------------------ Prompt */

const systemPrompt = `Tu es analyste en veille réglementaire cybersécurité et protection des données. Tu produis des fiches factuelles, sourcées et vérifiables, en français.

RÈGLE ABSOLUE : tu n'inventes jamais une source, une URL, une date, un montant ou un numéro d'affaire. Si tu ne peux pas vérifier un élément par une recherche web, tu ne l'écris pas. Une fiche sans source vérifiée n'est pas produite. Il vaut infiniment mieux renvoyer zéro actualité qu'une actualité inventée.

Tu ne cites que des URL que tes recherches web ont effectivement retournées.`;

const userPrompt = `Recherche les actualités réglementaires publiées entre le ${since} et le ${todayISO} dans le périmètre suivant.

PÉRIMÈTRE
Réglementation cybersécurité et intelligence artificielle applicable en France et dans l'Union européenne : RGPD, AI Act, NIS2, DORA, CRA, Cybersecurity Act, référentiels ANSSI et CNIL, doctrine du CEPD, jurisprudence de la CJUE. International seulement si impact direct sur la France.

SOURCES À CONSULTER EN PRIORITÉ
${SOURCES_PRIORITAIRES}

CE QUI EST DÉJÀ COUVERT — ne le reproduis pas
Identifiants déjà utilisés : ${[...existingIds].join(', ')}
Titres déjà présents :
${existingTitles.map((t) => `- ${t}`).join('\n')}

MOTS-CLÉS DÉJÀ EN USAGE — réutilise-les à l'identique plutôt que d'en créer des variantes
${[...existingTags].sort().join(', ')}

SOUS-RUBRIQUES DISPONIBLES (champ "sub")
${Object.entries(SUBSECTIONS).map(([k, v]) => `- ${k} (rubrique ${v.section}) : ${v.label}`).join('\n')}

GRILLE DE CONFIANCE (champ "conf")
- "confirme" : recoupé par au moins une source primaire (texte officiel, communiqué de régulateur) ou deux sources secondaires indépendantes
- "nuance" : fait établi, mais chiffres, périmètre, datation ou formulation à relativiser — le corps de la fiche doit dire explicitement ce qui est incertain
- "rapporte" : rapporté par la presse, sans confirmation officielle des parties à ce jour

CONSIGNES DE RÉDACTION
- La date affichée est celle de l'acte lui-même (délibération, adoption, publication, entrée en application), pas celle de sa reprise par la presse. Si les deux diffèrent nettement, dis-le dans le corps.
- Si deux sources donnent des dates divergentes, signale la divergence dans le corps plutôt que de trancher en silence.
- Privilégie les sources primaires. Presse spécialisée en complément.
- Français, factuel, sans avis personnel, dates précises et chiffres sourcés.
- Entre 2 et 6 paragraphes par fiche, chacun apportant une information distincte.
- Maximum ${MAX_ITEMS} actualités. Sélectionne celles qui ont un effet opérationnel identifiable : une échéance, une obligation nouvelle, une grille d'analyse réutilisable, une sanction dont le raisonnement fait précédent.

FORMAT DE RÉPONSE
Réponds uniquement par un bloc de code JSON, sans texte avant ni après :

\`\`\`json
{
  "items": [
    {
      "id": "identifiant-en-minuscules-avec-tirets",
      "sub": "sanctions-rgpd",
      "conf": "confirme",
      "title": "Titre de l'actualité",
      "hook": "Phrase de résumé, une à deux lignes, avec la date et le fait principal.",
      "date": "12 octobre 2026",
      "body": ["Premier paragraphe.", "Deuxième paragraphe."],
      "tags": ["CNIL", "RGPD"],
      "sources": [
        { "title": "CNIL — « Titre exact de la page »", "url": "https://www.cnil.fr/...", "date": "12 octobre 2026" }
      ]
    }
  ],
  "notes": "Remarques éventuelles sur la période, les pistes écartées ou les incertitudes."
}
\`\`\`

Si aucune actualité pertinente n'a été trouvée sur la période, renvoie {"items": [], "notes": "..."}.`;

/* --------------------------------------------------------------- Appel API */

async function callAnthropic() {
  const body = {
    model: MODEL,
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 30 }],
  };

  const MAX_RETRY = 3;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (res.ok) return res.json();

    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    console.error(`Appel API en échec (HTTP ${res.status}) : ${text.slice(0, 500)}`);
    if (!retryable || attempt === MAX_RETRY) {
      fail(`L'API Anthropic a répondu HTTP ${res.status}. Vérifie la clé, le crédit disponible et l'identifiant du modèle ("${MODEL}").`);
    }
    const wait = 5000 * attempt;
    console.log(`Nouvelle tentative dans ${wait / 1000} s (${attempt}/${MAX_RETRY - 1})…`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

if (!API_KEY) fail('ANTHROPIC_API_KEY absent de l\'environnement.');

const response = await callAnthropic();
const rawText = (response.content || [])
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('\n');

fs.writeFileSync(path.join(ROOT, 'veille-brut.json'), JSON.stringify(response, null, 2));

const usage = response.usage || {};
const searches = usage.server_tool_use?.web_search_requests ?? 'n/c';
console.log(`Jetons : ${usage.input_tokens ?? '?'} en entrée, ${usage.output_tokens ?? '?'} en sortie. Recherches web : ${searches}.`);

/* ------------------------------------------------------------- Extraction JSON */

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* on tente autrement */ }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* idem */ }
  }
  return null;
}

const parsed = extractJson(rawText);
if (!parsed || !Array.isArray(parsed.items)) {
  console.error('Réponse brute du modèle :\n' + rawText.slice(0, 3000));
  fail("Le modèle n'a pas renvoyé de JSON exploitable. La réponse brute est dans l'artefact veille-brut.json.");
}

/* ----------------------------------------------------------------- Validation */

const rejected = [];
const seenThisRun = new Set();

function validate(item, index) {
  const ref = item?.id || item?.title || `#${index + 1}`;
  const bad = (reason) => { rejected.push({ ref, reason }); return false; };

  if (!item || typeof item !== 'object') return bad('entrée non exploitable');
  if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(item.id))
    return bad(`identifiant invalide ("${item.id}") — minuscules, chiffres et tirets uniquement`);
  if (existingIds.has(item.id)) return bad(`identifiant déjà présent dans le site ("${item.id}")`);
  if (seenThisRun.has(item.id)) return bad(`identifiant en doublon dans cette exécution ("${item.id}")`);
  if (!SUBSECTIONS[item.sub]) return bad(`sous-rubrique inconnue ("${item.sub}")`);
  if (!CONF_LABEL[item.conf]) return bad(`niveau de confiance invalide ("${item.conf}")`);
  if (typeof item.title !== 'string' || item.title.trim().length < 10) return bad('titre absent ou trop court');
  if (typeof item.hook !== 'string' || item.hook.trim().length < 20) return bad('accroche absente ou trop courte');
  if (typeof item.date !== 'string' || !item.date.trim()) return bad('date absente');
  if (!Array.isArray(item.body) || item.body.length < 1 || item.body.some((p) => typeof p !== 'string' || p.trim().length < 20))
    return bad('corps de fiche absent ou paragraphes trop courts');
  if (!Array.isArray(item.tags) || item.tags.length < 1 || item.tags.length > 8 || item.tags.some((t) => typeof t !== 'string' || !t.trim()))
    return bad('mots-clés absents ou en nombre invalide (1 à 8 attendus)');
  if (!Array.isArray(item.sources) || item.sources.length < 1) return bad('aucune source — fiche écartée');

  for (const s of item.sources) {
    if (!s || typeof s.url !== 'string') return bad('source sans URL');
    let u;
    try { u = new URL(s.url); } catch { return bad(`URL malformée : ${s.url}`); }
    if (u.protocol !== 'https:') return bad(`URL non HTTPS : ${s.url}`);
    if (typeof s.title !== 'string' || s.title.trim().length < 5) return bad(`source sans intitulé : ${s.url}`);
  }

  seenThisRun.add(item.id);
  return true;
}

const items = parsed.items.filter(validate);

// Un mot-clé inédit n'est pas une erreur, mais mérite un signalement dans la PR.
const newTags = new Set();
for (const it of items) {
  for (const t of it.tags) if (!existingTags.has(t.trim())) newTags.add(t.trim());
}

/* ------------------------------------------------------------------ Rendu HTML */

function renderCard(item) {
  const section = SUBSECTIONS[item.sub].section;
  const tagsAttr = item.tags.map((t) => t.trim()).join('|');
  const body = item.body.map((p) => `          <p>${esc(p)}</p>`).join('\n');
  const tagChips = item.tags
    .map((t) => `            <li><button type="button" class="tag" data-tag="${esc(t.trim())}">${esc(t.trim())}</button></li>`)
    .join('\n');
  const sources = item.sources
    .map((s) => `              <li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>` +
                (s.date ? ` <span class="src-date">— ${esc(s.date)}</span>` : '') + `</li>`)
    .join('\n');

  return `      <article class="card" id="${esc(item.id)}" data-conf="${item.conf}" data-section="${section}" data-tags="${esc(tagsAttr)}">
        <button type="button" class="card-head" aria-expanded="false" aria-controls="${esc(item.id)}-body">
          <span class="card-headline">
            <span class="card-title">${esc(item.title)}</span>
            <span class="card-hook">${esc(item.hook)}</span>
          </span>
          <span class="card-meta">
            <span class="card-date">${esc(item.date)}</span>
            <span class="badge badge-${item.conf}">${CONF_LABEL[item.conf]}</span>
            <span class="chevron" aria-hidden="true"></span>
          </span>
        </button>
        <div class="card-body" id="${esc(item.id)}-body" hidden>
${body}
          <ul class="tags">
${tagChips}
          </ul>
          <div class="sources">
            <p class="sources-title">Sources</p>
            <ol>
${sources}
            </ol>
          </div>
          <div class="card-actions">
            <button type="button" class="btn btn-copy" data-copy>Copier pour Teams</button>
          </div>
        </div>
      </article>
`;
}

/** Insère le bloc en tête de la liste de cartes de la sous-rubrique visée. */
function insertIntoSubsection(source, subId, cardHtml) {
  const subIdx = source.indexOf(`<div class="subsection" id="${subId}"`);
  if (subIdx === -1) throw new Error(`Sous-rubrique "${subId}" introuvable dans index.html`);
  const cardsIdx = source.indexOf('<div class="cards">', subIdx);
  if (cardsIdx === -1) throw new Error(`Conteneur .cards introuvable pour la sous-rubrique "${subId}"`);
  const insertAt = cardsIdx + '<div class="cards">'.length;
  return source.slice(0, insertAt) + '\n' + cardHtml + source.slice(insertAt);
}

for (const item of items) {
  try {
    html = insertIntoSubsection(html, item.sub, renderCard(item));
    console.log(`Inséré : ${item.id} → ${item.sub}`);
  } catch (e) {
    rejected.push({ ref: item.id, reason: e.message });
  }
}

const inserted = items.filter((i) => !rejected.some((r) => r.ref === i.id));

/* ------------------------------------------------- Date du pied de page */

if (inserted.length > 0) {
  const before = html;
  html = html.replace(/(· généré le )([^<]*)/, `$1${frDate(today)}`);
  if (html === before) console.log('::warning::Date du pied de page non trouvée, elle reste inchangée.');
}

/* --------------------------------------------------------------- Écriture */

const report = [];
report.push(`# Veille — exécution du ${frDate(today)}`);
report.push('');
report.push(`**Période analysée** : ${since} → ${todayISO}`);
report.push(`**Modèle** : \`${MODEL}\``);
report.push(`**Recherches web** : ${searches}`);
report.push(`**Actualités retenues** : ${inserted.length} / ${parsed.items.length} proposées`);
report.push('');

if (inserted.length) {
  report.push('## Actualités ajoutées');
  report.push('');
  report.push('| Confiance | Sous-rubrique | Date | Titre | Sources |');
  report.push('|---|---|---|---|---|');
  for (const i of inserted) {
    const links = i.sources.map((s, n) => `[${n + 1}](${s.url})`).join(' ');
    report.push(`| ${CONF_LABEL[i.conf]} | \`${i.sub}\` | ${i.date} | ${i.title.replace(/\|/g, '\\|')} | ${links} |`);
  }
  report.push('');

  const aRelire = inserted.filter((i) => i.conf !== 'confirme');
  if (aRelire.length) {
    report.push('## À relire en priorité');
    report.push('');
    for (const i of aRelire) report.push(`- **${CONF_LABEL[i.conf]}** — ${i.title}`);
    report.push('');
  }
}

if (newTags.size) {
  report.push('## Mots-clés inédits introduits');
  report.push('');
  report.push(`${[...newTags].map((t) => `\`${t}\``).join(', ')}`);
  report.push('');
  report.push("Vérifie qu'il ne s'agit pas de variantes de mots-clés existants (« Cnil » vs « CNIL »).");
  report.push('');
}

if (rejected.length) {
  report.push('## Propositions écartées par la validation');
  report.push('');
  for (const r of rejected) report.push(`- \`${r.ref}\` — ${r.reason}`);
  report.push('');
}

if (parsed.notes) {
  report.push('## Notes du modèle');
  report.push('');
  report.push(String(parsed.notes));
  report.push('');
}

report.push('---');
report.push('');
report.push('> Contenu produit automatiquement. **Chaque lien doit être ouvert et chaque date vérifiée avant fusion.**');

const reportText = report.join('\n');
fs.writeFileSync(path.join(ROOT, 'veille-rapport.md'), reportText);

if (inserted.length > 0) {
  fs.writeFileSync(HTML_PATH, html);

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  state.lastUpdate = todayISO;
  state.history = [
    { date: todayISO, added: inserted.length, period, ids: inserted.map((i) => i.id) },
    ...(state.history || []),
  ].slice(0, 50);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

  fs.mkdirSync(path.join(ROOT, '.github'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.github', 'pr-body.md'), reportText);
}

console.log('\n' + reportText);

setOutput('added', String(inserted.length));
setOutput('period', period);

if (inserted.length === 0) {
  console.log('Aucune actualité retenue : index.html est laissé inchangé, aucune pull request ne sera ouverte.');
}
