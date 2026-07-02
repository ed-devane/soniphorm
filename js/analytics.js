// Microsoft Clarity analytics with consent, scoped to #smart-contact-mic.
// Replace CLARITY_PROJECT_ID with the ID from clarity.microsoft.com.
(function () {
  const CLARITY_PROJECT_ID = 'REPLACE_WITH_CLARITY_PROJECT_ID';
  const CONSENT_KEY = 'soniphorm-analytics-consent';

  function loadClarity() {
    if (!CLARITY_PROJECT_ID || CLARITY_PROJECT_ID.indexOf('REPLACE') === 0) return;
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', CLARITY_PROJECT_ID);
  }

  function track(name, value) {
    if (window.clarity) window.clarity('event', name);
    if (value != null && window.clarity) window.clarity('set', name, String(value));
  }

  function initTracking() {
    const section = document.getElementById('smart-contact-mic');
    if (!section) return;

    const viewObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          if (window.clarity) window.clarity('set', 'viewed_section', 'smart_contact_mic');
          track('scm_section_view');
          viewObs.disconnect();
        }
      });
    }, { threshold: 0.25 });
    viewObs.observe(section);

    const thresholds = [25, 50, 75, 100];
    const fired = {};
    function checkScrollDepth() {
      const rect = section.getBoundingClientRect();
      const secH = section.offsetHeight;
      if (secH <= 0) return;
      const scrolled = Math.max(0, Math.min(secH, window.innerHeight - rect.top));
      const pct = (scrolled / secH) * 100;
      thresholds.forEach(function (t) {
        if (!fired[t] && pct >= t) {
          fired[t] = true;
          track('scm_scroll_' + t);
        }
      });
    }
    window.addEventListener('scroll', checkScrollDepth, { passive: true });
    checkScrollDepth();

    const entered = section.dataset.enteredAt = String(Date.now());
    let dwellSent = false;
    window.addEventListener('beforeunload', function () {
      if (dwellSent) return;
      dwellSent = true;
      const ms = Date.now() - parseInt(entered, 10);
      const bucket = ms < 5000 ? 'lt5s' : ms < 15000 ? 'lt15s' : ms < 60000 ? 'lt60s' : 'gte60s';
      if (window.clarity) window.clarity('set', 'scm_dwell', bucket);
    });

    const cta = section.querySelector('a[href*="buy.stripe.com"]');
    if (cta) {
      cta.addEventListener('click', function () { track('scm_cta_click'); });
    }

    const dots = section.querySelector('.slideshow-dots');
    if (dots) {
      let slideClicked = false;
      dots.addEventListener('click', function () {
        if (!slideClicked) { slideClicked = true; track('scm_slideshow_nav'); }
      });
    }

    const specsGrid = section.querySelector('.product-details-grid');
    if (specsGrid) {
      const specObs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { track('scm_specs_view'); specObs.disconnect(); }
        });
      }, { threshold: 0.5 });
      specObs.observe(specsGrid);
    }
  }

  function showBanner() {
    const banner = document.createElement('div');
    banner.className = 'consent-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Analytics consent');
    banner.innerHTML =
      '<p class="consent-text">We use Microsoft Clarity to understand how visitors use this page. It collects anonymous interaction data via cookies. Accept to help us improve, or decline to browse without tracking.</p>' +
      '<div class="consent-actions">' +
        '<button type="button" class="consent-btn consent-decline">Decline</button>' +
        '<button type="button" class="consent-btn consent-accept">Accept</button>' +
      '</div>';
    document.body.appendChild(banner);

    banner.querySelector('.consent-accept').addEventListener('click', function () {
      localStorage.setItem(CONSENT_KEY, 'accepted');
      banner.remove();
      loadClarity();
      initTracking();
    });
    banner.querySelector('.consent-decline').addEventListener('click', function () {
      localStorage.setItem(CONSENT_KEY, 'declined');
      banner.remove();
    });
  }

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  const consent = localStorage.getItem(CONSENT_KEY);
  if (consent === 'accepted') {
    loadClarity();
    onReady(initTracking);
  } else if (consent === null) {
    onReady(showBanner);
  }
})();
