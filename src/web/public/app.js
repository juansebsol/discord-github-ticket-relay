// Progressive enhancement for the admin UI. Every page works without this script.
(function () {
  // Confirmation prompts for destructive or outward-facing actions.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) {
      event.preventDefault();
      return;
    }
    // Loading state: disable the submit button so actions aren't sent twice.
    var button = event.submitter || form.querySelector('button[type="submit"], button:not([type])');
    if (button) {
      setTimeout(function () {
        button.disabled = true;
        button.classList.add('loading');
        if (button.dataset.loadingText) button.lastChild.textContent = ' ' + button.dataset.loadingText;
      }, 0);
    }
  });

  // Copy buttons.
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy]');
    if (!button) return;
    var input = document.getElementById(button.getAttribute('data-copy'));
    if (!input) return;
    input.select();
    navigator.clipboard.writeText(input.value).then(function () {
      var original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = original; }, 1500);
    });
  });

  // Workspace switcher.
  var switcher = document.getElementById('workspace-switch');
  if (switcher) {
    switcher.addEventListener('change', function () {
      if (switcher.value) window.location.href = switcher.value;
    });
  }

  // App form: load the chosen repository's labels.
  var repoSelect = document.getElementById('repo');
  var labelBox = document.getElementById('label-list');
  if (repoSelect && labelBox) {
    var endpoint = labelBox.getAttribute('data-endpoint');
    var selected = new Set(JSON.parse(labelBox.getAttribute('data-selected') || '[]'));
    var visibility = document.getElementById('repo-visibility');

    function render(message, labels) {
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
        label.className = 'checkbox';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'labels';
        input.value = name;
        input.checked = selected.has(name);
        input.addEventListener('change', function () {
          if (input.checked) selected.add(name); else selected.delete(name);
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(name));
        labelBox.appendChild(label);
      });
    }

    function load() {
      var option = repoSelect.options[repoSelect.selectedIndex];
      if (visibility) {
        var priv = option && option.getAttribute('data-private');
        visibility.textContent = !option || !option.value ? '' : priv === 'true'
          ? 'Private repository: only people with access can see tickets. Members will be told this.'
          : 'Public repository: anyone can read tickets filed here. Members will be told this before they submit.';
      }
      if (!repoSelect.value) return render('Choose a repository to see its labels.');
      render('Loading labels…');
      fetch(endpoint + '?repo=' + encodeURIComponent(repoSelect.value), { credentials: 'same-origin' })
        .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
        .then(function (result) {
          if (!result.ok) return render(result.body.error || 'Could not load labels.');
          if (!result.body.labels.length) return render('This repository has no labels.');
          render(null, result.body.labels);
        })
        .catch(function () { render('Could not load labels. You can save without labels and add them later.'); });
    }

    repoSelect.addEventListener('change', function () { selected.clear(); load(); });
    load();
  }
})();
