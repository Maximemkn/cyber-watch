#!/usr/bin/env node
/**
 * Contrôle d'intégrité de index.html après insertion automatique.
 * Échoue le job si le fichier est cassé — mieux vaut pas de pull request
 * qu'une pull request qui casse le site.
 */

import fs from 'node:fs';
import path from 'node:path';

const HTML = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const errors = [];
const warnings = [];

/* 1. Identifiants de cartes uniques */
const ids = [...HTML.matchAll(/<article class="card" id="([^"]+)"/g)].map((m) => m[1]);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) errors.push(`Identifiants de cartes en doublon : ${[...new Set(dupes)].join(', ')}`);

/* 2. Équilibre des balises <article> */
const open = (HTML.match(/<article\b/g) || []).length;
const close = (HTML.match(/<\/article>/g) || []).length;
if (open !== close) errors.push(`Balises <article> déséquilibrées : ${open} ouvertes, ${close} fermées`);

/* 3. Équilibre global des <div> */
const divOpen = (HTML.match(/<div\b/g) || []).length;
const divClose = (HTML.match(/<\/div>/g) || []).length;
if (divOpen !== divClose) errors.push(`Balises <div> déséquilibrées : ${divOpen} ouvertes, ${divClose} fermées`);

/* 4. Chaque carte : aria-controls pointe bien sur l'id de son corps */
for (const m of HTML.matchAll(/<article class="card" id="([^"]+)"[\s\S]*?aria-controls="([^"]+)"[\s\S]*?<div class="card-body" id="([^"]+)"/g)) {
  const [, id, controls, bodyId] = m;
  if (controls !== bodyId) errors.push(`Carte "${id}" : aria-controls="${controls}" ne correspond pas au corps id="${bodyId}"`);
  if (bodyId !== `${id}-body`) warnings.push(`Carte "${id}" : le corps devrait avoir l'id "${id}-body"`);
}

/* 5. Cohérence entre data-conf et le libellé du badge */
const CONF = { confirme: 'Confirmé', nuance: 'Nuancé', rapporte: 'Rapporté' };
for (const m of HTML.matchAll(/<article class="card" id="([^"]+)" data-conf="([^"]+)"[\s\S]*?<span class="badge badge-([a-z]+)">([^<]+)<\/span>/g)) {
  const [, id, conf, badgeClass, badgeText] = m;
  if (!CONF[conf]) errors.push(`Carte "${id}" : data-conf="${conf}" invalide`);
  if (conf !== badgeClass) errors.push(`Carte "${id}" : data-conf="${conf}" mais badge "badge-${badgeClass}"`);
  if (CONF[conf] && badgeText.trim() !== CONF[conf]) errors.push(`Carte "${id}" : badge affiche "${badgeText.trim()}" au lieu de "${CONF[conf]}"`);
}

/* 6. data-section de la carte cohérent avec la rubrique qui la contient */
for (const secMatch of HTML.matchAll(/<section class="section" id="([^"]+)" data-section="([^"]+)"([\s\S]*?)<\/section>/g)) {
  const [, , secId, inner] = secMatch;
  for (const card of inner.matchAll(/<article class="card" id="([^"]+)" data-conf="[^"]*" data-section="([^"]+)"/g)) {
    if (card[2] !== secId) errors.push(`Carte "${card[1]}" : data-section="${card[2]}" mais placée dans la rubrique "${secId}"`);
  }
}

/* 7. Cohérence data-tags / chips affichés */
for (const m of HTML.matchAll(/<article class="card" id="([^"]+)"[^>]*data-tags="([^"]*)"([\s\S]*?)<\/article>/g)) {
  const [, id, tagsAttr, inner] = m;
  const declared = tagsAttr.split('|').map((t) => t.trim()).filter(Boolean);
  const shown = [...inner.matchAll(/<button type="button" class="tag" data-tag="([^"]*)">/g)].map((x) => x[1].trim());
  const missing = declared.filter((t) => !shown.includes(t));
  const extra = shown.filter((t) => !declared.includes(t));
  if (missing.length) warnings.push(`Carte "${id}" : mots-clés déclarés mais non affichés — ${missing.join(', ')}`);
  if (extra.length) warnings.push(`Carte "${id}" : chips affichés mais absents de data-tags — ${extra.join(', ')}`);
}

/* 8. Toutes les sources en HTTPS et correctement sécurisées */
for (const m of HTML.matchAll(/<div class="sources">([\s\S]*?)<\/div>/g)) {
  for (const a of m[1].matchAll(/<a href="([^"]+)"([^>]*)>/g)) {
    if (!a[1].startsWith('https://')) errors.push(`Source non HTTPS : ${a[1]}`);
    if (!a[2].includes('rel="noopener noreferrer"')) warnings.push(`Lien sans rel="noopener noreferrer" : ${a[1]}`);
  }
}

/* 9. Aucune carte sans source */
for (const m of HTML.matchAll(/<article class="card" id="([^"]+)"([\s\S]*?)<\/article>/g)) {
  if (!m[2].includes('<div class="sources">')) errors.push(`Carte "${m[1]}" : aucun bloc de sources`);
}

/* 10. Aucune dépendance externe introduite */
for (const m of HTML.matchAll(/<(?:script|link)[^>]*(?:src|href)="(https?:\/\/[^"]+)"/g)) {
  errors.push(`Ressource externe introduite dans la page : ${m[1]} — le site doit rester autonome`);
}

/* 11. Le squelette est intact */
for (const needed of ['id="tag-chips"', 'data-stat="total"', 'src="script.js"', 'href="style.css"', 'id="empty-state"']) {
  if (!HTML.includes(needed)) errors.push(`Élément structurel manquant : ${needed}`);
}

/* ------------------------------------------------------------------ Rapport */

console.log(`Cartes détectées : ${ids.length}`);

if (warnings.length) {
  console.log('\nAvertissements :');
  for (const w of warnings) console.log(`::warning::${w}`);
}

if (errors.length) {
  console.log('\nErreurs :');
  for (const e of errors) console.log(`::error::${e}`);
  console.error(`\n${errors.length} erreur(s) — index.html ne sera pas proposé en pull request.`);
  process.exit(1);
}

console.log('\nContrôle d\'intégrité réussi.');
