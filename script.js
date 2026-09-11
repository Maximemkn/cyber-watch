/* ==========================================================================
   Veille Réglementaire Cyber & IA — comportements
   Accordéons, filtres à facettes cumulables, compteurs, copie pour Teams.
   Aucune dépendance externe.
   ========================================================================== */

(function () {
  'use strict';

  var cards        = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var sections     = Array.prototype.slice.call(document.querySelectorAll('.section[data-section]'));
  var subsections  = Array.prototype.slice.call(document.querySelectorAll('.subsection'));
  var emptyState   = document.getElementById('empty-state');

  /* ==========================================================================
     AUTO-CALCUL — à partir des cartes réellement présentes dans la page.
     Pour ajouter une actualité, il suffit de coller un bloc <article class="card">
     dans la bonne sous-rubrique : le bandeau de stats, la liste des mots-clés
     filtrables et tous les compteurs se mettent à jour seuls.
     ========================================================================== */

  function tagsOf(card) {
    var raw = card.getAttribute('data-tags') || '';
    return raw ? raw.split('|').map(function (t) { return t.trim(); }).filter(Boolean) : [];
  }

  function allTags() {
    var seen = {};
    var list = [];
    cards.forEach(function (card) {
      tagsOf(card).forEach(function (t) {
        if (!seen[t]) { seen[t] = true; list.push(t); }
      });
    });
    return list.sort(function (a, b) {
      return a.toLowerCase().localeCompare(b.toLowerCase(), 'fr');
    });
  }

  function countSources() {
    var seen = {};
    var n = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.sources a[href]'), function (a) {
      var href = a.getAttribute('href');
      if (href && !seen[href]) { seen[href] = true; n++; }
    });
    return n;
  }

  /* Bandeau de stats */
  function renderStats() {
    var values = {
      total: cards.length,
      confirme: cards.filter(function (c) { return c.getAttribute('data-conf') === 'confirme'; }).length,
      sources: countSources(),
      tags: allTags().length
    };
    Object.keys(values).forEach(function (key) {
      var el = document.querySelector('[data-stat="' + key + '"]');
      if (el) el.textContent = values[key];
    });
  }

  /* Cases à cocher « Éditeur / mot-clé » */
  function renderTagFacet() {
    var box = document.getElementById('tag-chips');
    if (!box) return;
    var previously = {};
    Array.prototype.forEach.call(box.querySelectorAll('input:checked'), function (i) {
      previously[i.value] = true;
    });
    box.textContent = '';
    allTags().forEach(function (tag) {
      var label = document.createElement('label');
      label.className = 'chip';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('data-facet', 'tag');
      input.value = tag;
      if (previously[tag]) input.checked = true;
      var span = document.createElement('span');
      span.textContent = tag;
      label.appendChild(input);
      label.appendChild(span);
      box.appendChild(label);
    });
  }

  renderStats();
  renderTagFacet();

  var facetInputs  = Array.prototype.slice.call(document.querySelectorAll('[data-facet]'));
  var resultCount  = document.getElementById('result-count');
  var toastEl      = document.getElementById('toast');
  var toastTimer   = null;

  /* ---------------------------------------------------------------- Toast */

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }

  /* ------------------------------------------- Repliage du panneau de filtres */

  var toggleFilters = document.getElementById('toggle-filters');
  var facetsBox     = document.getElementById('facets');
  var activeCount   = document.getElementById('active-count');

  function setFiltersOpen(open) {
    if (!toggleFilters || !facetsBox) return;
    toggleFilters.setAttribute('aria-expanded', open ? 'true' : 'false');
    facetsBox.hidden = !open;
  }

  if (toggleFilters && facetsBox) {
    toggleFilters.addEventListener('click', function () {
      setFiltersOpen(toggleFilters.getAttribute('aria-expanded') !== 'true');
    });
    // Replié par défaut sur petit écran : le panneau occuperait sinon tout l'écran.
    if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) {
      setFiltersOpen(false);
    }
  }

  /* ----------------------------------------------------------- Accordéons */

  function setExpanded(card, expanded) {
    var head = card.querySelector('.card-head');
    var body = card.querySelector('.card-body');
    if (!head || !body) return;
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    body.hidden = !expanded;
  }

  cards.forEach(function (card) {
    var head = card.querySelector('.card-head');
    if (!head) return;
    head.addEventListener('click', function () {
      var open = head.getAttribute('aria-expanded') === 'true';
      setExpanded(card, !open);
    });
  });

  var expandBtn = document.getElementById('expand-all');
  var collapseBtn = document.getElementById('collapse-all');

  if (expandBtn) {
    expandBtn.addEventListener('click', function () {
      cards.forEach(function (card) {
        if (!card.hidden) setExpanded(card, true);
      });
    });
  }

  if (collapseBtn) {
    collapseBtn.addEventListener('click', function () {
      cards.forEach(function (card) { setExpanded(card, false); });
    });
  }

  /* --------------------------------------------------------------- Filtres */

  function selectedValues(facet) {
    return facetInputs
      .filter(function (i) { return i.dataset.facet === facet && i.checked; })
      .map(function (i) { return i.value; });
  }

  function cardTags(card) { return tagsOf(card); }

  function matches(card, sel) {
    if (sel.section.length && sel.section.indexOf(card.getAttribute('data-section')) === -1) return false;
    if (sel.conf.length && sel.conf.indexOf(card.getAttribute('data-conf')) === -1) return false;
    if (sel.tag.length) {
      // cumul : la carte doit porter TOUS les mots-clés sélectionnés
      var tags = cardTags(card);
      for (var i = 0; i < sel.tag.length; i++) {
        if (tags.indexOf(sel.tag[i]) === -1) return false;
      }
    }
    return true;
  }

  function syncTagButtons(selectedTags) {
    var buttons = document.querySelectorAll('.tag[data-tag]');
    Array.prototype.forEach.call(buttons, function (btn) {
      var on = selectedTags.indexOf(btn.getAttribute('data-tag')) !== -1;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function applyFilters() {
    var sel = {
      section: selectedValues('section'),
      conf: selectedValues('conf'),
      tag: selectedValues('tag')
    };

    var visible = 0;

    cards.forEach(function (card) {
      var ok = matches(card, sel);
      card.hidden = !ok;
      if (ok) visible++;
      else setExpanded(card, false);
    });

    // Compteurs de sous-rubriques
    subsections.forEach(function (sub) {
      var subCards = Array.prototype.slice.call(sub.querySelectorAll('.card'));
      var n = subCards.filter(function (c) { return !c.hidden; }).length;
      var badge = sub.querySelector('[data-sub-count]');
      if (badge) badge.textContent = n;
      sub.hidden = (n === 0);
    });

    // Compteurs de rubriques
    sections.forEach(function (sec) {
      var secCards = Array.prototype.slice.call(sec.querySelectorAll('.card'));
      var n = secCards.filter(function (c) { return !c.hidden; }).length;
      var label = sec.querySelector('[data-section-count]');
      if (label) label.textContent = n + (n > 1 ? ' actualités affichées' : ' actualité affichée');
      sec.hidden = (n === 0);
    });

    if (emptyState) emptyState.hidden = (visible !== 0);

    if (resultCount) {
      var total = cards.length;
      resultCount.textContent = visible === total
        ? total + ' actualités'
        : visible + ' / ' + total + ' actualités';
    }

    syncTagButtons(sel.tag);

    // Nombre de filtres actifs, visible même panneau replié
    if (activeCount) {
      var active = sel.section.length + sel.conf.length + sel.tag.length;
      activeCount.textContent = active + (active > 1 ? ' filtres actifs' : ' filtre actif');
      activeCount.hidden = (active === 0);
    }
  }

  facetInputs.forEach(function (input) {
    input.addEventListener('change', applyFilters);
  });

  var resetBtn = document.getElementById('reset-filters');
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      facetInputs.forEach(function (i) { i.checked = false; });
      applyFilters();
    });
  }

  /* ------------------------------------------- Chips de tags dans les cartes */

  document.addEventListener('click', function (event) {
    var btn = event.target.closest ? event.target.closest('.tag[data-tag]') : null;
    if (!btn) return;
    var value = btn.getAttribute('data-tag');
    var input = facetInputs.filter(function (i) {
      return i.dataset.facet === 'tag' && i.value === value;
    })[0];
    if (!input) return;
    input.checked = !input.checked;
    applyFilters();
    var panel = document.querySelector('.panel');
    if (panel && input.checked) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  /* ------------------------------------------------------ Copier pour Teams */

  function buildTeamsSummary(card) {
    var title = card.querySelector('.card-title');
    var hook  = card.querySelector('.card-hook');
    var date  = card.querySelector('.card-date');
    var badge = card.querySelector('.badge');
    var tags  = cardTags(card);

    var lines = [];
    lines.push((title ? title.textContent.trim() : ''));
    lines.push('');
    if (date || badge) {
      lines.push(
        (date ? date.textContent.trim() : '') +
        (badge ? ' · Niveau de confiance : ' + badge.textContent.trim() : '')
      );
    }
    if (hook) {
      lines.push('');
      lines.push(hook.textContent.trim());
    }

    var paragraphs = Array.prototype.slice.call(card.querySelectorAll('.card-body > p'));
    if (paragraphs.length) {
      lines.push('');
      paragraphs.forEach(function (p) { lines.push('• ' + p.textContent.trim()); });
    }

    var sourceItems = Array.prototype.slice.call(card.querySelectorAll('.sources li'));
    if (sourceItems.length) {
      lines.push('');
      lines.push('Sources :');
      sourceItems.forEach(function (li) {
        var a = li.querySelector('a');
        var d = li.querySelector('.src-date');
        var label = a ? a.textContent.trim() : li.textContent.trim();
        var url = a ? a.getAttribute('href') : '';
        var when = d ? ' ' + d.textContent.trim() : '';
        lines.push('- ' + label + when + (url ? ' — ' + url : ''));
      });
    }

    if (tags.length) {
      lines.push('');
      lines.push('Mots-clés : ' + tags.join(', '));
    }

    return lines.join('\n');
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function flash(btn) {
    var original = btn.textContent;
    btn.textContent = 'Copié';
    btn.classList.add('done');
    setTimeout(function () {
      btn.textContent = original;
      btn.classList.remove('done');
    }, 1800);
  }

  document.addEventListener('click', function (event) {
    var btn = event.target.closest ? event.target.closest('[data-copy]') : null;
    if (!btn) return;
    var card = btn.closest('.card');
    if (!card) return;

    var text = buildTeamsSummary(card);

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        flash(btn);
        toast('Résumé copié dans le presse-papiers');
      }).catch(function () {
        if (legacyCopy(text)) { flash(btn); toast('Résumé copié dans le presse-papiers'); }
        else { toast('Copie impossible — sélectionnez le texte manuellement'); }
      });
    } else if (legacyCopy(text)) {
      flash(btn);
      toast('Résumé copié dans le presse-papiers');
    } else {
      toast('Copie impossible — sélectionnez le texte manuellement');
    }
  });

  /* ------------------------------------------------- Ouverture par ancre # */

  function openFromHash() {
    if (!window.location.hash) return;
    var target = document.querySelector(window.location.hash);
    if (target && target.classList.contains('card')) setExpanded(target, true);
  }

  window.addEventListener('hashchange', openFromHash);

  /* ------------------------------------------------------------ Initialisation */

  applyFilters();
  openFromHash();
})();
