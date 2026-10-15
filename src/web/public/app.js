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
    if (form.hasAttribute('data-confirm-title') && !form.hasAttribute('data-confirmed') && confirmDialog && confirmDialog.showModal) {
      e.preventDefault();
      closeMenu(false);
      pending = { form: form, submitter: e.submitter };
      $('#confirm-title', confirmDialog).textContent = form.getAttribute('data-confirm-title');
      $('#confirm-body', confirmDialog).textContent = form.getAttribute('data-confirm-body') || '';
      var ok = $('#confirm-ok', confirmDialog);
      ok.textContent = form.getAttribute('data-confirm-label') || 'Confirm';
      ok.className = 'btn ' + (form.hasAttribute('data-confirm-danger') ? 'danger-solid' : 'primary');
      if (form.hasAttribute('data-confirm-danger')) confirmDialog.setAttribute('data-destructive', ''); else confirmDialog.removeAttribute('data-destructive');
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
      input.disabled = true;
      fetch(form.action, { method: 'POST', body: data, credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (!res.ok || !body.ok) throw { shown: body.error || (res.status === 403 ? 'You don’t have permission to change this.' : 'Not saved. Reload the page and try again.') };
            toast(body.message || 'Saved');
          });
        })
        .catch(function (err) {
          if (input.type === 'checkbox') input.checked = prev;
          toast(err && err.shown ? err.shown : 'Not saved. Check your connection and try again.', 'danger');
        })
        .then(function () { input.disabled = false; input.focus({ preventScroll: true }); });
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
    row.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
    var first = row.querySelector('input:not([type=hidden])');
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
  function updateSelection(formId) {
    var boxes = selection(formId);
    var n = boxes.filter(function (b) { return b.checked; }).length;
    $$('[data-select-all="' + formId + '"]').forEach(function (all) {
      all.checked = n > 0 && n === boxes.length;
      all.indeterminate = n > 0 && n < boxes.length;
    });
    $$('[data-selected-text="' + formId + '"]').forEach(function (t) {
      t.textContent = n ? n + (n === 1 ? ' ticket selected' : ' tickets selected') : t.getAttribute('data-empty-text') || 'Select tickets to delete their files.';
    });
    $$('[data-needs-selection="' + formId + '"]').forEach(function (b) { b.disabled = n === 0; });
  }
  $$('[data-select-all]').forEach(function (all) {
    var formId = all.getAttribute('data-select-all');
    all.addEventListener('change', function () {
      selection(formId).forEach(function (b) { b.checked = all.checked; });
      updateSelection(formId);
    });
    selection(formId).forEach(function (b) { b.addEventListener('change', function () { updateSelection(formId); }); });
    updateSelection(formId);
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
  });
})();
