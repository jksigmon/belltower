(function () {
  function init() {
    const btn = document.getElementById('hamburgerBtn');
    const overlay = document.getElementById('navOverlay');
    if (!btn || !overlay) return;

    btn.addEventListener('click', function () {
      document.body.classList.toggle('nav-open');
    });

    overlay.addEventListener('click', function () {
      document.body.classList.remove('nav-open');
    });

    // Close drawer when any nav link is clicked
    document.querySelectorAll('.wrap nav a, #adminNav a').forEach(function (link) {
      link.addEventListener('click', function () {
        document.body.classList.remove('nav-open');
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
