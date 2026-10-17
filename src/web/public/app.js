// Progressive enhancement for the admin console: menus, dialogs, confirmations, copy buttons,
// toasts, the mobile drawer, live previews and dirty-state footers. Forms still submit without it.
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function iconNode(name) {
    var tpl = document.getElementById('icon-templates');
    var el = tpl && tpl.content.querySelector('[data-i="' + name + '"]');
    return el ? el.firstElementChild.cloneNode(true) : document.createElement('span');
  }

  // ---- Toasts ---------------------------------------------------------------------------------

  function dismiss(t) {
    if (!t || !t.parentNode) return;
    t.classList.add('leave');
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, reduceMotion ? 0 : 160);
  }
  function arm(t, ms) { setTimeout(function () { dismiss(t); }, ms); }
  function toast(message, kind) {
    var region = document.getElementById('toasts');
    if (!region) return;
    var t = document.createElement('div');
    t.className = 'toast enter';
    t.appendChild(iconNode(kind || 'ok'));
    var span = document.createElement('span');
    span.textContent = message;
    t.appendChild(span);
    region.appendChild(t);
    requestAnimationFrame(function () { t.classList.remove('enter'); });
    arm(t, kind === 'danger' ? 6000 : 2600);
  }
  window.trToast = toast;
  $$('.toast[data-auto]').forEach(function (t) { arm(t, 4000); });
  document.addEventListener('click', function (e) {
    var close = e.target.closest('[data-toast-close]');
    if (close) dismiss(close.closest('.toast'));
  });

  // ---- Menus ----------------------------------------------------------------------------------

  var openMenu = null;
  function closeMenu(focusTrigger) {
    if (!openMenu) return;
    var m = openMenu;
    openMenu = null;
    m.panel.classList.remove('shown', 'open');
    m.trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) m.trigger.focus();
  }
  function placeMenu(trigger, panel) {
    var r = trigger.getBoundingClientRect();
    panel.style.left = '0px';
    panel.style.top = '0px';
    var w = panel.offsetWidth, h = panel.offsetHeight;
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var left = trigger.classList.contains('ws') ? r.left : r.right - w;
    left = Math.max(8, Math.min(left, vw - w - 8));
    var top = r.bottom + 4;
    if (vh - r.bottom < Math.min(h + 12, 200) && r.top > h + 12) top = r.top - h - 4;
    top = Math.max(8, Math.min(top, vh - h - 8));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    if (trigger.classList.contains('ws')) panel.style.minWidth = r.width + 'px';
  }
  function items(panel) { return $$('.menu-item:not([disabled])', panel); }
  function toggleMenu(trigger) {
    var panel = document.getElementById(trigger.getAttribute('data-menu'));
    if (!panel) return;
    if (openMenu && openMenu.panel === panel) return closeMenu(true);
    closeMenu(false);
    panel.classList.add('open');
    placeMenu(trigger, panel);
    trigger.setAttribute('aria-expanded', 'true');
    openMenu = { trigger: trigger, panel: panel };
    requestAnimationFrame(function () { panel.classList.add('shown'); });
    var first = items(panel)[0];
    if (first) first.focus();
  }
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-menu]');
    if (trigger) { e.preventDefault(); toggleMenu(trigger); return; }
    if (openMenu && !openMenu.panel.contains(e.target)) closeMenu(false);
  });
  document.addEventListener('keydown', function (e) {
    if (!openMenu) return;
    var list = items(openMenu.panel);
    var i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  window.addEventListener('resize', function () { closeMenu(false); });
  window.addEventListener('scroll', function () { closeMenu(false); }, true);

  // ---- Dialogs --------------------------------------------------------------------------------

  function openDialog(d) {
    if (!d || typeof d.showModal !== 'function') return false;
    d.showModal();
    var focus = d.querySelector('[autofocus]') ||
      (d.hasAttribute('data-destructive') ? d.querySelector('.dlg-f [data-dialog-close]') : null) ||
      d.querySelector('.dlg-b input:not([type=hidden]):not([disabled]), .dlg-b textarea, .dlg-b select') ||
      d.querySelector('.dlg-f [data-dialog-close]');
    if (focus) focus.focus();
    return true;
  }
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-dialog]');
    if (opener) {
      closeMenu(false);
      if (openDialog(document.getElementById(opener.getAttribute('data-dialog')))) e.preventDefault();
      return;
    }
    var closer = e.target.closest('[data-dialog-close]');
    if (closer) { var d = closer.closest('dialog'); if (d) d.close(); return; }
    // Clicking the backdrop (the dialog element itself, outside its content) closes it.
    if (e.target.tagName === 'DIALOG' && e.target.open) {
      var r = e.target.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
    }
  });

  // ---- Confirmations and loading states -------------------------------------------------------

  var confirmDialog = document.getElementById('confirm-dialog');
  /** Bulk triage: one line on which of the selected tickets count, before the confirmation. */
  function bulkSummary(formId) {
    if (!formId) return '';
    var form = document.getElementById(formId);
    var all = form && form.querySelector('input[name="all"]');
    if (all && all.value === '1') return 'Tickets with nothing matching are skipped. ';
    var boxes = $$('input[type="checkbox"][form="' + formId + '"]').filter(function (b) { return b.checked; });
    var matched = boxes.filter(function (b) { return b.hasAttribute('data-match'); }).length;
    if (matched === boxes.length) return 'All ' + boxes.length + ' selected have a matching suggestion. ';
    return matched + ' of the ' + boxes.length + ' selected have a matching suggestion; the other ' + (boxes.length - matched) + ' are skipped. ';
  }
  var pending = null;
  if (confirmDialog) {
    $('#confirm-ok', confirmDialog).addEventListener('click', function () {
      var p = pending;
      pending = null;
      confirmDialog.close();
      if (!p) return;
      p.form.setAttribute('data-confirmed', '1');
      if (p.form.requestSubmit) p.form.requestSubmit(p.submitter || undefined); else p.form.submit();
    });
    confirmDialog.addEventListener('close', function () { pending = null; });
  }
  document.addEventListener('submit', function (e) {
    var form = e.target;
    // A button can bring its own confirmation (bulk Apply and Dismiss share one form).
    var src = e.submitter && e.submitter.hasAttribute('data-confirm-title') ? e.submitter : form;
    if (src.hasAttribute('data-confirm-title') && !form.hasAttribute('data-confirmed') && confirmDialog && confirmDialog.showModal) {
      e.preventDefault();
      closeMenu(false);
      pending = { form: form, submitter: e.submitter };
      $('#confirm-title', confirmDialog).textContent = src.getAttribute('data-confirm-title');
      $('#confirm-body', confirmDialog).textContent = bulkSummary(src.getAttribute('data-bulk-summary')) + (src.getAttribute('data-confirm-body') || '');
      var ok = $('#confirm-ok', confirmDialog);
      ok.textContent = src.getAttribute('data-confirm-label') || 'Confirm';
      ok.className = 'btn ' + (src.hasAttribute('data-confirm-danger') ? 'danger-solid' : 'primary');
      if (src.hasAttribute('data-confirm-danger')) confirmDialog.setAttribute('data-destructive', ''); else confirmDialog.removeAttribute('data-destructive');
      openDialog(confirmDialog);
      return;
    }
    form.removeAttribute('data-confirmed');
    if (form.hasAttribute('data-async')) return;
    var button = e.submitter || form.querySelector('button[type="submit"]');
    if (button && button.classList.contains('btn')) {
      setTimeout(function () {
        button.disabled = true;
        button.classList.add('loading');
        var label = button.querySelector('.lbl');
        if (label && button.dataset.loadingText) label.textContent = button.dataset.loadingText;
      }, 0);
    }
  });

  // ---- Copy -----------------------------------------------------------------------------------

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy],[data-copy-value]');
    if (!b) return;
    var value = b.getAttribute('data-copy-value');
    if (value === null) {
      var input = document.getElementById(b.getAttribute('data-copy'));
      if (!input) return;
      input.select();
      value = input.value;
    }
    closeMenu(false);
    var done = function () {
      toast('Copied');
      var ic = b.querySelector('.ic');
      if (!ic) return;
      var check = iconNode(ic.classList.contains('ic-14') ? 'check' : 'check-16');
      b.replaceChild(check, ic);
      setTimeout(function () { if (check.parentNode === b) b.replaceChild(ic, check); }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done, function () { toast('Copy failed. Select the text and copy it manually.', 'warn'); });
  });

  // ---- Mobile drawer --------------------------------------------------------------------------

  var menuBtn = document.getElementById('menu-btn');
  var sidebar = document.getElementById('sidebar');
  var scrim = null;
  function setDrawer(open) {
    if (!sidebar || !menuBtn) return;
    sidebar.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) {
      scrim = document.createElement('div');
      scrim.className = 'scrim';
      scrim.addEventListener('click', function () { setDrawer(false); });
      document.body.appendChild(scrim);
      var c = document.getElementById('drawer-close');
      if (c) c.focus();
    } else {
      if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
      scrim = null;
      menuBtn.focus();
    }
  }
  if (menuBtn) menuBtn.addEventListener('click', function () { setDrawer(!sidebar.classList.contains('open')); });
  var drawerClose = document.getElementById('drawer-close');
  if (drawerClose) drawerClose.addEventListener('click', function () { setDrawer(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sidebar && sidebar.classList.contains('open') && !openMenu) setDrawer(false);
  });

  // ---- Auto-submitting controls ---------------------------------------------------------------

  // Switches inside form[data-async] save right away (JSON response with a message).
  document.addEventListener('change', function (e) {
    var input = e.target;
    var form = input.form;
    if (form && form.hasAttribute('data-async')) {
      var data = new URLSearchParams(new FormData(form));
      var prev = !input.checked;
      // Set from elsewhere (Members: a tool's select), focus stays where it is.
      var hadFocus = document.activeElement === input;
      input.disabled = true;
      fetch(form.action, { method: 'POST', body: data, credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (!res.ok || !body.ok) throw { shown: body.error || (res.status === 403 ? 'You don’t have permission to change this.' : 'Not saved. Reload the page and try again.') };
            toast(body.message || 'Saved');
            // Dev mode: the sidebar tag follows the switch, and Server health updates right away.
            if (form.hasAttribute('data-dev-mode')) $$('[data-dev-tag]').forEach(function (t) { t.hidden = !input.checked; });
            if (form.hasAttribute('data-live-refresh')) document.dispatchEvent(new CustomEvent('tr:live-refresh'));
          });
        })
        .catch(function (err) {
          if (input.type === 'checkbox') input.checked = prev;
          toast(err && err.shown ? err.shown : 'Not saved. Check your connection and try again.', 'danger');
        })
        .then(function () { input.disabled = false; if (hadFocus) input.focus({ preventScroll: true }); });
      return;
    }
    if (input.hasAttribute('data-autosubmit') && form) form.submit();
  });

  // ---- Filters --------------------------------------------------------------------------------

  $$('[data-filter-rows]').forEach(function (input) {
    var scope = document.querySelector(input.getAttribute('data-filter-rows'));
    var emptyEl = document.getElementById(input.getAttribute('data-filter-empty'));
    if (!scope) return;
    function run() {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      $$('[data-search]', scope).forEach(function (row) {
        var hit = !q || row.getAttribute('data-search').indexOf(q) !== -1;
        row.hidden = !hit;
        if (hit && !row.classList.contains('only-mobile-row')) shown++;
      });
      $$('[data-search-wrap]', scope).forEach(function (w) { w.hidden = q && shown === 0; });
      if (emptyEl) {
        emptyEl.hidden = !(q && shown === 0);
        var term = emptyEl.querySelector('[data-term]');
        if (term) term.textContent = input.value.trim();
      }
    }
    input.addEventListener('input', run);
    var clear = emptyEl && emptyEl.querySelector('[data-clear-search]');
    if (clear) clear.addEventListener('click', function (e) { e.preventDefault(); input.value = ''; run(); input.focus(); });
    run();
  });
  $$('[data-toggle-filters]').forEach(function (b) {
    b.addEventListener('click', function () {
      var target = document.getElementById(b.getAttribute('data-toggle-filters'));
      if (!target) return;
      var show = !target.classList.contains('show');
      target.classList.toggle('show', show);
      b.setAttribute('aria-expanded', show ? 'true' : 'false');
    });
  });

  // ---- Counters, live previews and dirty forms ------------------------------------------------

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Tiny Discord-markdown renderer matching the server preview: headings, **bold**, role mentions.
  function discordHtml(text, roles) {
    return escapeHtml(text).split('\n').map(function (line) {
      var out = line
        .replace(/&lt;@&amp;(\d+)&gt;/g, function (_m, id) { return '<span class="dp-mention">@' + escapeHtml(roles[id] || 'unknown-role') + '</span>'; })
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      var h = /^#{1,3} (.*)$/.exec(out);
      return h ? '<span class="dp-h">' + h[1] + '</span>' : out;
    }).join('<br>');
  }
  function syncField(el) {
    var counter = el.id && document.querySelector('[data-counter-for="' + el.id + '"]');
    if (counter) counter.textContent = el.value.length + ' / ' + el.getAttribute('maxlength');
    var target = el.getAttribute('data-preview') && document.getElementById(el.getAttribute('data-preview'));
    if (target) {
      var value = el.value.trim() ? el.value : (el.getAttribute('placeholder') || '');
      if (el.hasAttribute('data-preview-md')) {
        var rolesEl = document.getElementById('role-names');
        var roles = rolesEl ? JSON.parse(rolesEl.textContent || '{}') : {};
        target.innerHTML = discordHtml(value, roles);
      } else {
        target.textContent = value;
      }
    }
  }
  $$('[data-preview],[maxlength][id]').forEach(function (el) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
    el.addEventListener('input', function () { syncField(el); });
  });

  $$('form[data-dirty]').forEach(function (form) {
    function snapshot() { return new URLSearchParams(new FormData(form)).toString(); }
    var initial = snapshot();
    function update() {
      var dirty = snapshot() !== initial;
      $$('[data-dirty-show]', form).forEach(function (el) { el.hidden = !dirty; });
      $$('[data-clean-show]', form).forEach(function (el) { el.hidden = dirty; });
      $$('[data-dirty-enable]', form).forEach(function (el) { el.disabled = !dirty; });
    }
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    $$('[data-discard]', form).forEach(function (b) {
      b.addEventListener('click', function () {
        form.reset();
        $$('input, textarea', form).forEach(syncField);
        update();
      });
    });
    update();
  });

  // AI triage › Knowledge: the team's notes on an app.
  (function () {
    var editor = document.querySelector('form[data-kn-editor]');
    var text = editor && editor.querySelector('textarea[name="body"]');
    if (!text) return;
    var meter = document.querySelector('[data-kn-meter-for="' + text.id + '"]');
    var max = Number(meter ? meter.getAttribute('data-max') : text.getAttribute('maxlength')) || 10000;
    function fmt(x) { return x.toLocaleString('en-US'); }
    function tokens(chars) {
      var t = Math.ceil(chars / 4);
      return 'about ' + fmt(t >= 1000 ? Math.round(t / 100) * 100 : t >= 100 ? Math.round(t / 10) * 10 : t) + ' tokens';
    }
    function measure() {
      if (!meter) return;
      meter.textContent = fmt(text.value.length) + ' / ' + fmt(max) + ' · ' + tokens(text.value.length);
      meter.classList.toggle('near', text.value.length > max * 0.9);
    }
    // Puts text at the end, leaves the cursor there and tells the dirty check.
    function append(add) {
      var v = text.value.replace(/\s+$/, '');
      text.value = (v ? v + '\n\n' : '') + add;
      text.focus();
      text.setSelectionRange(text.value.length, text.value.length);
      text.scrollTop = text.scrollHeight;
      text.dispatchEvent(new Event('input', { bubbles: true }));
    }
    text.addEventListener('input', measure);
    // Cancel puts everything back: the text and the Answer buttons.
    editor.addEventListener('reset', function () {
      setTimeout(function () {
        measure();
        $$('[data-kn-add]').forEach(function (b) { b.disabled = false; b.lastChild.textContent = 'Answer'; });
      }, 0);
    });

    // "Answer" on one of Claude's questions: adds it to the notes, ready for the answer.
    var HEADING = '## Answers to Claude’s questions';
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-kn-add]');
      if (!b || text.disabled) return;
      var line = '- ' + b.getAttribute('data-kn-add') + ' ';
      if (text.value.indexOf(HEADING) === -1) append(HEADING + '\n' + line);
      else {
        text.value = text.value.replace(/\s+$/, '') + '\n' + line;
        text.focus();
        text.setSelectionRange(text.value.length, text.value.length);
        text.scrollTop = text.scrollHeight;
        text.dispatchEvent(new Event('input', { bubbles: true }));
      }
      b.disabled = true;
      b.lastChild.textContent = 'Added';
    });

    // ⌘S / Ctrl+S saves (when there's something to save).
    editor.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        var save = editor.querySelector('button[type="submit"]');
        if (save && !save.disabled) save.click();
      }
    });
  })();

  // Knowledge › Keep them up to date: the monthly estimate follows the schedule picked.
  document.addEventListener('change', function (e) {
    var select = e.target.closest && e.target.closest('select[name="every"][form="kn-auto"]');
    var month = select && document.querySelector('[data-kn-month]');
    if (!month) return;
    var usd = Number(month.getAttribute('data-each')) * Number(month.getAttribute('data-apps')) * 30 / Number(select.value);
    month.textContent = usd < 0.01 ? 'under $0.01' : 'about $' + usd.toFixed(2);
  });

  // "Reset to default" puts each field's default (its placeholder) back.
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-reset-fields]');
    if (!b) return;
    b.getAttribute('data-reset-fields').split(/\s+/).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.value = el.getAttribute('data-default') !== null ? el.getAttribute('data-default') : el.getAttribute('placeholder') || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  // Whole table rows open their ticket; the title link stays the keyboard target.
  document.addEventListener('click', function (e) {
    var tr = e.target.closest('tr.click');
    if (!tr || e.target.closest('a, button, input, select, label, form')) return;
    var a = tr.querySelector('a.cell-title');
    if (!a) return;
    if (e.metaKey || e.ctrlKey) window.open(a.href, '_blank'); else window.location.href = a.href;
  });

  // ---- Highlight a row linked from a menu (e.g. "Edit access") --------------------------------

  function flashTarget() {
    if (!location.hash || location.hash.length < 2) return;
    var row = document.getElementById(location.hash.slice(1));
    if (!row || !row.hasAttribute('data-flash')) return;
    // Hidden at this width (a table column on a phone): use its phone version instead.
    var alt = row.getAttribute('data-flash-alt');
    if (!row.offsetParent && alt && document.getElementById(alt)) row = document.getElementById(alt);
    if (row.tagName === 'DETAILS') row.open = true;
    row.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    // A column header lights up its whole column.
    var col = row.getAttribute('data-flash-col');
    var targets = col ? [row].concat($$('[data-col="' + col + '"]')) : [row];
    targets.forEach(function (el) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    });
    var first = col ? document.querySelector('[data-col="' + col + '"] select') : row.querySelector('input:not([type=hidden]), select');
    if (first) first.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', flashTarget);
  flashTarget();

  // ---- App form: load the chosen repository's labels -----------------------------------------

  var repoSelect = document.getElementById('repo');
  var labelBox = document.getElementById('label-list');
  if (repoSelect && labelBox) {
    var endpoint = labelBox.getAttribute('data-endpoint');
    var selected = new Set(JSON.parse(labelBox.getAttribute('data-selected') || '[]'));
    var visibility = document.getElementById('repo-visibility');

    var renderLabels = function (message, labels) {
      labelBox.textContent = '';
      if (message) {
        var p = document.createElement('span');
        p.className = 'muted small';
        p.textContent = message;
        labelBox.appendChild(p);
        return;
      }
      labels.forEach(function (name) {
        var label = document.createElement('label');
        label.className = 'check';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'labels';
        input.value = name;
        input.checked = selected.has(name);
        input.addEventListener('change', function () {
          if (input.checked) selected.add(name); else selected.delete(name);
        });
        label.appendChild(input);
        var text = document.createElement('span');
        text.className = 'mono';
        text.textContent = name;
        label.appendChild(text);
        labelBox.appendChild(label);
      });
    };

    var load = function () {
      var option = repoSelect.options[repoSelect.selectedIndex];
      if (visibility) {
        var priv = option && option.getAttribute('data-private');
        visibility.textContent = !option || !option.value ? '' : priv === 'true'
          ? 'Private repository: only people with access can see tickets. Members are told this.'
          : 'Public repository: anyone can read tickets filed here. Members are told this before they submit.';
      }
      if (!repoSelect.value) return renderLabels('Choose a repository to see its labels.');
      renderLabels('Loading labels…');
      fetch(endpoint + '?repo=' + encodeURIComponent(repoSelect.value), { credentials: 'same-origin' })
        .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
        .then(function (result) {
          if (!result.ok) return renderLabels(result.body.error || 'Could not load labels.');
          if (!result.body.labels.length) return renderLabels('This repository has no labels.');
          renderLabels(null, result.body.labels);
        })
        .catch(function () { renderLabels('Could not load labels. You can save without labels and add them later.'); });
    };

    repoSelect.addEventListener('change', function () { selected.clear(); load(); });
    load();
  }
  // ---- Form builder (Ticket types › Form) -----------------------------------------------------

  var builder = document.getElementById('form-builder');
  if (builder) (function () {
    var list = document.getElementById('fsecs');
    var preview = document.getElementById('form-preview');
    var MAX = 5;
    function secs() { return $$('.fsec', list); }
    function kind(sec) { return sec.getAttribute('data-kind'); }
    function field(sec, name) { return sec.querySelector('[name="' + sec.getAttribute('data-key') + '.' + name + '"]'); }
    function value(sec, name) { var f = field(sec, name); return f ? (f.type === 'checkbox' ? f.checked : f.value) : ''; }
    function text(sec, name) { return String(value(sec, name)).trim(); }
    function required(sec) { var k = kind(sec); return k === 'title' || k === 'description' || (k !== 'intro' && value(sec, 'required') === true); }
    function el(tag, cls, content) { var e = document.createElement(tag); if (cls) e.className = cls; if (content !== undefined) e.textContent = content; return e; }

    function drawPreview(all) {
      var box = preview && preview.querySelector('[data-pv-sections]');
      if (!box) return;
      box.textContent = '';
      all.forEach(function (sec) {
        var k = kind(sec);
        if (k === 'intro') {
          var app = preview.getAttribute('data-app'), type = preview.getAttribute('data-type');
          var lead = type ? '**' + type + '** for **' + app + '**.' : 'Describe your problem with **' + app + '**.';
          var p = el('p', 'dp-text');
          p.innerHTML = discordHtml(lead + ' ' + text(sec, 'text') + '\n\n' + preview.getAttribute('data-notice') + ' Do not include passwords, tokens or other secrets.', {});
          box.appendChild(p);
          return;
        }
        var f = el('div', 'dp-field');
        var l = el('div', 'dp-l', text(sec, 'label') || 'Question');
        if (required(sec)) l.appendChild(el('span', 'dp-req', ' *'));
        f.appendChild(l);
        if (text(sec, 'hint')) f.appendChild(el('div', 'dp-d', text(sec, 'hint')));
        if (k === 'files') {
          var drop = el('div', 'dp-drop');
          drop.appendChild(iconNode('upload'));
          drop.appendChild(el('span', '', 'Drag and drop or click to upload'));
          f.appendChild(drop);
        } else {
          var input = el('div', 'dp-input' + (k === 'description' || k === 'paragraph' ? ' tall' : ''));
          if (text(sec, 'placeholder')) input.appendChild(el('span', 'dp-ph', text(sec, 'placeholder')));
          f.appendChild(input);
        }
        box.appendChild(f);
      });
    }

    function refresh() {
      var all = secs();
      var n = all.length;
      var has = function (k) { return all.some(function (s) { return kind(s) === k; }); };
      $$('.pip', builder).forEach(function (p, i) { p.classList.toggle('on', i < n); });
      var slots = builder.querySelector('.slots');
      if (slots) slots.classList.toggle('full', n >= MAX);
      var slotText = builder.querySelector('[data-slot-text]');
      if (slotText) slotText.textContent = n + ' of ' + MAX + ' used';
      $$('[data-fb-add]', builder).forEach(function (b) {
        var k = b.getAttribute('data-fb-add');
        b.hidden = (k === 'intro' || k === 'files') && has(k);
        b.disabled = n >= MAX;
      });
      var full = builder.querySelector('[data-fb-full]');
      if (full) full.hidden = n < MAX;
      all.forEach(function (sec, i) {
        var up = sec.querySelector('[data-fb-move="up"]'), down = sec.querySelector('[data-fb-move="down"]');
        if (up) up.disabled = !all[i - 1] || kind(all[i - 1]) === 'intro';
        if (down) down.disabled = !all[i + 1];
        var k = kind(sec);
        var title = sec.querySelector('[data-fb-title]');
        if (title) title.textContent = k === 'intro' ? 'Intro text' : text(sec, 'label') || sec.getAttribute('data-kind-name');
        var sub = sec.querySelector('[data-fb-sub]');
        if (sub) sub.textContent = sec.getAttribute('data-kind-name') + (k === 'intro' ? '' : required(sec) ? ' · Required' : ' · Optional');
      });
      drawPreview(all);
    }

    // Structural edits don't fire input events, so tell the unsaved-changes footer.
    function changed() { builder.dispatchEvent(new Event('change', { bubbles: true })); refresh(); }

    function newKey() {
      var key;
      do { key = Math.random().toString(36).slice(2, 10); } while (key.length < 6 || list.querySelector('[data-key="' + key + '"]'));
      return key;
    }

    builder.addEventListener('click', function (e) {
      var add = e.target.closest('[data-fb-add]');
      if (add) {
        var k = add.getAttribute('data-fb-add');
        var tpl = builder.querySelector('template[data-fb-template="' + k + '"]');
        if (!tpl || secs().length >= MAX) return;
        var holder = document.createElement('div');
        holder.innerHTML = tpl.innerHTML.replace(/__KEY__/g, newKey());
        var sec = holder.firstElementChild;
        if (k === 'intro') list.insertBefore(sec, list.firstElementChild); else list.appendChild(sec);
        sec.classList.add('enter');
        changed();
        var first = sec.querySelector('input[type="text"], textarea');
        if (first) first.focus();
        return;
      }
      var move = e.target.closest('[data-fb-move]');
      if (move) {
        var s = move.closest('.fsec');
        if (move.getAttribute('data-fb-move') === 'up' && s.previousElementSibling && kind(s.previousElementSibling) !== 'intro') list.insertBefore(s, s.previousElementSibling);
        else if (move.getAttribute('data-fb-move') === 'down' && s.nextElementSibling) list.insertBefore(s.nextElementSibling, s);
        changed();
        if (!move.disabled) move.focus(); else { var other = s.querySelector('[data-fb-move]:not([disabled])'); if (other) other.focus(); }
        return;
      }
      var remove = e.target.closest('[data-fb-remove]');
      if (remove) {
        var r = remove.closest('.fsec');
        var next = r.nextElementSibling || r.previousElementSibling;
        r.parentNode.removeChild(r);
        changed();
        var focus = next && next.querySelector('button:not([disabled]), input:not([type="hidden"])');
        if (focus) focus.focus();
      }
    });
    builder.addEventListener('input', function (e) {
      if (e.target.id && e.target.hasAttribute('maxlength')) syncField(e.target);
      // "Up to 5 PNG or JPG images…" follows the number of files allowed.
      if (/\.max$/.test(e.target.name || '') && Number(e.target.value) >= 1) {
        var sec = e.target.closest('.fsec');
        var hint = sec && field(sec, 'hint');
        if (hint && /^Up to \d+ /.test(hint.value)) {
          var n = Number(e.target.value);
          hint.value = hint.value.replace(/^Up to \d+ (PNG or JPG )?images?/, 'Up to ' + n + ' $1' + (n === 1 ? 'image' : 'images'));
          syncField(hint);
        }
      }
      refresh();
    });
    builder.addEventListener('change', refresh);
    refresh();
  })();

  // ---- Bulk selection (Files tab) -------------------------------------------------------------

  function selection(formId) {
    return $$('input[type="checkbox"][form="' + formId + '"]');
  }
  /** "Select all N in this list" (bulk triage): the whole list, not just this page. */
  function allMatching(formId) {
    var form = document.getElementById(formId);
    var all = form && form.querySelector('input[name="all"]');
    return all && all.value === '1' ? all : null;
  }
  function updateSelection(formId) {
    var boxes = selection(formId);
    var n = boxes.filter(function (b) { return b.checked; }).length;
    var everything = allMatching(formId);
    if (everything) {
      var btn = document.querySelector('[data-select-matching="' + formId + '"]');
      var total = btn ? btn.getAttribute('data-matching') : '';
      $$('[data-selected-text="' + formId + '"]').forEach(function (t) { t.textContent = 'All ' + Number(total).toLocaleString('en-US') + ' in this list selected'; });
      $$('[data-needs-selection="' + formId + '"]').forEach(function (b) { b.disabled = false; });
      $$('[data-select-all="' + formId + '"]').forEach(function (all) { all.checked = true; all.indeterminate = false; });
      return;
    }
    $$('[data-select-all="' + formId + '"]').forEach(function (all) {
      all.checked = n > 0 && n === boxes.length;
      all.indeterminate = n > 0 && n < boxes.length;
    });
    // Bulk triage: how many of the selected have a matching suggestion (data-match).
    var matched = boxes.filter(function (b) { return b.checked && b.hasAttribute('data-match'); }).length;
    var counting = false;
    $$('[data-selected-text="' + formId + '"]').forEach(function (t) {
      counting = counting || t.hasAttribute('data-count-matches');
      // A list of tickets and issues (data-selected-plain) counts "3 selected".
      var plain = t.hasAttribute('data-selected-plain');
      var text = n ? (plain ? n + ' selected' : n + (n === 1 ? ' ticket selected' : ' tickets selected')) : t.getAttribute('data-empty-text') || 'Select tickets to delete their files.';
      if (n && t.hasAttribute('data-count-matches') && matched < n) text = n + ' selected · ' + (matched ? matched + ' with a matching suggestion' : 'none with a matching suggestion');
      t.textContent = text;
    });
    $$('[data-needs-selection="' + formId + '"]').forEach(function (b) { b.disabled = n === 0 || (counting && matched === 0); });
  }
  $$('[data-select-all]').forEach(function (all) {
    var formId = all.getAttribute('data-select-all');
    all.addEventListener('change', function () {
      selection(formId).forEach(function (b) { b.checked = all.checked; });
      var everything = allMatching(formId);
      if (everything && !all.checked) {
        everything.value = '0';
        $$('[data-select-matching="' + formId + '"]').forEach(function (btn) { btn.hidden = false; });
      }
      updateSelection(formId);
    });
    selection(formId).forEach(function (b) {
      b.addEventListener('change', function () {
        // Unticking one goes back to picking tickets one by one.
        var everything = allMatching(formId);
        if (everything && !b.checked) everything.value = '0';
        updateSelection(formId);
      });
    });
    updateSelection(formId);
  });
  $$('[data-select-matching]').forEach(function (btn) {
    var formId = btn.getAttribute('data-select-matching');
    btn.addEventListener('click', function () {
      var form = document.getElementById(formId);
      var all = form && form.querySelector('input[name="all"]');
      if (!all) return;
      all.value = '1';
      selection(formId).forEach(function (b) { b.checked = true; });
      btn.hidden = true;
      updateSelection(formId);
    });
  });

  // ---- File upload drop zone (ticket page) ----------------------------------------------------

  $$('form[data-upload]').forEach(function (form) {
    var input = form.querySelector('input[type="file"]');
    var zone = form.querySelector('[data-dropzone]');
    var label = form.querySelector('[data-dz-text]');
    var submit = form.querySelector('button[type="submit"]');
    if (!input || !zone) return;
    var initial = label ? label.textContent : '';
    function show() {
      var n = input.files ? input.files.length : 0;
      if (label) label.textContent = n ? (n === 1 ? input.files[0].name : n + ' files selected') : initial;
      if (submit) submit.disabled = n === 0;
    }
    input.addEventListener('change', show);
    ['dragenter', 'dragover'].forEach(function (t) {
      zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      zone.addEventListener(t, function () { zone.classList.remove('over'); });
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        show();
      }
    });
    show();
  });
  // ---- Members › Moderator access: one moderator at a time, tool by tool ------------------------
  //
  // Every moderator's levels are radios of their own hidden form[data-async], so any change saves
  // right away (the handler above posts the whole form). This adds picking a moderator, the tool
  // switches, quick sets, copying another moderator's access, and keeps every summary current.

  var accCard = document.querySelector('[data-access-editor]');
  if (accCard) (function () {
    // Discord tickets always keeps the Inbox, so "closed" means only the inbox.
    var INBOX_TOOL = 'tickets';
    function radios(scope) { return $$('input[type="radio"][data-tool]', scope); }
    /** Each page's name, its levels (the first is its minimum) and the one chosen. */
    function pages(scope) {
      var out = {};
      radios(scope).forEach(function (r) {
        var p = out[r.name] || (out[r.name] = { name: r.name, levels: [], value: null });
        p.levels.push(r.value);
        if (r.checked) p.value = r.value;
      });
      return Object.keys(out).map(function (k) { return out[k]; });
    }
    /** The nearest level a page offers: the Inbox can't go below View, Activity can't go above it. */
    function cap(levels, l) {
      if (levels.indexOf(l) !== -1) return l;
      return l === 'none' ? levels[0] : levels.indexOf('view') !== -1 ? 'view' : levels[levels.length - 1];
    }
    function set(scope, name, level) {
      radios(scope).forEach(function (r) { if (r.name === name) r.checked = r.value === level; });
    }
    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
    /** Rewrites the tool lines, switches, header line and the moderator's chip from the radios. */
    function summarize(ed) {
      $$('.acc-tool', ed).forEach(function (sec) {
        var ps = pages(sec);
        var on = ps.some(function (p) { return p.value !== p.levels[0]; });
        var open = ps.filter(function (p) { return p.value !== 'none'; }).length;
        var edit = ps.filter(function (p) { return p.value === 'edit'; }).length;
        sec.classList.toggle('on', on);
        var sw = $('[data-tool-switch]', sec);
        if (sw) sw.checked = on;
        var line = $('[data-tool-summary]', sec);
        if (line) {
          line.textContent = !on ? (sec.getAttribute('data-tool') === INBOX_TOOL ? 'Only the inbox, view only' : 'No access')
            : ps.length === 1 ? (edit ? 'Edit' : 'View')
            : open + ' of ' + ps.length + ' pages' + (edit ? ' · ' + edit + ' editable' : ' · view only');
        }
      });
      var all = pages(ed);
      var openAll = all.filter(function (p) { return p.value !== 'none'; }).length;
      var editAll = all.filter(function (p) { return p.value === 'edit'; }).length;
      var text = openAll + ' of ' + plural(all.length, 'page') + ' open' + (editAll ? ' · ' + editAll + ' editable' : ' · view only');
      var sum = $('[data-acc-summary]', ed);
      if (sum) sum.textContent = text;
      // Their row in the picker, and the filters' counts.
      var opt = document.getElementById('acc-opt-' + ed.getAttribute('data-mod'));
      if (opt) {
        var kind = editAll ? 'edit' : openAll <= 1 ? 'inbox' : 'view';
        opt.setAttribute('data-kind', kind);
        var os = $('[data-opt-summary]', opt);
        if (os) os.textContent = kind === 'inbox' ? 'Inbox only' : openAll + ' pages · ' + (editAll ? editAll + ' edit' : 'view only');
        var counts = { all: 0, edit: 0, view: 0, inbox: 0 };
        $$('.acc-opt').forEach(function (o) { counts.all++; counts[o.getAttribute('data-kind')]++; });
        $$('[data-kind-count]').forEach(function (c) { c.textContent = String(counts[c.getAttribute('data-kind-count')]); });
      }
    }
    function expand(sec, open) {
      sec.classList.toggle('expanded', open);
      var b = $('[data-acc-expand]', sec);
      if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    /** Saves this moderator: one change event posts their whole form. */
    function save(ed) {
      var r = radios(ed).filter(function (x) { return x.checked; })[0];
      if (r) r.dispatchEvent(new Event('change', { bubbles: true }));
    }
    /** Sets many pages at once (quick sets, tool switches, copying). A tool's own switch also opens or folds it. */
    function apply(ed, scope, pick) {
      pages(scope).forEach(function (p) { set(ed, p.name, cap(p.levels, pick(p))); });
      summarize(ed);
      if (scope !== ed) expand(scope, scope.classList.contains('on'));
      save(ed);
    }

    // Picking a moderator: their editor shows, the address follows (so a reload keeps them).
    function pick(id) {
      var ed = accCard.querySelector('.acc-editor[data-mod="' + id + '"]');
      if (!ed) return;
      $$('.acc-editor', accCard).forEach(function (x) { x.hidden = x !== ed; });
      $$('.acc-opt').forEach(function (o) { o.setAttribute('aria-selected', o.getAttribute('data-mod-pick') === id ? 'true' : 'false'); });
      try {
        var url = new URL(location.href);
        url.searchParams.set('mod', id);
        url.hash = 'moderator-access';
        history.replaceState(null, '', url.toString());
      } catch (err) { /* old browser: the links still work */ }
      // Keep whose access this is in view.
      var who = $('.acc-who', ed);
      if (who && who.getBoundingClientRect().top < 0) ed.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
      var name = $('[data-acc-open]', ed);
      if (name) name.focus({ preventScroll: true });
    }

    // ---- The moderator picker: opened from the name (or ⌘K) ----
    var picker = document.getElementById('acc-picker');
    var search = picker && $('[data-mod-search]', picker);
    var opener = null;
    var active = null;
    var filter = 'all';
    function visibleOpts() { return $$('.acc-opt', picker).filter(function (o) { return !o.hidden; }); }
    function setActive(o) {
      if (active) active.classList.remove('active');
      active = o || null;
      if (active) {
        active.classList.add('active');
        search.setAttribute('aria-activedescendant', active.id);
        var list = active.parentNode;
        if (active.offsetTop < list.scrollTop) list.scrollTop = active.offsetTop;
        else if (active.offsetTop + active.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = active.offsetTop + active.offsetHeight - list.clientHeight;
      } else search.removeAttribute('aria-activedescendant');
    }
    function applyFilter() {
      var q = search.value.trim().toLowerCase();
      $$('.acc-opt', picker).forEach(function (o) {
        o.hidden = !((filter === 'all' || o.getAttribute('data-kind') === filter) && (!q || o.getAttribute('data-find').indexOf(q) !== -1));
      });
      var shown = visibleOpts();
      $('[data-mod-none]', picker).hidden = shown.length > 0;
      setActive(shown.filter(function (o) { return o.getAttribute('aria-selected') === 'true'; })[0] || shown[0]);
    }
    function place() {
      if (!picker || picker.hidden || !opener) return;
      var r = opener.getBoundingClientRect();
      var w = Math.min(420, document.documentElement.clientWidth - 24);
      picker.style.width = w + 'px';
      picker.style.left = Math.max(12, Math.min(r.left, document.documentElement.clientWidth - w - 12)) + 'px';
      picker.style.top = Math.min(r.bottom + 8, window.innerHeight - 160) + 'px';
      picker.style.maxHeight = Math.max(240, window.innerHeight - r.bottom - 24) + 'px';
    }
    function openPicker(from) {
      if (!picker) return;
      opener = from || $('.acc-editor:not([hidden]) [data-acc-open]', accCard);
      if (!opener) return;
      picker.hidden = false;
      opener.setAttribute('aria-expanded', 'true');
      search.value = '';
      applyFilter();
      place();
      search.focus({ preventScroll: true });
    }
    function closePicker(focusBack) {
      if (!picker || picker.hidden) return;
      picker.hidden = true;
      if (opener) {
        opener.setAttribute('aria-expanded', 'false');
        if (focusBack) opener.focus({ preventScroll: true });
      }
    }
    if (picker) {
      // Out of the card, so it can float over the page.
      document.body.appendChild(picker);
      window.addEventListener('scroll', place, { passive: true });
      window.addEventListener('resize', place);
      document.addEventListener('mousedown', function (e) {
        if (!picker.hidden && !picker.contains(e.target) && !(opener && opener.contains(e.target))) closePicker(false);
      });
      search.addEventListener('input', applyFilter);
      search.addEventListener('keydown', function (e) {
        var shown = visibleOpts();
        var i = shown.indexOf(active);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (shown.length) setActive(shown[(i + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length]);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (active) { closePicker(false); pick(active.getAttribute('data-mod-pick')); }
        }
      });
      picker.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); closePicker(true); } });
      picker.addEventListener('click', function (e) {
        var f = e.target.closest('[data-mod-filter]');
        if (f) {
          filter = f.getAttribute('data-mod-filter');
          $$('[data-mod-filter]', picker).forEach(function (x) { x.setAttribute('aria-pressed', x === f ? 'true' : 'false'); });
          applyFilter();
          search.focus({ preventScroll: true });
          return;
        }
        var o = e.target.closest('.acc-opt');
        if (o && !(e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0)) {
          e.preventDefault();
          closePicker(false);
          pick(o.getAttribute('data-mod-pick'));
        }
      });
      picker.addEventListener('mousemove', function (e) {
        var o = e.target.closest('.acc-opt');
        if (o && o !== active) setActive(o);
      });
      // ⌘K / Ctrl+K opens it from anywhere on the page.
      document.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
          e.preventDefault();
          if (picker.hidden) openPicker(null); else closePicker(true);
        }
      });
    }

    accCard.addEventListener('click', function (e) {
      var open = e.target.closest('[data-acc-open]');
      if (open) {
        if (picker && !picker.hidden && opener === open) closePicker(true); else openPicker(open);
        return;
      }
      var step = e.target.closest('[data-mod-step]');
      if (step) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return;
        e.preventDefault();
        pick(step.getAttribute('data-mod-step'));
        return;
      }
      var ex = e.target.closest('[data-acc-expand]');
      if (ex) {
        var sec = ex.closest('.acc-tool');
        expand(sec, !sec.classList.contains('expanded'));
        return;
      }
      var preset = e.target.closest('[data-preset]');
      if (preset) {
        var ed = preset.closest('.acc-editor');
        var level = preset.getAttribute('data-preset');
        apply(ed, ed, function () { return level; });
      }
    });

    accCard.addEventListener('change', function (e) {
      var t = e.target;
      var ed = t.closest('.acc-editor');
      if (!ed) return;
      if (t.hasAttribute('data-tool-switch')) {
        // On: closed pages open as View (the rest keep their level). Off: back to the minimum.
        var sec = t.closest('.acc-tool');
        var on = t.checked;
        apply(ed, sec, function (p) { return on ? (p.value === p.levels[0] ? 'view' : p.value) : 'none'; });
        return;
      }
      if (t.hasAttribute('data-copy-from')) {
        var src = accCard.querySelector('.acc-editor[data-mod="' + t.value + '"]');
        var from = {};
        if (src) pages(src).forEach(function (p) { from[p.name] = p.value; });
        if (src) apply(ed, ed, function (p) { return from[p.name] || 'none'; });
        t.value = '';
        return;
      }
      if (t.type === 'radio' && t.hasAttribute('data-tool')) summarize(ed);
    });
  })();

  // ---- Triage › Actions: modes per source ------------------------------------------------------

  function setRadio(form, name, value) {
    var r = form.querySelector('input[type="radio"][name="' + name + '"][value="' + value + '"]');
    if (!r || r.checked) return;
    r.checked = true;
    r.dispatchEvent(new Event('change', { bubbles: true }));
    r.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // "Copy Discord settings to GitHub": every GitHub mode takes the Discord ticket mode (saved with Save).
  document.addEventListener('click', function (e) {
    var copy = e.target.closest('[data-copy-modes]');
    var all = e.target.closest('[data-set-gh-modes]');
    if (!copy && !all) return;
    var form = (copy || all).closest('form');
    if (!form) return;
    $$('input[type="radio"]', form).forEach(function (r) {
      if (!/_gh_mode$/.test(r.name) || r.value !== 'off') return;
      var base = r.name.replace(/_gh_mode$/, '_mode');
      if (copy) {
        var on = form.querySelector('input[type="radio"][name="' + base + '"]:checked');
        if (on) setRadio(form, r.name, on.value);
      } else {
        setRadio(form, r.name, all.getAttribute('data-set-gh-modes'));
      }
    });
  });
  // The GitHub switch dims (or undims) its column right away.
  $$('form[data-gh-switch] input[type="checkbox"]').forEach(function (box) {
    box.addEventListener('change', function () {
      $$('.src-modes').forEach(function (el) { el.classList.toggle('gh-off', !box.checked); });
      $$('[data-gh-off-note]').forEach(function (el) { el.hidden = box.checked; });
    });
  });

  // A select can set its form's confirmation (Re-run: what applying the results does).
  $$('select[data-confirm-options]').forEach(function (sel) {
    function sync() {
      var form = sel.form;
      var option = sel.options[sel.selectedIndex];
      if (!form || !option) return;
      ['title', 'body', 'label'].forEach(function (k) {
        var v = option.getAttribute('data-confirm-' + k);
        if (v !== null) form.setAttribute('data-confirm-' + k, v);
      });
    }
    sel.addEventListener('change', sync);
    sync();
  });

  // ---- Re-run estimate (Triage › Re-run): how many tickets, cost and time, as the form changes ----

  $$('form[data-estimate]').forEach(function (form) {
    var src = form.getAttribute('data-estimate');
    var text = form.querySelector('[data-estimate-text]');
    var warn = form.querySelector('[data-estimate-warn]');
    var limit = form.querySelector('input[name="limit"]');
    var newest = form.querySelector('input[name="count"][value="newest"]');
    var timer = null;
    var seq = 0;
    function update() {
      var p = new URLSearchParams();
      new FormData(form).forEach(function (v, k) { if (k !== '_csrf' && k !== 'name') p.append(k, v); });
      var mine = ++seq;
      fetch(src + '?' + p.toString(), { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (res) { return res.ok && (res.headers.get('content-type') || '').indexOf('json') >= 0 ? res.json() : null; })
        .then(function (d) {
          if (!d || mine !== seq) return;
          if (text) text.textContent = d.text;
          if (warn) { warn.textContent = d.warn || ''; warn.hidden = !d.warn; }
          $$('[data-count-all]', form).forEach(function (el) { el.textContent = d.allLabel; });
          $$('[data-count-untouched]', form).forEach(function (el) { el.textContent = d.untouched; });
          $$('[data-count-never]', form).forEach(function (el) { el.textContent = d.never; });
        })
        .catch(function () {});
    }
    form.addEventListener('change', update);
    if (limit) {
      // Typing a number means "only the newest".
      limit.addEventListener('focus', function () { if (newest && !newest.checked) { newest.checked = true; update(); } });
      limit.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(update, 300); });
    }
  });

  // ---- Live sections (Server health, triage re-runs) ------------------------------------------

  $$('[data-live]').forEach(function (box) {
    var ms = Number(box.getAttribute('data-live')) || 15000;
    var src = box.getAttribute('data-live-src');
    var status = document.querySelector('[data-live-status]');
    var text = status && status.querySelector('.t');
    var last = Date.now();
    var failed = false;
    var busy = false;
    function label() {
      if (!text) return;
      var s = Math.round((Date.now() - last) / 1000);
      text.textContent = failed ? 'Reconnecting…' : s < 5 ? 'Live · updated just now' : 'Live · updated ' + s + ' s ago';
      status.classList.toggle('off', failed);
    }
    function refresh() {
      if (document.hidden || busy || !src) return;
      busy = true;
      fetch(src, { credentials: 'same-origin', headers: { accept: 'text/html' } })
        .then(function (res) {
          // A signed-out session redirects to the sign-in page: never paste that in.
          if (!res.ok || (res.headers.get('x-health-partial') !== '1' && res.headers.get('x-live-partial') !== '1')) throw new Error('not live');
          return res.text();
        })
        .then(function (markup) {
          box.innerHTML = markup;
          last = Date.now();
          failed = false;
          // Finished (a re-run): reload once for the full page and its buttons.
          if (box.querySelector('[data-live-reload]')) location.reload();
        })
        .catch(function () { failed = true; })
        .then(function () { busy = false; label(); });
    }
    setInterval(refresh, ms);
    setInterval(label, 1000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - last > ms) refresh(); });
    document.addEventListener('tr:live-refresh', refresh);
  });

  // ---- Alerts that follow you around (AI triage stopped) --------------------------------------
  //
  // The server sends the panel for this person; it shows on every page until the problem is
  // fixed. Minimized, it shrinks to an icon in the corner (until something new comes up, which
  // opens it again); a dismissed alert stays away until it happens again.

  var dockBox = document.getElementById('alert-dock');
  if (dockBox) (function () {
    var src = dockBox.getAttribute('data-dock-src');
    var SKEY = 'tr.dock.' + dockBox.getAttribute('data-dock-ws');
    var DKEY = 'tr.dock.dismissed';
    function read(store, key, fallback) { try { var v = store.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
    function write(store, key, value) { try { store.setItem(key, JSON.stringify(value)); } catch (e) { /* storage off: still works for this page */ } }
    // This tab: the last panel (shown right away on the next page), its alerts and what was minimized.
    var state = read(sessionStorage, SKEY, null) || { html: '', ids: [], resolved: {}, min: [] };
    var markup = null;
    var lastFetch = 0;

    function cards() { return $$('[data-alert-id]', dockBox); }
    function idOf(a) { return a.getAttribute('data-alert-id'); }
    function shown() { return cards().filter(function (a) { return !a.hidden; }); }
    // Toasts stack above the panel instead of under it.
    function setSpace() {
      var dock = $('.dock', dockBox);
      var part = dock && !dockBox.hidden ? (dock.classList.contains('min') ? $('[data-dock-open]', dock) : $('.dock-panel', dock)) : null;
      root.style.setProperty('--dock-space', part ? part.offsetHeight + 12 + 'px' : '0px');
    }
    function setMin(dock, min, animate) {
      dock.classList.toggle('min', min);
      if (animate && !reduceMotion) {
        // Start from the "enter" look, then let the transition play (no animation frame needed,
        // so it also works in a tab that opens in the background).
        dock.classList.add('enter');
        void dock.offsetWidth;
        dock.classList.remove('enter');
      }
      setSpace();
    }
    function show(html, animate) {
      if (html !== markup) { dockBox.innerHTML = html; markup = html; }
      var dismissed = read(localStorage, DKEY, []);
      var visible = cards().filter(function (a) {
        // Left out: dismissed, or the page shows the same thing itself (Triage › Actions).
        var inline = a.getAttribute('data-inline');
        a.hidden = dismissed.indexOf(idOf(a)) !== -1 || Boolean(inline && document.getElementById(inline));
        return !a.hidden;
      });
      var dock = $('.dock', dockBox);
      dockBox.hidden = !dock || !visible.length;
      if (dockBox.hidden) return setSpace();
      dock.classList.toggle('multi', visible.length > 1);
      var count = $('[data-dock-count]', dock);
      if (count) count.textContent = visible.length + ' alerts';
      var n = $('[data-dock-n]', dock);
      if (n) n.textContent = String(visible.length);
      var pill = $('[data-dock-open]', dock);
      var titles = visible.map(function (a) { return a.getAttribute('data-title'); }).join(' · ');
      pill.setAttribute('aria-label', 'Show alerts: ' + titles);
      pill.setAttribute('title', titles);
      var min = visible.every(function (a) { return state.min.indexOf(idOf(a)) !== -1; });
      setMin(dock, min, animate && !min);
    }
    function remember(html) {
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var list = $$('[data-alert-id]', tmp);
      var ids = list.map(idOf);
      var dismissed = read(localStorage, DKEY, []);
      // Fixed since this tab last looked: say so (unless it was dismissed).
      state.ids.forEach(function (id) {
        if (ids.indexOf(id) === -1 && state.resolved[id] && dismissed.indexOf(id) === -1) toast(state.resolved[id]);
      });
      var resolved = {};
      list.forEach(function (a) { if (a.getAttribute('data-resolved')) resolved[idOf(a)] = a.getAttribute('data-resolved'); });
      state = { html: html, ids: ids, resolved: resolved, min: state.min.filter(function (id) { return ids.indexOf(id) !== -1; }) };
      write(sessionStorage, SKEY, state);
    }
    function refresh() {
      if (document.hidden || !src) return;
      lastFetch = Date.now();
      fetch(src, { credentials: 'same-origin', headers: { accept: 'text/html' } })
        .then(function (res) {
          // A signed-out session redirects to the sign-in page: never paste that in.
          if (!res.ok || res.headers.get('x-live-partial') !== '1') throw new Error('not alerts');
          return res.text();
        })
        .then(function (html) {
          var changed = html !== state.html;
          remember(html);
          show(html, changed);
        })
        .catch(function () { /* keep what's shown */ });
    }
    function minimize(dock) {
      state.min = shown().map(idOf);
      write(sessionStorage, SKEY, state);
      setMin(dock, true, false);
      $('[data-dock-open]', dock).focus();
    }

    if (state.html) show(state.html, false);
    refresh();
    setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - lastFetch > 30000) refresh(); });
    window.addEventListener('resize', setSpace);

    dockBox.addEventListener('click', function (e) {
      var dock = $('.dock', dockBox);
      if (!dock) return;
      if (e.target.closest('[data-dock-min]')) return minimize(dock);
      if (e.target.closest('[data-dock-open]')) {
        state.min = [];
        write(sessionStorage, SKEY, state);
        setMin(dock, false, true);
        var first = $('.dock-panel a, .dock-panel button:not([data-dock-min]):not([data-alert-dismiss])', dock);
        if (first) first.focus({ preventScroll: true });
        return;
      }
      var dismiss = e.target.closest('[data-alert-dismiss]');
      if (dismiss) {
        var gone = read(localStorage, DKEY, []);
        gone.push(idOf(dismiss.closest('[data-alert-id]')));
        write(localStorage, DKEY, gone.slice(-50));
        show(markup, false);
        // Keyboard users carry on with the next alert.
        var next = shown()[0];
        var target = next && $('button, a', next);
        if (target) target.focus({ preventScroll: true });
      }
    });
    dockBox.addEventListener('keydown', function (e) {
      var dock = $('.dock', dockBox);
      if (e.key === 'Escape' && dock && !dock.classList.contains('min') && !openMenu) minimize(dock);
    });
    // Try again: asks Claude without leaving the page, then shows what it found.
    dockBox.addEventListener('submit', function (e) {
      var form = e.target.closest('form[data-dock-action]');
      if (!form) return;
      e.preventDefault();
      var button = form.querySelector('button[type="submit"]');
      var label = button && button.querySelector('.lbl');
      var text = label && label.textContent;
      if (button) {
        button.disabled = true;
        button.classList.add('loading');
        if (label && button.dataset.loadingText) label.textContent = button.dataset.loadingText;
      }
      var card = form.closest('[data-alert-id]');
      fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (res.ok && body.ok) {
              // Fixed: this toast says so, not a second one when the alert goes away.
              if (card) state.ids = state.ids.filter(function (id) { return id !== idOf(card); });
              toast(body.message || 'Done');
            } else toast(body.error || (res.status === 403 ? 'You don’t have permission to do this.' : 'That didn’t work. Try again in a minute.'), 'danger');
          });
        })
        .catch(function () { toast('Not sent. Check your connection and try again.', 'danger'); })
        .then(function () {
          if (button) {
            button.disabled = false;
            button.classList.remove('loading');
            if (label) label.textContent = text;
          }
          refresh();
        });
    });
  })();
})();
