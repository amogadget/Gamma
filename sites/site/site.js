// gammapdf.com — the little behaviour the page needs. No dependencies.
//  - the mobile menu button
//  - "Download for <this OS>" on the primary buttons
//  - copy buttons on code blocks
//  - the latest release: version, per-OS asset links, star count (one call
//    to api.github.com; every element keeps a working fallback link)
(() => {
  const REPO = 'tim4431/Gamma';
  const STORE = 'https://apps.microsoft.com/detail/9N8WGWR2J2MV';

  // Menu
  const menu = document.querySelector('.top__menu');
  const nav = document.getElementById('nav');
  menu?.addEventListener('click', () => {
    const open = nav.classList.toggle('nav--open');
    menu.setAttribute('aria-expanded', String(open));
  });
  nav?.addEventListener('click', e => {
    if (e.target.closest('a')) { nav.classList.remove('nav--open'); menu?.setAttribute('aria-expanded', 'false'); }
  });

  // OS detection — the "platform" hints first, the user agent as a fallback.
  const ua = navigator.userAgent;
  const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  const os = /win/.test(platform) || /Windows/.test(ua) ? 'windows'
    : /mac/.test(platform) || /Mac OS X/.test(ua) ? 'macos'
    : /linux/.test(platform) || /Linux/.test(ua) ? 'linux'
    : null;
  const label = { windows: 'Download for Windows', macos: 'Download for macOS', linux: 'Download for Linux' };
  if (os) {
    document.querySelectorAll('[data-download-label]').forEach(el => { el.textContent = label[os]; });
    if (os === 'windows') document.querySelectorAll('[data-download]').forEach(a => { a.href = STORE; });
    document.querySelector(`.dl__card[data-os="${os}"]`)?.classList.add('dl__card--mine');
  }

  // The Store badge is the one external image; fall back to a plain button
  // when it can't load (offline, blocked).
  const badge = document.querySelector('[data-store-badge]');
  const badgeFailed = () => badge.closest('.dl__card')?.classList.add('store--failed');
  if (badge) {
    badge.addEventListener('error', badgeFailed);
    if (badge.complete && badge.naturalWidth === 0) badgeFailed();
  }

  // Copy buttons
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = btn.parentElement.querySelector('code')?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Select and copy';
      }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    });
  });

  // Latest release + stars. Silent on any failure (rate limit, offline).
  const fmt = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
  const assetFor = (release, test) => release?.assets?.find(a => test(a.name))?.browser_download_url;
  fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: { Accept: 'application/vnd.github+json' } })
    .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(releases => {
      const published = releases.filter(r => !r.draft && !r.prerelease);
      const desktop = published.find(r => /^v\d/.test(r.tag_name));
      const extension = published.find(r => /^extension-v\d/.test(r.tag_name));
      if (desktop) {
        document.querySelectorAll('[data-version]').forEach(el => { el.textContent = desktop.tag_name; });
        document.querySelectorAll('[data-version-link]').forEach(a => { a.href = desktop.html_url; });
        const links = {
          exe: assetFor(desktop, n => /\.exe$/i.test(n)),
          dmg: assetFor(desktop, n => /\.dmg$/i.test(n) && !/arm64/i.test(n)) || assetFor(desktop, n => /\.dmg$/i.test(n)),
          deb: assetFor(desktop, n => /\.deb$/i.test(n)),
        };
        for (const [kind, url] of Object.entries(links)) {
          if (url) document.querySelectorAll(`[data-asset="${kind}"]`).forEach(a => { a.href = url; });
        }
        const mine = { macos: links.dmg, linux: links.deb }[os];
        if (mine) document.querySelectorAll('[data-download]').forEach(a => { a.href = mine; });
      }
      const zip = assetFor(extension, n => /\.zip$/i.test(n));
      if (zip) document.querySelectorAll('[data-asset="extension"]').forEach(a => { a.href = zip; });
    })
    .catch(() => {});
  fetch(`https://api.github.com/repos/${REPO}`, { headers: { Accept: 'application/vnd.github+json' } })
    .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(repo => {
      const n = repo.stargazers_count;
      if (!Number.isFinite(n) || n < 50) return;
      document.querySelectorAll('[data-stars]').forEach(el => { el.textContent = fmt(n); el.hidden = false; });
    })
    .catch(() => {});
})();
