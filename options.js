(function () {
  'use strict';

  var DEFAULTS = {
    defaultView: 'notebook',
    contextLines: 3,
    collapseUnchanged: true,
    syntaxHighlight: true,
    collapseLongCode: true,
  };

  var FIELDS = {
    defaultView: 'select',
    contextLines: 'number',
    collapseUnchanged: 'checkbox',
    syntaxHighlight: 'checkbox',
    collapseLongCode: 'checkbox',
  };

  function loadSettings() {
    chrome.storage.sync.get(DEFAULTS, function (items) {
      Object.keys(FIELDS).forEach(function (key) {
        var el = document.getElementById(key);
        if (!el) return;
        if (FIELDS[key] === 'checkbox') {
          el.checked = items[key];
        } else {
          el.value = items[key];
        }
      });
    });
  }

  function saveSettings() {
    var settings = {};
    Object.keys(FIELDS).forEach(function (key) {
      var el = document.getElementById(key);
      if (!el) return;
      if (FIELDS[key] === 'checkbox') {
        settings[key] = el.checked;
      } else if (FIELDS[key] === 'number') {
        settings[key] = parseInt(el.value, 10) || DEFAULTS[key];
      } else {
        settings[key] = el.value;
      }
    });

    chrome.storage.sync.set(settings, function () {
      var status = document.getElementById('saveStatus');
      status.classList.add('visible');
      setTimeout(function () {
        status.classList.remove('visible');
      }, 1500);
    });
  }

  // Load on page open
  document.addEventListener('DOMContentLoaded', loadSettings);

  // Auto-save on any change
  Object.keys(FIELDS).forEach(function (key) {
    var el = document.getElementById(key);
    if (!el) return;
    el.addEventListener('change', saveSettings);
    if (FIELDS[key] === 'number') {
      el.addEventListener('input', saveSettings);
    }
  });
})();
